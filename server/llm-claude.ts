import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "./config.ts";
import type { ToolCallTrace } from "../shared/api.ts";
import type { AgentArgs, Part, Tool, Usage } from "./llm.ts";

// The agent loop on Claude Code (LLM_PROVIDER=claude-code). Instead of the app calling the model step by step, one
// `claude -p` session in the claude container does the whole run and calls the run's tools natively over MCP.
//
// The app serves those tools on an internal port (CLAUDE_CODE_MCP_PORT, not published by compose). Every run gets its
// own random address, so runs that go on in parallel each see only their own tools. The session starts with the same
// system prompt and the same first message the agent would send to the OpenAI API: the task, the source to read or
// the risk to work on, and what changed. Whatever Claude records goes through the same tool code as with the API.

interface Run {
  tools: Map<string, Tool>;
  trace: ToolCallTrace[];
  onToolCall?: (t: ToolCallTrace) => void;
  stopWhen?: (trace: ToolCallTrace[]) => boolean;
  stopped: boolean;
  stop: () => void;
}

const runs = new Map<string, Run>();
let server: http.Server | null = null;

function ensureServer(): void {
  if (server) return;
  server = http.createServer((req, res) => {
    const m = /^\/mcp\/([a-f0-9-]{36})\/?$/.exec(req.url ?? "");
    const run = m ? runs.get(m[1]) : undefined;
    if (!run) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown run"}'); return; }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    // No server-sent stream: every request gets its answer as plain JSON.
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      const batch = Array.isArray(body) ? body : [body];
      const answers = (await Promise.all(batch.map((msg) => answer(run, msg as Rpc)))).filter((a) => a !== null);
      if (!answers.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
    });
  });
  server.listen(config.claudeCode.mcpPort, "0.0.0.0");
}

interface Rpc { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any }

async function answer(run: Run, msg: Rpc): Promise<object | null> {
  if (msg.id === undefined || msg.id === null) return null; // a notification
  const ok = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "soony", version: "1.0.0" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [...run.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = msg.params?.arguments ?? {};
      if (run.stopped) return ok({ content: [{ type: "text", text: "This run is finished. Do not call more tools." }], isError: true });
      const tool = run.tools.get(name);
      let result: unknown, isError = false;
      try { result = tool ? await tool.run(args) : { error: `unknown tool ${name}` }; isError = !tool; }
      catch (e) { result = { error: (e as Error).message }; isError = true; }
      const t: ToolCallTrace = { id: `mcp_${crypto.randomUUID().slice(0, 8)}`, name, args, result };
      run.trace.push(t);
      run.onToolCall?.(t);
      // Like stopWhen with the API: once the run has what it needs, the session ends without another model turn.
      if (run.stopWhen?.(run.trace)) { run.stopped = true; setTimeout(run.stop, 300); }
      return ok({ content: [{ type: "text", text: JSON.stringify(result ?? null).slice(0, 60_000) }], isError });
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method ${msg.method} is not supported` } };
  }
}

const safeName = (name: string) => name.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";

/**
 * The first message as text. A source file is not pasted in: it goes into the folder the claude container shares
 * (read-only), and the message names it, so Claude opens it with its Read tool like any file.
 */
function firstMessage(user: string | Part[], token: string): { prompt: string; files: string[] } {
  if (typeof user === "string") return { prompt: user, files: [] };
  const texts: string[] = [];
  const files: string[] = [];
  const dir = path.join(config.claudeCode.filesDir, token);
  user.forEach((p, i) => {
    if (p.type === "text") { texts.push(p.text); return; }
    let name = p.type === "file" ? p.filename : p.type === "pdf" ? p.filename : `attachment-${i + 1}.${p.mime.split("/")[1] ?? "bin"}`;
    // The Read tool tells scans from text by the file ending.
    if (p.type === "file" && p.mime.startsWith("image/") && !/\.(png|jpe?g|gif|webp)$/i.test(name)) name += `.${p.mime.split("/")[1]}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName(name)), p.bytes);
    files.push(`${config.claudeCode.filesPath.replace(/\/$/, "")}/${token}/${safeName(name)}`);
  });
  if (files.length) texts.push(`Open ${files.length === 1 ? "this file" : "these files"} with the Read tool:\n${files.map((f) => `- ${f}`).join("\n")}`);
  return { prompt: texts.join("\n\n"), files };
}

/** How the session should work, added after the agent's own instructions. */
const HOW = `\n\n# How you work here\nYou work through the tools of the "soony" MCP server, and you open files named in the first message with the Read tool. Call them as your instructions say, one or several at a time, and look at each result before you go on. When you are done, end with your final answer as plain text.`;

/** One agent run as one Claude Code session. Returns the same shape as the OpenAI loop in llm.ts. */
export async function runAgentClaude(a: AgentArgs, loggedModel: string): Promise<{ text: string; trace: ToolCallTrace[]; usage: Usage; steps: number }> {
  ensureServer();
  const token = crypto.randomUUID();
  const abort = new AbortController();
  const run: Run = { tools: new Map(a.tools.map((t) => [t.name, t])), trace: [], onToolCall: a.onToolCall, stopWhen: a.stopWhen, stopped: false, stop: () => abort.abort() };
  runs.set(token, run);
  const { prompt, files } = firstMessage(a.user, token);
  try {
    const res = await fetch(`${config.claudeCode.url.replace(/\/$/, "")}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.claudeCode.timeoutMs)]),
      body: JSON.stringify({
        model: config.claudeCode.model || null,
        system: a.system + HOW,
        prompt,
        read_files: files.length > 0,
        mcp_url: `${config.claudeCode.mcpUrl.replace(/\/$/, "")}/${token}`,
        max_turns: a.maxSteps ?? 24,
      }),
    });
    const out = JSON.parse((await res.text()).trim()) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number }; num_turns?: number; is_error?: boolean; subtype?: string; error?: string };
    if (out.error) throw new Error(`Claude Code: ${out.error}`);
    // Running out of turns ends the run with what it has, as with the API's last step.
    if (out.is_error && out.subtype !== "error_max_turns") throw new Error(`Claude Code ended with ${out.subtype ?? "an error"}: ${String(out.text ?? "").slice(0, 300)}`);
    return {
      text: out.is_error ? "" : (out.text ?? ""),
      trace: run.trace,
      usage: { model: loggedModel, tokens_in: out.usage?.input_tokens ?? 0, tokens_out: out.usage?.output_tokens ?? 0, cost_usd: 0 },
      steps: out.num_turns ?? run.trace.length,
    };
  } catch (e) {
    // The app ended the session itself because the run had what it needed (stopWhen).
    if (run.stopped) return { text: "", trace: run.trace, usage: { model: loggedModel, tokens_in: 0, tokens_out: 0, cost_usd: 0 }, steps: run.trace.length };
    throw e;
  } finally {
    runs.delete(token);
    fs.rmSync(path.join(config.claudeCode.filesDir, token), { recursive: true, force: true });
  }
}
