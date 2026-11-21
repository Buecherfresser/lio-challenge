import type { Actor } from "../../shared/api.ts";
import { logEvent } from "../events.ts";
import { enumT, nullable, numT, obj, str } from "../llm.ts";
import type { Tool } from "../llm.ts";
import { supplierReliability } from "../compute/reliability.ts";
import { APPROVAL_KINDS, approvalFor } from "../compute/approval.ts";
import type { ApprovalKind } from "../compute/approval.ts";
import { factLine, issuesForAgent, objectFacts, overviewForAgent, partForAgent, searchFacts } from "../compute/context.ts";

// The tools an agent reads the state with. They change nothing. Every call is logged as one sentence under the agent's name.

export type Logged = <A>(name: string, summary: (args: A, result: any) => string, fn: (args: A) => unknown, object?: (args: A) => { type: "part" | "supplier" | "risk" | "decision"; id: string } | null) => (args: A) => Promise<unknown>;

/** Wrap a tool so each call leaves a line in the log. */
export const logger = (actor: Actor, runId: string, fallbackObject?: { type: "risk"; id: string }): Logged => (name, summary, fn, object) => async (args) => {
  const result = await fn(args);
  logEvent({ actor, action: `tool.${name}`, run_id: runId, summary: summary(args, result), input: args, output: result, object: object?.(args) ?? fallbackObject ?? null });
  return result;
};

export function readTools(logged: Logged): Tool[] {
  return [
    { name: "get_overview", description: "Copies per edition (safe, uncertain, lost, bottleneck), the parts table, suppliers, time left.", parameters: obj({}),
      run: logged<object>("get_overview", () => "I looked at the copies per edition and the parts table.", () => overviewForAgent()) },
    { name: "get_part", description: "One part in detail: where each number comes from, lots, open shipments and order lines, suppliers with their facts and price list, open issues. Every fact has an id you can cite.",
      parameters: obj({ part_id: str("part id") }),
      run: logged<{ part_id: string }>("get_part", (a, r) => (r.error ? `I tried to open ${a.part_id}: ${r.error}` : `I looked at ${r.description} (${a.part_id}) in detail.`), (a) => partForAgent(a.part_id), (a) => ({ type: "part", id: a.part_id })) },
    { name: "list_open_issues", description: "Deviations and contradictions the data agent raised that are not cleared yet, with the question it asked and whether an answer is in.", parameters: obj({}),
      run: logged<object>("list_open_issues", (_a, r) => `I read the ${r.length} open issues.`, () => issuesForAgent()) },
    { name: "get_facts", description: "What the sources say about one object. object_type is one of po_line, shipment, part, lot, supplier, product, policy, role.",
      parameters: obj({ object_type: enumT(["po_line", "shipment", "part", "lot", "supplier", "product", "policy", "role"]), object_id: str("id of the object, e.g. an order line 4500000000/1, a shipment id, a supplier id, a role title") }),
      run: logged<{ object_type: string; object_id: string }>("get_facts", (a, r) => `I read the ${r.length} facts on ${a.object_type.replace("_", " ")} ${a.object_id}.`, (a) => objectFacts(a.object_type, a.object_id).slice(-150).map(factLine)) },
    { name: "search_facts", description: "Text search over notices, offers, contract terms, capacity notes, news, other free-text facts and document summaries. Several words are matched one by one, best matches first.",
      parameters: obj({ query: str("words to look for, e.g. a part id, a supplier name, 'offer', 'downtime', 'export licence'") }),
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
  ];
}
