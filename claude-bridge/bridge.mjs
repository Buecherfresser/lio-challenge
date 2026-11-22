#!/usr/bin/env node
// A stand-in for the OpenAI Responses API that answers every request with `claude -p`, using the Claude account the
// container is logged in with. For testing and development, so the agents do not spend OpenAI credit.
//
// The app talks to it like to OpenAI (LLM_PROVIDER=claude-code, see server/llm.ts). It supports what the app uses:
// instructions, text and file input, Structured Outputs (text.format json_schema), function tools and
// previous_response_id. Claude gets the whole conversation as one prompt and answers with one JSON object, which
// is checked against the schema or the tool's parameters. A wrong answer is sent back to Claude with the reason.
//
// Settings (environment):
//   PORT                 port to listen on (8790)
//   CLAUDE_BIN           the CLI (claude)
//   CLAUDE_ARGS          extra CLI arguments, as a JSON array (default: no built-in tools except Read, no MCP)
//   CLAUDE_CONCURRENCY   how many `claude -p` runs at once (3)
//   CLAUDE_TIMEOUT_MS    how long one run may take (600000)
//   WORK_DIR             where attachments are written for Claude to read (/home/node/work)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT ?? 8790);
const bin = process.env.CLAUDE_BIN ?? "claude";
const extraArgs = process.env.CLAUDE_ARGS ? JSON.parse(process.env.CLAUDE_ARGS) : ["--tools", "Read", "--strict-mcp-config"];
const concurrency = Number(process.env.CLAUDE_CONCURRENCY ?? 3);
const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 600_000);
const work = process.env.WORK_DIR ?? path.join(process.env.HOME ?? "/tmp", "work");
fs.mkdirSync(work, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- strict schema check, the guarantee Structured Outputs gives ----
function check(schema, v, at = "$") {
  if (!schema || typeof schema !== "object") return null;
  if (schema.anyOf) { const errs = schema.anyOf.map((s) => check(s, v, at)); return errs.some((e) => e === null) ? null : `${at}: matches none of anyOf (${errs[0]})`; }
  if (schema.enum && !schema.enum.includes(v)) return `${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(schema.enum)}`;
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x === "number" ? (Number.isInteger(x) ? "integer" : "number") : typeof x);
  if (types) {
    const t = typeOf(v);
    if (!(types.includes(t) || (t === "integer" && types.includes("number")))) return `${at}: expected ${types.join("|")}, got ${t}`;
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v) && schema.properties) {
    for (const k of schema.required ?? []) if (!(k in v)) return `${at}: missing required property "${k}"`;
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in schema.properties)) return `${at}: unknown property "${k}"`;
    for (const [k, s] of Object.entries(schema.properties)) if (k in v) { const e = check(s, v[k], `${at}.${k}`); if (e) return e; }
  }
  if (Array.isArray(v) && schema.items) for (let i = 0; i < v.length; i++) { const e = check(schema.items, v[i], `${at}[${i}]`); if (e) return e; }
  return null;
}

// ---- conversations: previous_response_id -> the turns so far ----
const conversations = new Map(); // response id -> turns
const MAX_CONVERSATIONS = 500;

function saveAttachment(dir, n, dataUrl, filename) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl ?? "");
  if (!m) return null;
  const ext = filename?.split(".").pop() ?? ({ "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf", "image/webp": "webp", "image/gif": "gif" }[m[1]] ?? "bin");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `attachment-${n}.${ext}`);
  fs.writeFileSync(f, Buffer.from(m[2], "base64"));
  return f;
}

function turnsFromInput(dir, input) {
  const turns = [];
  let n = 0;
  for (const item of typeof input === "string" ? [{ role: "user", content: input }] : input ?? []) {
    if (item.type === "function_call_output") {
      const last = turns[turns.length - 1];
      const entry = { call_id: item.call_id, output: item.output };
      if (last?.role === "tool") last.results.push(entry); else turns.push({ role: "tool", results: [entry] });
      continue;
    }
    const parts = typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content ?? [];
    const t = { role: item.role ?? "user", text: "", files: [] };
    for (const p of parts) {
      if (p.type === "input_text") t.text += (t.text ? "\n\n" : "") + p.text;
      else if (p.type === "input_image") { const f = saveAttachment(dir, ++n, p.image_url); if (f) t.files.push(f); }
      else if (p.type === "input_file") { const f = saveAttachment(dir, ++n, p.file_data, p.filename); if (f) t.files.push(f); }
    }
    turns.push(t);
  }
  return turns;
}

function render(turns) {
  return turns.map((t) => {
    if (t.role === "tool") return `## Tool results\n${t.results.map((r) => `call ${r.call_id}:\n${r.output}`).join("\n\n")}`;
    if (t.role === "assistant") return t.tool_calls ? `## You called\n${JSON.stringify(t.tool_calls)}` : `## You answered\n${t.text}`;
    const files = t.files.length ? `\n\nAttached files (read them with the Read tool):\n${t.files.map((f) => `- ${f}`).join("\n")}` : "";
    return `## ${t.role === "system" || t.role === "developer" ? "Instructions" : "User"}\n${t.text}${files}`;
  }).join("\n\n");
}

