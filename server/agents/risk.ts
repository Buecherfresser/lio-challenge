import type { ToolCallTrace } from "../../shared/api.ts";
import { config } from "../config.ts";
import { get, kv, run } from "../db.ts";
import { nowIso } from "../clock.ts";
import { logEvent, newRunId } from "../events.ts";
import { factsById } from "../facts.ts";
import { arr, enumT, llmAvailable, nullable, numT, obj, prompt, runAgent, str, withStyle } from "../llm.ts";
import type { Tool } from "../llm.ts";
import { settings } from "../compute/settings.ts";
import { dataSignature, loadSnapshot } from "../compute/state.ts";
import { currentWorld } from "../compute/parts.ts";
import { simulate } from "../compute/simulate.ts";
import { SCENARIO_HELP, scenarioSchema, scenarioSignature } from "../compute/scenario.ts";
import { supplierReliability } from "../compute/reliability.ts";
import { APPROVAL_KINDS, approvalFor } from "../compute/approval.ts";
import type { ApprovalKind } from "../compute/approval.ts";
import { factLine, issuesForAgent, objectFacts, overviewForAgent, partForAgent, searchFacts } from "../compute/context.ts";
import { riskRows } from "../compute/rows.ts";
import type { RiskDb } from "../compute/rows.ts";

// The risk agent. A model reads the state through tools and reports risks; code computes what each risk costs,
// checks the evidence and stores it. Without a model the open risks are still recomputed so their numbers follow the data.

export interface RiskRunResult { run_id: string; ran_model: boolean; reason: string; reported: number; closed: number; recomputed: number }

const SEEN_KEY = "risk_agent.seen";
let running = false;
export const riskAgentRunning = () => running;

/** Changes when there is something new to think about: facts, issues, or a model becoming available. */
function thinkSignature(): string {
  const i = get<{ n: number; m: string | null }>("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM issues");
  return `${dataSignature().split("|")[0]}|${i?.n ?? 0}|${i?.m ?? ""}|${llmAvailable() ? "llm" : "no-llm"}`;
}

const clipTrace = (trace: ToolCallTrace[]): ToolCallTrace[] => trace.map((t) => {
  const s = JSON.stringify(t.result ?? null);
  return s.length > settings.traceResultMaxChars ? { ...t, result: { truncated: true, head: s.slice(0, settings.traceResultMaxChars) } } : t;
});

