import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { config } from "./config.ts";
import type { ToolCallTrace } from "../shared/api.ts";

// One place for every OpenAI call: Structured Outputs for reading, tool calling for the agents,
// image and PDF input for scans. Returns token counts and cost so every call can be logged.

export const llmAvailable = () => Boolean(config.openai.apiKey);

let client: OpenAI | null = null;
// OPENAI_BASE_URL (read by the SDK itself), OPENAI_TIMEOUT_MS and OPENAI_MAX_RETRIES let the same code talk to a stand-in endpoint.
const openai = () => (client ??= new OpenAI({ apiKey: config.openai.apiKey, maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 4), timeout: Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000) }));

export interface Usage { model: string; tokens_in: number; tokens_out: number; cost_usd: number }

function usageOf(model: string, u: { input_tokens?: number; output_tokens?: number } | null | undefined): Usage {
  const tin = u?.input_tokens ?? 0, tout = u?.output_tokens ?? 0;
  const p = config.openai.prices[model] ?? Object.entries(config.openai.prices).find(([k]) => model.startsWith(k))?.[1];
  return { model, tokens_in: tin, tokens_out: tout, cost_usd: p ? (tin * p.input + tout * p.output) / 1_000_000 : 0 };
}
export const addUsage = (a: Usage, b: Usage): Usage => ({ model: a.model, tokens_in: a.tokens_in + b.tokens_in, tokens_out: a.tokens_out + b.tokens_out, cost_usd: a.cost_usd + b.cost_usd });

// Limit parallel calls across the whole process.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.openai.concurrency) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const promptCache = new Map<string, string>();
/** Load a prompt file from prompts/. */
export function prompt(name: string): string {
  if (!promptCache.has(name)) promptCache.set(name, fs.readFileSync(path.join(config.promptsDir, name), "utf8").trim());
  return promptCache.get(name)!;
}
/** Every call that writes text for people gets the writing style appended to its system prompt. */
export const withStyle = (system: string) => `${system}\n\n${prompt("writing_style.md")}`;

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; bytes: Uint8Array }
  | { type: "pdf"; filename: string; bytes: Uint8Array };

function toContent(parts: Part[]) {
  return parts.map((p) => {
    if (p.type === "text") return { type: "input_text" as const, text: p.text };
    const b64 = Buffer.from(p.bytes).toString("base64");
    if (p.type === "image") return { type: "input_image" as const, image_url: `data:${p.mime};base64,${b64}`, detail: "high" as const };
    return { type: "input_file" as const, filename: p.filename, file_data: `data:application/pdf;base64,${b64}` };
  });
}

export interface StructuredArgs {
  model: string;
  system: string;
  user: string | Part[];
  schemaName: string;          // letters, digits, underscores
  schema: Record<string, unknown>; // JSON Schema. Strict mode: every property required, additionalProperties false.
}

/** One call that must answer in the given JSON schema. */
export async function structured<T>(a: StructuredArgs): Promise<{ data: T; usage: Usage }> {
  if (!llmAvailable()) throw new Error("OPENAI_API_KEY is not set.");
  const parts: Part[] = typeof a.user === "string" ? [{ type: "text", text: a.user }] : a.user;
  const resp = await slot(() => openai().responses.create({
    model: a.model,
    instructions: a.system,
    input: [{ role: "user", content: toContent(parts) }],
    text: { format: { type: "json_schema", name: a.schemaName, schema: a.schema, strict: true } },
  }));
  const text = resp.output_text;
  if (!text) throw new Error(`Model returned no output (status ${resp.status}).`);
  return { data: JSON.parse(text) as T, usage: usageOf(a.model, resp.usage) };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema of the arguments (strict: all properties required, additionalProperties false)
  run: (args: any) => unknown | Promise<unknown>;
}

export interface AgentArgs {
  model: string;
  system: string;
  user: string;
  tools: Tool[];
  maxSteps?: number;
  onToolCall?: (t: ToolCallTrace) => void;
}

/**
 * Tool-calling loop. The model decides which tools to call, code runs them, the results go back,
 * until the model answers without a tool call. Every call is returned in the trace.
 */
export async function runAgent(a: AgentArgs): Promise<{ text: string; trace: ToolCallTrace[]; usage: Usage; steps: number }> {
  if (!llmAvailable()) throw new Error("OPENAI_API_KEY is not set.");
  const tools = a.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  const byName = new Map(a.tools.map((t) => [t.name, t]));
  const trace: ToolCallTrace[] = [];
  let usage: Usage = { model: a.model, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let input: any = [{ role: "user", content: a.user }];
  let previous: string | undefined;
  const max = a.maxSteps ?? 24;

  for (let step = 1; step <= max; step++) {
    const resp = await slot(() => openai().responses.create({
      model: a.model, instructions: a.system, input, tools, previous_response_id: previous,
      // On the last step the model has to wrap up with what it has.
      tool_choice: step === max ? "none" : "auto",
    }));
    usage = addUsage(usage, usageOf(a.model, resp.usage));
    previous = resp.id;
    const calls = resp.output.filter((o) => o.type === "function_call");
    if (!calls.length) return { text: resp.output_text ?? "", trace, usage, steps: step };
    const outputs: { type: "function_call_output"; call_id: string; output: string }[] = [];
    for (const call of calls) {
      let args: unknown = {}, result: unknown;
      try {
        args = JSON.parse(call.arguments || "{}");
        const tool = byName.get(call.name);
        result = tool ? await tool.run(args) : { error: `unknown tool ${call.name}` };
      } catch (e) {
        result = { error: (e as Error).message };
      }
      const t: ToolCallTrace = { id: call.call_id, name: call.name, args, result };
      trace.push(t);
      a.onToolCall?.(t);
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result ?? null).slice(0, 60_000) });
    }
    input = outputs;
  }
  return { text: "", trace, usage, steps: max };
}

/** Helper for strict JSON schemas: an object where every property is required. */
export const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const arr = (items: unknown) => ({ type: "array", items });
export const str = (description?: string) => (description ? { type: "string", description } : { type: "string" });
export const numT = (description?: string) => (description ? { type: "number", description } : { type: "number" });
// Strict mode only lets the model answer null when null is also one of the enum values.
export const nullable = (t: { type: string; description?: string; enum?: unknown[] }) => ({ ...t, type: [t.type, "null"], ...(t.enum ? { enum: [...t.enum.filter((v) => v !== null), null] } : {}) });
export const enumT = (values: string[], description?: string) => (description ? { type: "string", enum: values, description } : { type: "string", enum: values });
