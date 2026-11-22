import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env in the app folder wins, the token file one level up is the fallback for the portal token.
for (const f of [path.join(APP_DIR, ".env"), path.join(APP_DIR, "..", "lio-key.env")]) {
  if (fs.existsSync(f)) {
    try { process.loadEnvFile(f); } catch { /* unreadable env file: ignore */ }
  }
}

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
const bool = (k: string, d = false) => (env(k) ? /^(1|true|yes|on)$/i.test(env(k)) : d);
const num = (k: string, d: number) => (env(k) && Number.isFinite(Number(env(k))) ? Number(env(k)) : d);

function parsePrices(s: string): Record<string, { input: number; output: number }> {
  const out: Record<string, { input: number; output: number }> = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [model, p] = part.split("=");
    const [i, o] = (p ?? "").split("/").map(Number);
    if (model && Number.isFinite(i) && Number.isFinite(o)) out[model] = { input: i, output: o };
  }
  return out;
}

function parseShifts(s: string): { start: string; end: string }[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [start, end] = x.split("/");
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }).filter((x) => x.start < x.end);
}

function parseMap(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split("=");
    if (k && Number.isFinite(Number(v))) out[k.trim()] = Number(v);
  }
  return out;
}

const dataDir = path.resolve(APP_DIR, env("DATA_DIR", "./data"));

export const config = {
  port: num("PORT", 8787),
  // true = nobody can change settings from the dashboard (the limit up to which the agent orders on its own, the value of a copy).
  settingsLocked: bool("SETTINGS_LOCKED"),
  dataDir,
  archiveDir: path.join(dataDir, "archive"),   // snapshots and file blobs, never deleted
  outboxDir: path.join(dataDir, "outbox"),
  promptsDir: path.join(APP_DIR, "prompts"),
  webDist: path.join(APP_DIR, "web", "dist"),

  lio: {
    baseUrl: env("LIO_BASE_URL", "https://start-hack-portal-cxh3crbdaef2f8gt.westeurope-01.azurewebsites.net").replace(/\/+$/, ""),
    token: env("LIO_TOKEN") || env("BEARER"),
  },
  source: (env("SOURCE", "live") === "replay" ? "replay" : "live") as "live" | "replay",
  syncIntervalSec: num("SYNC_INTERVAL_SEC", 180),
  replayIntervalSec: num("REPLAY_INTERVAL_SEC", 0),

  // Who the product works for. The rest of what the agents know about the customer is in prompts/customer.md.
  customer: { name: env("CUSTOMER_NAME", "the customer"), timezone: env("TIMEZONE", "Europe/Berlin") },
  // How the customer's supplier portal is laid out (see server/adapters). One adapter per customer.
  portalAdapter: env("PORTAL_ADAPTER", "soony"),
  deadline: new Date(env("DEADLINE", "2026-11-22T20:00:00+01:00")).toISOString(),
  shifts: parseShifts(env("SHIFTS", "2026-11-21T06:00:00+01:00/2026-11-21T22:00:00+01:00,2026-11-22T06:00:00+01:00/2026-11-22T20:00:00+01:00")),
  fixedNow: env("NOW") ? new Date(env("NOW")).toISOString() : null,
  // Value of one unit of a currency in EUR. Used to compare order values with approval limits.
  fxToEur: { EUR: 1, ...parseMap(env("FX_TO_EUR", "USD=0.92,CNY=0.13,INR=0.011,PLN=0.23")) } as Record<string, number>,
  // A shipment that is on its way and has had no tracking update for this many hours is stale.
  trackingMaxAgeHours: parseMap(env("TRACKING_MAX_AGE_HOURS", "sea=36,air=8,road=6")),

  // Which model answers: "openai" (the OpenAI API) or "claude-code" (`claude -p` through claude-bridge/, for testing).
  llmProvider: (env("LLM_PROVIDER", "openai") === "claude-code" ? "claude-code" : "openai") as "openai" | "claude-code",
  claudeCode: {
    // The bridge container, reachable from the app under its compose name.
    url: env("CLAUDE_CODE_URL", "http://claude:8790/v1"),
    // Model for every call: an alias (sonnet, opus, haiku) or a full model name. Empty = the account's default.
    model: env("CLAUDE_CODE_MODEL", "sonnet"),
    timeoutMs: num("CLAUDE_CODE_TIMEOUT_MS", 900_000),
    // The app serves each agent run's tools over MCP on this internal port. The claude container reaches it here.
    mcpPort: num("CLAUDE_CODE_MCP_PORT", 8091),
    mcpUrl: env("CLAUDE_CODE_MCP_URL", "http://app:8091/mcp"),
    // Source files for a run go here, and the claude container sees the same folder (read-only) under filesPath.
    filesDir: env("CLAUDE_CODE_FILES_DIR") || path.join(dataDir, "claude-files"),
    filesPath: env("CLAUDE_CODE_FILES_PATH", "/files"),
  },

  openai: {
    apiKey: env("OPENAI_API_KEY"),
    modelExtract: env("OPENAI_MODEL_EXTRACT", "gpt-6-luna"),
    modelAgent: env("OPENAI_MODEL_AGENT", "gpt-6-luna"),
    // The reading agent works with tools and reads scans. It uses the agent model unless set on its own.
    modelReader: env("OPENAI_MODEL_READER") || env("OPENAI_MODEL_AGENT", "gpt-6-luna"),
    prices: parsePrices(env("OPENAI_PRICES", "gpt-6-luna=0.10/0.50,gpt-6.1-terra=1/5,gpt-6.2-sol=2/10,gpt-6.2-astra=8/40")),
    concurrency: num("LLM_CONCURRENCY", 6),
    // Model calls stop once the logged spend reaches this many US dollars. 0 = no limit.
    budgetUsd: num("OPENAI_BUDGET_USD", 0),
  },

  mail: {
    mode: (env("MAIL_MODE", "outbox") === "live" ? "live" : "outbox") as "outbox" | "live",
    allowedSenders: env("MAIL_ALLOWED_SENDERS").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    from: env("MAIL_FROM"),
    fromName: env("MAIL_FROM_NAME", "Soony Procurement"),
    smtp: { host: env("SMTP_HOST"), port: num("SMTP_PORT", 465), user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    imap: { host: env("IMAP_HOST"), port: num("IMAP_PORT", 993), user: env("IMAP_USER"), pass: env("IMAP_PASS"), pollSec: num("IMAP_POLL_SEC", 120) },
    autoSendClarifications: bool("AUTO_SEND_CLARIFICATIONS", true),
    sendOnApproval: bool("SEND_ON_APPROVAL", true),
  },

  // Roles that work in the dashboard. A role counts if its title contains one of these. Everyone else (warehouse,
  // logistics, quality) never opens it: their tasks are listed apart, for a buyer to pass on and to record the answer.
  dashboardRoles: env("DASHBOARD_ROLES", "Head of Procurement,Chief Procurement Officer,CPO,Buyer,Category Lead")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),

  // Approval notices: a short mail to whoever signs a decision next. For the hackathon all of them go to one address.
  notify: {
    to: env("NOTIFY_EMAIL"),
    // Where the link in a notice points.
    appUrl: env("APP_URL", "http://localhost:8787"),
  },
};

fs.mkdirSync(config.archiveDir, { recursive: true });
fs.mkdirSync(config.outboxDir, { recursive: true });
