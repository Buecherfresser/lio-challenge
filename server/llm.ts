import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { config } from "./config.ts";
import { totalSpendUsd } from "./events.ts";
import type { ToolCallTrace } from "../shared/api.ts";

// One place for every model call: Structured Outputs for reading, tool calling for the agents,
// image and PDF input for scans. Returns token counts and cost so every call can be logged.
// LLM_PROVIDER picks who answers: the OpenAI API, or Claude Code through claude-bridge/ (same API, no OpenAI credit).

const claudeCode = () => config.llmProvider === "claude-code";
export const llmAvailable = () => claudeCode() || Boolean(config.openai.apiKey);

let client: OpenAI | null = null;
// OPENAI_BASE_URL (read by the SDK itself), OPENAI_TIMEOUT_MS and OPENAI_MAX_RETRIES let the same code talk to a stand-in endpoint.
const openai = () => (client ??= claudeCode()
  ? new OpenAI({ apiKey: "claude-code", baseURL: config.claudeCode.url, maxRetries: 1, timeout: config.claudeCode.timeoutMs })
  : new OpenAI({ apiKey: config.openai.apiKey, maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 4), timeout: Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000) }));

/** With Claude Code every call goes to the one model set for it, whatever model the caller asked for. */
const modelFor = (requested: string) => (claudeCode() ? config.claudeCode.model || requested : requested);
/** The name a call is logged under. Claude Code runs on the account, so it costs no OpenAI credit. */
const loggedModel = (requested: string) => (claudeCode() ? `claude-code:${config.claudeCode.model || "default"}` : requested);

/** The bridge reports a failed run as a failed response. The OpenAI SDK does not throw for it, so we do. */
function failed(resp: { status?: string | null; error?: { message?: string } | null }): void {
  if (resp.status === "failed") throw new Error(`The model call failed: ${resp.error?.message ?? "no reason given"}`);
}

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
  if (!claudeCode() && config.openai.budgetUsd > 0 && totalSpendUsd() >= config.openai.budgetUsd) {
    throw new Error(`The OpenAI budget of ${config.openai.budgetUsd} USD is used up (OPENAI_BUDGET_USD). No more model calls.`);
  }
  if (active >= config.openai.concurrency) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

const promptCache = new Map<string, string>();
const read = (file: string) => fs.readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim(); // a skill file starts with front matter
/** Load a prompt file from prompts/. */
export function prompt(name: string): string {
  if (!promptCache.has(name)) promptCache.set(name, read(path.join(config.promptsDir, name)));
  return promptCache.get(name)!;
}
/** The writing style is the project's writing-style skill, so people and agents follow the same file. */
const WRITING_STYLE = path.join(config.promptsDir, "..", ".claude", "skills", "writing-style", "SKILL.md");

/**
 * The full system prompt of an agent that writes for people: its own task, then what we know about the customer
 * (prompts/customer.md), then the writing style. The task prompts stay free of anything customer specific.
 */
export function withStyle(system: string): string {
  if (!promptCache.has("@style")) promptCache.set("@style", read(WRITING_STYLE));
  return `${system}\n\n# The customer\n\n${prompt("customer.md").replace(/^#[^\n]*\n+/, "")}\n\n${promptCache.get("@style")}`;
}

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
    model: modelFor(a.model),
    instructions: a.system,
    input: [{ role: "user", content: toContent(parts) }],
    text: { format: { type: "json_schema", name: a.schemaName, schema: a.schema, strict: true } },
  }));
  failed(resp);
  const text = resp.output_text;
  if (!text) throw new Error(`Model returned no output (status ${resp.status}).`);
  return { data: JSON.parse(text) as T, usage: usageOf(loggedModel(a.model), resp.usage) };
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
  user: string | Part[];
  tools: Tool[];
  maxSteps?: number;
  onToolCall?: (t: ToolCallTrace) => void;
  /** Checked after each round of tool calls. True ends the conversation without another model turn. */
  stopWhen?: (trace: ToolCallTrace[]) => boolean;
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
  let usage: Usage = { model: loggedModel(a.model), tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let input: any = [{ role: "user", content: typeof a.user === "string" ? a.user : toContent(a.user) }];
  let previous: string | undefined;
  const max = a.maxSteps ?? 24;

  for (let step = 1; step <= max; step++) {
    const resp = await slot(() => openai().responses.create({
      model: modelFor(a.model), instructions: a.system, input, tools, previous_response_id: previous,
      // On the last step the model has to wrap up with what it has.
      tool_choice: step === max ? "none" : "auto",
    }));
    failed(resp);
    usage = addUsage(usage, usageOf(loggedModel(a.model), resp.usage));
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
    if (a.stopWhen?.(trace)) return { text: "", trace, usage, steps: step };
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