/** Recompute what every open risk costs with the current data. Runs on every call, with or without a model. */
export function recomputeOpenRisks(runId: string): { recomputed: number; changed: number; closed: number } {
  const snap = loadSnapshot(true);
  let changed = 0, closed = 0;
  const rows = riskRows("status IN ('open', 'mitigated')");
  for (const r of rows) {
    const sim = simulate(JSON.parse(r.scenario), snap);
    if (!sim.valid) {
      // The lot or shipment the risk was about is gone (received, used up), so the scenario cannot happen any more.
      run("UPDATE risks SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), r.id);
      closed++;
      logEvent({ actor: "risk_agent", action: "risk.closed", run_id: runId, object: { type: "risk", id: String(r.id), label: r.title },
        summary: `I closed the risk "${r.title}" because its what-if no longer matches the data: ${sim.problems.join(" ")}`, input: { scenario: sim.scenario }, output: { problems: sim.problems } });
      continue;
    }
    const by = JSON.stringify(sim.copies_at_risk_by_product);
    if (sim.copies_at_risk !== r.copies_at_risk || by !== r.copies_by_product) {
      run("UPDATE risks SET copies_at_risk = ?, copies_by_product = ?, updated_at = ? WHERE id = ?", sim.copies_at_risk, by, nowIso(), r.id);
      changed++;
      logEvent({ actor: "risk_agent", action: "risk.recomputed", run_id: runId, object: { type: "risk", id: String(r.id), label: r.title },
        summary: `I recomputed the risk "${r.title}" with the latest data: ${r.copies_at_risk.toLocaleString("en-US")} copies at risk became ${sim.copies_at_risk.toLocaleString("en-US")}.`,
        input: { scenario: sim.scenario }, output: { before: r.copies_at_risk, after: sim.copies_at_risk, by_product: sim.copies_at_risk_by_product, editions: sim.result } });
    }
  }
  return { recomputed: rows.length, changed, closed };
}

interface ReportArgs { title: string; part_id: string | null; product_id: string | null; supplier_id: string | null; scenario: unknown; probability: number; explanation: string; fact_ids: number[]; updates_risk_id: number | null }

/** Check a reported risk, compute what it costs and store it. Returns what goes back to the model. */
export function storeRisk(a: ReportArgs, runId: string, trace: ToolCallTrace[]): { accepted: boolean; reason?: string; risk_id?: number; copies_at_risk?: number; copies_by_product?: unknown; note?: string } {
  const snap = loadSnapshot();
  const world = currentWorld(snap);
  const reject = (reason: string) => {
    logEvent({ actor: "risk_agent", action: "risk.rejected", run_id: runId, summary: `I sent the risk "${String(a.title).slice(0, 120)}" back to the model: ${reason}`, input: a, output: { reason } });
    return { accepted: false, reason };
  };
  if (!a.title?.trim() || !a.explanation?.trim()) return reject("A risk needs a title and an explanation.");
  if (!(a.probability >= 0 && a.probability <= 1)) return reject("The probability must be between 0 and 1.");
  const factIds = [...new Set((a.fact_ids ?? []).filter((x) => Number.isInteger(x)))];
  if (!factIds.length) return reject("No facts cited. Cite the ids of the facts the risk rests on.");
  const found = new Set(factsById(factIds).map((f) => f.id));
  const missing = factIds.filter((id) => !found.has(id));
  if (missing.length) return reject(`These fact ids do not exist: ${missing.join(", ")}. Cite only ids from tool results.`);
  if (a.part_id && !world.parts.has(a.part_id)) return reject(`${a.part_id} is not a part of a launch product.`);
  if (a.product_id && !world.products.some((p) => p.product_id === a.product_id)) return reject(`${a.product_id} is not a launch product.`);
  if (a.supplier_id && !snap.suppliers.has(a.supplier_id)) return reject(`${a.supplier_id} is not a known supplier.`);
  const sim = simulate(a.scenario, snap);
  if (!sim.valid) return reject(`The code cannot compute this scenario: ${sim.problems.join(" ")}`);

  const key = `${a.part_id ?? "-"}|${a.supplier_id ?? "-"}|${scenarioSignature(sim.scenario)}`;
  const existing = (a.updates_risk_id ? get<RiskDb>("SELECT * FROM risks WHERE id = ?", a.updates_risk_id) : undefined) ?? get<RiskDb>("SELECT * FROM risks WHERE dedupe_key = ?", key);
  const call: ToolCallTrace = { id: `report-${trace.length + 1}`, name: "report_risk", args: a, result: { copies_at_risk: sim.copies_at_risk, copies_by_product: sim.copies_at_risk_by_product } };
  const fields = [a.part_id, a.product_id, a.supplier_id, a.title.trim(), a.explanation.trim(), a.probability, sim.copies_at_risk, JSON.stringify(sim.copies_at_risk_by_product),
    JSON.stringify(sim.scenario), JSON.stringify(factIds), JSON.stringify(clipTrace([...trace, call])), runId];
  let id: number;
  if (existing) {
    id = existing.id;
    // Same cause as before: update it. A risk that was closed and is reported again is open again; a mitigated one stays mitigated.
    const taken = existing.dedupe_key !== key && get("SELECT 1 AS x FROM risks WHERE dedupe_key = ? AND id != ?", key, id);
    run(`UPDATE risks SET part_id = ?, product_id = ?, supplier_id = ?, title = ?, explanation = ?, probability = ?, copies_at_risk = ?, copies_by_product = ?, scenario = ?, fact_ids = ?, tool_calls = ?, run_id = ?,
         status = CASE WHEN status = 'closed' THEN 'open' ELSE status END, dedupe_key = ?, updated_at = ? WHERE id = ?`, ...fields, taken ? existing.dedupe_key : key, nowIso(), id);
  } else {
    id = run(`INSERT INTO risks (part_id, product_id, supplier_id, title, explanation, probability, copies_at_risk, copies_by_product, scenario, fact_ids, tool_calls, run_id, dedupe_key, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`, ...fields, key, nowIso(), nowIso()).lastId;
  }
  logEvent({ actor: "risk_agent", action: existing ? "risk.updated" : "risk.reported", run_id: runId, object: { type: "risk", id: String(id), label: a.title.trim() }, fact_ids: factIds,
    summary: `I ${existing ? "updated" : "reported"} the risk "${a.title.trim()}": ${sim.copies_at_risk.toLocaleString("en-US")} copies at risk at ${Math.round(a.probability * 100)} % probability.`,
    input: a, output: { risk_id: id, copies_at_risk: sim.copies_at_risk, copies_by_product: sim.copies_at_risk_by_product, baseline: sim.baseline, result: sim.result } });
  return { accepted: true, risk_id: id, copies_at_risk: sim.copies_at_risk, copies_by_product: sim.copies_at_risk_by_product,
    ...(sim.copies_at_risk === 0 ? { note: "As things stand this scenario costs no copies, usually because another part limits the edition first. It is stored. Say in the explanation when it would start to cost copies." } : {}) };
}

function tools(runId: string, trace: ToolCallTrace[], reported: Set<number>): Tool[] {
  const logged = <A>(name: string, summary: (args: A, result: any) => string, fn: (args: A) => unknown, object?: (args: A) => { type: "part" | "supplier"; id: string } | null) => async (args: A) => {
    const result = await fn(args);
    logEvent({ actor: "risk_agent", action: `tool.${name}`, run_id: runId, summary: summary(args, result), input: args, output: result, object: object?.(args) ?? null });
    return result;
  };
  return [
    { name: "get_overview", description: "Copies per edition (safe, uncertain, lost, bottleneck), the parts table, suppliers, time left. Start here.", parameters: obj({}),
      run: logged<object>("get_overview", () => "I looked at the copies per edition and the parts table.", () => overviewForAgent()) },
    { name: "get_part", description: "One part in detail: where each number comes from, lots, open shipments and order lines, suppliers with their facts and price list, open issues. Every fact has an id you can cite.",
      parameters: obj({ part_id: str("part id from the overview") }),
      run: logged<{ part_id: string }>("get_part", (a, r) => (r.error ? `I tried to open ${a.part_id}: ${r.error}` : `I looked at ${r.description} (${a.part_id}) in detail.`), (a) => partForAgent(a.part_id), (a) => ({ type: "part", id: a.part_id })) },
    { name: "list_open_issues", description: "Deviations and contradictions the data agent raised that are not resolved yet.", parameters: obj({}),
      run: logged<object>("list_open_issues", (_a, r) => `I read the ${r.length} open issues.`, () => issuesForAgent()) },
    { name: "get_facts", description: "What the sources say about one object. object_type is one of po_line, shipment, part, lot, supplier, product, policy, role.",
      parameters: obj({ object_type: enumT(["po_line", "shipment", "part", "lot", "supplier", "product", "policy", "role"]), object_id: str("id of the object, e.g. an order line 4500000000/1, a shipment id, a supplier id, a role title") }),
      run: logged<{ object_type: string; object_id: string }>("get_facts", (a, r) => `I read the ${r.length} facts on ${a.object_type.replace("_", " ")} ${a.object_id}.`, (a) => objectFacts(a.object_type, a.object_id).slice(-150).map(factLine)) },
    { name: "search_facts", description: "Text search over notices, offers, contract terms, capacity notes, other free-text facts and document summaries. Several words are matched one by one, best matches first.",
      parameters: obj({ query: str("words to look for, e.g. a part id, a supplier name, 'export licence', 'downtime'") }),
      run: logged<{ query: string }>("search_facts", (a, r) => `I searched the facts and document summaries for "${a.query}" and found ${r.facts.length + r.documents.length} matches.`, (a) => searchFacts(a.query)) },
    { name: "supplier_reliability", description: "How a supplier delivered in the past: share on time, average delay in days, share of short deliveries, sample sizes. Optionally for one part.",
      parameters: obj({ supplier_id: str(), part_id: nullable(str("limit to one part, or null")) }),
      run: logged<{ supplier_id: string; part_id: string | null }>("supplier_reliability",
        (a, r) => (r.error ? `I asked for the delivery history of ${a.supplier_id}: ${r.error}` : `I checked how ${r.name} delivered in the past: ${r.on_time_share === null ? "no finished deliveries on file" : `${Math.round(r.on_time_share * 100)} % on time over ${r.deliveries} deliveries`}.`),
        (a) => supplierReliability(a.supplier_id, a.part_id) ?? { error: "No such supplier and no deliveries on file." }, (a) => ({ type: "supplier", id: a.supplier_id })) },
    { name: "approval_lookup", description: "Who has to approve an action per the approval policy, and whether that person can sign today. amount is the value of the action, null if unknown.",
      parameters: obj({ kind: enumT(APPROVAL_KINDS), amount: nullable(numT()), currency: nullable(str("ISO code, null = EUR")), part_id: nullable(str("part the action is about, decides the responsible category")) }),
      run: logged<{ kind: ApprovalKind; amount: number | null; currency: string | null; part_id: string | null }>("approval_lookup",
        (a, r) => `I looked up who approves ${a.kind.replace(/_/g, " ")}: ${r.approver.role}${r.approver.person ? ` (${r.approver.person})` : ""}${r.approver.available ? "" : ", who cannot sign today"}.`, (a) => approvalFor(a)) },
    { name: "simulate", description: "What-if: copies per edition under a scenario, next to the current state. Returns copies_at_risk computed by code.", parameters: obj({ scenario: scenarioSchema }),
      run: logged<{ scenario: unknown }>("simulate", (_a, r) => (r.valid ? `I computed a what-if (${r.scenario.changes.map((c: { type: string }) => c.type.replace(/_/g, " ")).join(", ")}): ${r.copies_at_risk.toLocaleString("en-US")} copies at risk.` : `I tried a what-if the code could not compute: ${r.problems.join(" ")}`),
        (a) => simulate(a.scenario)) },
    { name: "report_risk", description: "Report one risk. Code computes the copies at risk from the scenario, checks the cited facts and stores the risk. Returns accepted true or false with the reason.",
      parameters: obj({
        title: str("what goes wrong, one line"), part_id: nullable(str()), product_id: nullable(str()), supplier_id: nullable(str()), scenario: scenarioSchema,
        probability: numT("0..1, grounded in the delivery history or in cited facts"), explanation: str("the chain of facts, three to six sentences"), fact_ids: arr({ type: "integer" }),
        updates_risk_id: nullable({ type: "integer", description: "id of the open risk this updates, or null" }),
      }),
      run: (a: ReportArgs) => { const r = storeRisk(a, runId, trace); if (r.accepted && r.risk_id) reported.add(r.risk_id); return r; } },
  ];
}

export async function runRiskAgent(opts: { runId?: string; force?: boolean } = {}): Promise<RiskRunResult> {
  const runId = opts.runId ?? newRunId("risk");
  if (running) return { run_id: runId, ran_model: false, reason: "already running", reported: 0, closed: 0, recomputed: 0 };
  running = true;
  try {
    const re = recomputeOpenRisks(runId);
    const signature = thinkSignature();
    if (!opts.force && kv.get(SEEN_KEY) === signature) return { run_id: runId, ran_model: false, reason: "nothing changed since the last run", reported: 0, closed: re.closed, recomputed: re.recomputed };
    // While the data agent still works through a backlog of documents, a run would judge half the picture.
    const unread = get<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE current = 1 AND handler = 'openai' AND status = 'pending'")?.n ?? 0;
    if (!opts.force && llmAvailable() && settings.riskAgentWaitsForDocuments && unread > 0) {
      return { run_id: runId, ran_model: false, reason: `${unread} documents are still to be read`, reported: 0, closed: re.closed, recomputed: re.recomputed };
    }
    if (!llmAvailable()) {
      logEvent({ actor: "risk_agent", action: "risk_agent.skipped", run_id: runId,
        summary: `I did not look for new risks because no OpenAI key is set. I recomputed the ${re.recomputed} open risk${re.recomputed === 1 ? "" : "s"} with the latest data.`, output: re });
      kv.set(SEEN_KEY, signature);
      return { run_id: runId, ran_model: false, reason: "no model available", reported: 0, closed: re.closed, recomputed: re.recomputed };
    }

    const open = riskRows("status IN ('open', 'mitigated')");
    const overview = overviewForAgent(loadSnapshot(true));
    const trace: ToolCallTrace[] = [];
    const reported = new Set<number>();
    const user = [
      `It is ${overview.now}. The deadline is ${overview.deadline}.`,
      "Copies per edition right now:",
      JSON.stringify(overview.editions),
      open.length ? "Risks that are open from earlier runs. Report each one again if it still holds (pass its id as updates_risk_id), with the same scenario unless the facts changed. Risks you do not report again are closed." : "No risks are open yet.",
      open.length ? JSON.stringify(open.map((r) => ({ id: r.id, status: r.status, title: r.title, part_id: r.part_id, supplier_id: r.supplier_id, scenario: JSON.parse(r.scenario), copies_at_risk: r.copies_at_risk, probability: r.probability, fact_ids: JSON.parse(r.fact_ids) }))) : "",
      "Go through the parts, issues and facts and report every risk to the launch.",
    ].filter(Boolean).join("\n\n");

    logEvent({ actor: "risk_agent", action: "risk_agent.started", run_id: runId, summary: `I started looking for risks, with ${open.length} risks open from earlier runs.`, input: { editions: overview.editions, open_risks: open.map((r) => r.id) } });
    const res = await runAgent({
      model: config.openai.modelAgent,
      system: withStyle(prompt("risk_agent.md").replace("{{SCENARIO_HELP}}", SCENARIO_HELP)),
      user, tools: tools(runId, trace, reported), maxSteps: settings.riskAgentMaxSteps,
      onToolCall: (t) => { trace.push(t); },
    });

    // Risks from earlier runs that the model did not report again no longer hold.
    let closed = 0;
    for (const r of open.filter((x) => x.status === "open" && !reported.has(x.id))) {
      run("UPDATE risks SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), r.id);
      closed++;
      logEvent({ actor: "risk_agent", action: "risk.closed", run_id: runId, object: { type: "risk", id: String(r.id), label: r.title }, summary: `I closed the risk "${r.title}" because it no longer shows in the data.` });
    }
    kv.set(SEEN_KEY, thinkSignature());
    logEvent({ actor: "risk_agent", action: "risk_agent.finished", run_id: runId,
      summary: `I finished looking for risks: ${reported.size} reported or confirmed, ${closed} closed, after ${trace.length} tool calls.`,
      input: { steps: res.steps, tool_calls: trace.map((t) => t.name) }, output: { summary: res.text, reported: [...reported], closed },
      model: res.usage.model, tokens_in: res.usage.tokens_in, tokens_out: res.usage.tokens_out, cost_usd: res.usage.cost_usd });
    return { run_id: runId, ran_model: true, reason: opts.force ? "forced" : "new facts or issues", reported: reported.size, closed: closed + re.closed, recomputed: re.recomputed };
  } finally {
    running = false;
  }
}