function buildPrompt(body, turns, schema, tools, toolsAllowed, retryNote) {
  const how = schema
    ? `Answer with exactly one JSON object of the form {"output": <object>} where <object> matches this JSON schema exactly (every property present, no other properties):\n${JSON.stringify(schema)}`
    : toolsAllowed
      ? `Answer with exactly one JSON object. To call tools: {"tool_calls": [{"name": "<tool>", "arguments": {...}}]} with arguments that match the tool's parameters exactly. To finish without calling a tool: {"text": "<your final answer>"}.`
      : `Answer with exactly one JSON object: {"text": "<your answer>"}. Do not call tools.`;
  return [
    "You are the language model behind an application. Follow the instructions below as your system prompt.",
    `# System prompt\n${body.instructions ?? ""}`,
    tools ? `# Tools you can call\n${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))}` : "",
    `# Conversation\n${render(turns)}`,
    `# How to answer\n${how}\nOutput only the JSON object: no code fence, no text before or after it.`,
    retryNote ? `# Your previous answer was refused\n${retryNote}\nAnswer again.` : "",
  ].filter(Boolean).join("\n\n");
}

// ---- running claude -p, a few at a time ----
let active = 0;
const queue = [];
async function slot(fn) {
  if (active >= concurrency) await new Promise((r) => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

function claude(prompt, model, cwd) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", ...(model ? ["--model", model] : []), ...extraArgs];
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude -p took longer than ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* not JSON */ }
      if (!parsed) return reject(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 500)}`));
      if (parsed.is_error) return reject(new Error(`claude -p: ${String(parsed.result ?? parsed.subtype ?? "error").slice(0, 500)}`));
      resolve(parsed);
    });
    child.stdin.end(prompt);
  });
}

/** The first JSON object in a text, also when it sits in a code fence. */
function firstJson(text) {
  const s = String(text ?? "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(s); } catch { /* look for the outermost braces */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("no JSON object in the answer");
}

async function handle(body) {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(work, id);
  const prev = body.previous_response_id ? conversations.get(body.previous_response_id) : null;
  if (body.previous_response_id && !prev) throw Object.assign(new Error(`unknown previous_response_id ${body.previous_response_id}`), { status: 400 });
  const history = [...(prev ?? []), ...turnsFromInput(dir, body.input)];
  const schema = body.text?.format?.type === "json_schema" ? body.text.format.schema : null;
  const tools = body.tools?.length ? body.tools : null;
  const toolsAllowed = Boolean(tools) && body.tool_choice !== "none";
  const started = Date.now();
  let usage = { input_tokens: 0, output_tokens: 0 };
  let answer = null, note = null;

  try {
    for (let attempt = 1; attempt <= 3 && !answer; attempt++) {
      const prompt = buildPrompt(body, history, schema, tools, toolsAllowed, note);
      const res = await slot(() => claude(prompt, body.model, fs.existsSync(dir) ? dir : work));
      const u = res.usage ?? {};
      usage.input_tokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      usage.output_tokens += u.output_tokens ?? 0;
      let a, err = null;
      try {
        a = firstJson(res.result);
        if (a.tool_calls) {
          if (!toolsAllowed) err = "tool calls are not allowed in this request, answer with {\"text\": ...}";
          else if (!Array.isArray(a.tool_calls) || !a.tool_calls.length) err = "tool_calls must be a non-empty array";
          else for (const c of a.tool_calls) {
            const tool = tools.find((t) => t.name === c.name);
            err ??= tool ? check(tool.parameters, c.arguments, `${c.name}.arguments`) : `unknown tool "${c.name}"`;
          }
        } else if (schema) {
          if (!("output" in a)) err = 'this request needs {"output": {...}} matching the schema';
          else err = check(schema, a.output);
        } else if (typeof a.text !== "string") err = 'this request needs {"text": "..."}';
      } catch (e) { err = `not a valid JSON object: ${e.message}`; }
      if (err) { note = err; log(`refused ${id} (attempt ${attempt}): ${err}`); } else answer = a;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!answer) throw new Error(`Claude gave no valid answer after 3 tries: ${note}`);

  let output, turn;
  if (answer.tool_calls) {
    output = answer.tool_calls.map((c, i) => ({ type: "function_call", id: `fc_${id}_${i}`, call_id: `call_${id}_${i}`, name: c.name, arguments: JSON.stringify(c.arguments), status: "completed" }));
    turn = { role: "assistant", tool_calls: answer.tool_calls };
  } else {
    const text = schema ? JSON.stringify(answer.output) : answer.text;
    output = [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
    turn = { role: "assistant", text };
  }
  const respId = `resp_${id}`;
  conversations.set(respId, [...history, turn]);
  if (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
  log(`answered ${id} ${schema ? "structured" : tools ? "agent" : "text"} ${body.model ?? ""} in ${Math.round((Date.now() - started) / 1000)} s`);
  return {
    id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model, output,
    parallel_tool_calls: true, tool_choice: body.tool_choice ?? "auto", tools: body.tools ?? [], error: null, incomplete_details: null, instructions: null, metadata: {},
    usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (req.method !== "POST" || !req.url.replace(/\/+$/, "").endsWith("/responses")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"not found"}}');
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    // Headers go out at once and a space every 20 s keeps the connection open while Claude thinks.
    res.writeHead(200, { "Content-Type": "application/json" });
    const keep = setInterval(() => res.write(" "), 20_000);
    try {
      res.end(JSON.stringify(await handle(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
    } catch (e) {
      log(`error: ${e.message}`);
      res.end(JSON.stringify({ id: `resp_err_${Date.now()}`, object: "response", status: "failed", output: [], error: { message: String(e.message) } }));
    } finally {
      clearInterval(keep);
    }
  });
}).listen(port, () => log(`Claude Code bridge on :${port}, ${concurrency} at a time, args ${JSON.stringify(extraArgs)}`));
