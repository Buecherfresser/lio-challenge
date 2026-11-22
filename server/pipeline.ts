import { config } from "./config.ts";
import { notifyNewTasks } from "./mail/notify.ts";
import { all, get, kv } from "./db.ts";
import { logEvent, newRunId, totalSpendUsd } from "./events.ts";
import { nowIso } from "./clock.ts";
import { llmAvailable } from "./llm.ts";
import { loadBase } from "./ingest/base.ts";
import { replayNext, replayState, syncLive } from "./sync/sync.ts";
import type { SyncResult } from "./sync/sync.ts";
import { runDataAgent } from "./agents/data/index.ts";
import { pendingCount } from "./agents/data/reader.ts";
import { proposeColumnMapping } from "./agents/data/extract.ts";
import { pollInbox } from "./mail/inbox.ts";
import { runRiskAgent } from "./agents/risk.ts";
import { recomputeDecisions, runActionAgent } from "./agents/action.ts";
import type { Overview, Status } from "../shared/api.ts";

// One cycle: sync -> base data -> data agent -> risk agent -> action agent.
// Only one cycle runs at a time. Each step can also be started on its own from the dashboard.

type Step = "sync" | "data_agent" | "risk_agent" | "action_agent";
const running: Record<Step, boolean> = { sync: false, data_agent: false, risk_agent: false, action_agent: false };
const DOCS_PER_CYCLE = Number(process.env.DOCS_PER_CYCLE ?? 60);

async function step<T>(name: Step, fn: () => Promise<T>): Promise<T | null> {
  if (running[name]) return null;
  running[name] = true;
  try {
    return await fn();
  } catch (e) {
    const actor = name === "sync" ? "sync" : name;
    logEvent({ actor, action: `${name}.failed`, summary: `I stopped with an error: ${(e as Error).message}`, output: { stack: String((e as Error).stack).slice(0, 2000) } });
    return null;
  } finally {
    running[name] = false;
  }
}

/** Load the base tables. If a file has columns we do not know, ask the model for a mapping once and load again. */
async function refreshBase(runId: string) {
  let base = loadBase();
  if (base.needsMapping.length && llmAvailable()) {
    for (const item of base.needsMapping) await proposeColumnMapping(item, runId);
    base = loadBase();
  }
  for (const item of base.needsMapping) {
    logEvent({ actor: "sync", action: "base.unknown_columns", run_id: runId, summary: `I could not find the columns ${item.missing.join(", ")} in ${item.doc.path}, so I left the file out.`, object: { type: "document", id: item.doc.path }, output: { headers: item.headers } });
  }
  if (base.facts > 0) {
    logEvent({ actor: "sync", action: "base.loaded", run_id: runId, summary: `I loaded ${base.loaded.length} base files and recorded ${base.facts} new values.`, output: { files: base.loaded } });
  }
}

export async function runSync(advanceReplay = false): Promise<SyncResult | null> {
  return step("sync", async () => {
    const runId = newRunId("sync");
    let res: SyncResult | null;
    if (config.source === "replay") {
      const first = !get("SELECT 1 AS x FROM syncs LIMIT 1");
      res = advanceReplay || first ? replayNext() : null;
    } else {
      res = await syncLive();
    }
    if (res && (res.first || [...res.added, ...res.changed].some((d) => d.handler === "code") || res.removed.length)) await refreshBase(runId);
    return res;
  });
}

const pendingDocs = () => pendingCount();

export async function runData() { return step("data_agent", async () => { await pollInbox(); const r = await runDataAgent({ limit: DOCS_PER_CYCLE }); await notifyNewTasks(); return r; }); }
export async function runRisk(force = false) { return step("risk_agent", () => runRiskAgent({ force })); }
export async function runAction() { return step("action_agent", async () => { recomputeDecisions(); const r = await runActionAgent(); await notifyNewTasks(); return r; }); }

let cycling = false;
let again = false;

/** Run the whole chain. If it is already running, one more pass is queued. */
export async function runCycle(opts: { advanceReplay?: boolean } = {}): Promise<void> {
  if (cycling) { again = true; return; }
  cycling = true;
  try {
    await runSync(opts.advanceReplay);
    // The data agent reads a batch per pass, so the dashboard fills while a large backlog is being read.
    do {
      again = false;
      await runData();
      await runRisk();
      await runAction();
    } while ((again || (pendingDocs() > 0 && llmAvailable())) && !stopping);
  } finally {
    cycling = false;
  }
}

let stopping = false;
export const stopPipeline = () => { stopping = true; };

export function startScheduler() {
  const tick = async () => {
    if (stopping) return;
    await runCycle({ advanceReplay: config.source === "replay" && config.replayIntervalSec > 0 });
    const wait = config.source === "replay" ? (config.replayIntervalSec > 0 ? config.replayIntervalSec : config.syncIntervalSec) : config.syncIntervalSec;
    setTimeout(tick, wait * 1000).unref();
  };
  void tick();
}

export function lastSync(): Overview["last_sync"] {
  const s = kv.get("last_sync");
  return s ? (JSON.parse(s) as Overview["last_sync"]) : null;
}
export const mode = (): Overview["mode"] => ({ source: config.source, mail: config.mail.mode, llm: llmAvailable() });

export function status(): Status {
  const q = all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM documents WHERE current = 1 AND handler = 'openai' GROUP BY status");
  const count = (s: string) => q.find((x) => x.status === s)?.n ?? 0;
  return {
    now: nowIso(),
    customer: { name: config.customer.name, timezone: config.customer.timezone },
    running: { ...running },
    queue: { documents_pending: count("pending"), documents_done: count("done"), documents_failed: count("failed") },
    last_sync: lastSync(),
    mode: mode(),
    spend_usd: totalSpendUsd(),
    replay: config.source === "replay" ? replayState() : null,
  };
}
