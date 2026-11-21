import { logEvent, newRunId } from "../../events.ts";
import { correspond } from "./correspond.ts";
import { pendingCount, readSources } from "./reader.ts";
import { runRules } from "./rules.ts";

// The data agent: it reads, compares, and asks. It never escalates or acts.
//   1. reading agent: every new document and received mail, one at a time, into facts, notes and questions
//   2. rules (code only): deviations from what Soony expects, and contradictions between sources
//   3. correspondence: once nothing new is left to read, all open issues become one mail per supplier,
//      one task per role, or are closed. So nobody gets a mail while half of an update is still unread.

export interface DataAgentResult { documents_read: number; facts_added: number; issues_opened: number; mails_drafted: number; tasks_created: number }

let inFlight: Promise<DataAgentResult> | null = null;

/** One pass. If a pass is already running, the caller gets the result of that one. */
export function runDataAgent(opts: { runId?: string; limit?: number; perLane?: number; mailsOnly?: boolean; correspond?: boolean } = {}): Promise<DataAgentResult> {
  if (inFlight) return inFlight;
  inFlight = pass(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function pass(opts: { runId?: string; limit?: number; perLane?: number; mailsOnly?: boolean; correspond?: boolean }): Promise<DataAgentResult> {
  const runId = opts.runId ?? newRunId("data");
  const result: DataAgentResult = { documents_read: 0, facts_added: 0, issues_opened: 0, mails_drafted: 0, tasks_created: 0 };
  const failed = (step: string, e: unknown) => logEvent({ actor: "data_agent", action: `data_agent.${step}_failed`, run_id: runId, summary: `I hit an error while ${step}: ${(e as Error)?.message ?? String(e)}`, output: { stack: String((e as Error)?.stack ?? "").slice(0, 2000) } });

  try {
    const r = await readSources({ runId, limit: opts.limit, perLane: opts.perLane, mailsOnly: opts.mailsOnly });
    result.documents_read += r.read; result.facts_added += r.facts_added;
  } catch (e) { failed("reading", e); }

  try {
    const r = runRules(runId);
    result.issues_opened += r.opened.length + r.reopened.length;
  } catch (e) { failed("checking for deviations", e); }

  // Questions go out only when the whole update is read, unless asked for explicitly.
  if (opts.correspond || pendingCount() === 0) {
    try {
      const r = await correspond({ runId });
      result.mails_drafted += r.mails; result.tasks_created += r.tasks;
    } catch (e) { failed("writing questions", e); }
  }
  return result;
}

export { runRules, findDeviations, expectedForPoLine, expectedForShipment, partCoverage, loadState } from "./rules.ts";
export type { PoLineExpectation, ShipmentExpectation, PartCoverage, IssueDraft } from "./rules.ts";
export { toIssue, toMessage, toTask } from "./rows.ts";
