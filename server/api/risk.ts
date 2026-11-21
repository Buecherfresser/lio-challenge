import { Hono } from "hono";
import type { Overview } from "../../shared/api.ts";
import { config } from "../config.ts";
import { get, json, kv } from "../db.ts";
import { hoursBetween, packingHoursLeft } from "../clock.ts";
import { llmAvailable } from "../llm.ts";
import { settings } from "../compute/settings.ts";
import { loadSnapshot, memo } from "../compute/state.ts";
import { editions, partDetail, partRows } from "../compute/parts.ts";
import { decisions, riskRows, toRisk } from "../compute/rows.ts";
import { simulate } from "../compute/simulate.ts";
import { allReliability } from "../compute/reliability.ts";
import { mapView } from "../compute/map.ts";
import { approvalFor, APPROVAL_KINDS } from "../compute/approval.ts";
import type { ApprovalKind } from "../compute/approval.ts";
import { agentWork, decide } from "../agents/action.ts";
import { questionRows, toAgentQuestion } from "../agents/questions.ts";
import { currentSettings, saveSettings, valueOf } from "../compute/value.ts";

// Routes for the launch view: copies per edition, the supply map, parts, risks and decision cards.
// The heavy tables are computed once per loaded state and reused for a few seconds (the dashboard polls every 5 s).

export const riskApi = new Hono();

const count = (sql: string) => get<{ n: number }>(sql)?.n ?? 0;

function overview(): Overview {
  const snap = loadSnapshot();
  return memo(snap, "api.overview", () => {
    const now = new Date(snap.now);
    const parts = partRows(snap);
    return {
      now: now.toISOString(),
      deadline: config.deadline,
      hours_left: Math.max(0, Math.round(hoursBetween(now, config.deadline) * 10) / 10),
      packing_hours_left: Math.round(packingHoursLeft(now) * 10) / 10,
      editions: editions(snap),
      open_decisions: decisions("pending"),
      top_risks: riskRows("status = 'open'").slice(0, settings.topRisks).map((r) => toRisk(r, { facts: true, trace: false })),
      agent_work: agentWork(),
      value_at_risk_eur: valueOf(editions(snap).map((e) => ({ product_id: e.product_id, copies: e.lost }))),
      counts: {
        open_issues: count("SELECT COUNT(*) AS n FROM issues WHERE status != 'resolved'"),
        open_tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'"),
        needs_approval_mails: count("SELECT COUNT(*) AS n FROM messages WHERE status = 'needs_approval'"),
        pending_decisions: count("SELECT COUNT(*) AS n FROM decisions WHERE status = 'pending'"),
        parts_at_risk: parts.filter((p) => p.status !== "ok").length,
      },
      last_sync: json<Overview["last_sync"]>(kv.get("last_sync"), null),
      mode: { source: config.source, mail: config.mail.mode, llm: llmAvailable() },
    };
  });
}

riskApi.get("/overview", (c) => c.json(overview()));

riskApi.get("/map", (c) => c.json(mapView()));

riskApi.get("/parts", (c) => c.json(partRows()));

riskApi.get("/parts/:part_id", (c) => {
  const snap = loadSnapshot();
  const id = c.req.param("part_id");
  const detail = memo(snap, `api.part.${id}`, () => partDetail(id, snap));
  return detail ? c.json(detail) : c.json({ error: `${id} is not a part of a launch product` }, 404);
});

riskApi.get("/risks", (c) => {
  const status = c.req.query("status");
  const rows = status === "all" ? riskRows() : status ? riskRows("status = ?", status) : riskRows("status != 'closed'");
  return c.json(rows.map((r) => toRisk(r, { facts: true })));
});

riskApi.get("/decisions", (c) => c.json(decisions(c.req.query("status") ?? "pending")));

async function decideRoute(id: string, verdict: "approved" | "rejected", body: { by?: string; reason?: string }) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const card = await decide(n, verdict, body.by?.trim() || "dashboard", body.reason?.trim() || undefined);
  if (card) loadSnapshot(true); // the next poll shows the new state
  return card;
}
const body = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) ?? {}) as { by?: string; reason?: string };

riskApi.post("/decisions/:id/approve", async (c) => {
  const card = await decideRoute(c.req.param("id"), "approved", await body(c));
  return card ? c.json(card) : c.json({ error: "decision not found" }, 404);
});
riskApi.post("/decisions/:id/reject", async (c) => {
  const card = await decideRoute(c.req.param("id"), "rejected", await body(c));
  return card ? c.json(card) : c.json({ error: "decision not found" }, 404);
});

riskApi.get("/questions", (c) => {
  const id = Number(c.req.query("risk_id"));
  return c.json(questionRows(Number.isInteger(id) && id > 0 ? id : undefined).map(toAgentQuestion));
});

riskApi.get("/settings", (c) => c.json(currentSettings()));
riskApi.post("/settings", async (c) => {
  const saved = saveSettings(((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, never>);
  loadSnapshot(true);
  return c.json(saved);
});

// Extras beyond the contract in shared/api.ts, for the dashboard and for testing the tools by hand.
riskApi.post("/simulate", async (c) => c.json(simulate(await c.req.json().catch(() => ({})))));
riskApi.get("/reliability", (c) => c.json(allReliability()));
riskApi.get("/approval", (c) => {
  const q = c.req.query();
  if (!APPROVAL_KINDS.includes(q.kind as ApprovalKind)) return c.json({ error: `kind must be one of ${APPROVAL_KINDS.join(", ")}` }, 400);
  return c.json(approvalFor({ kind: q.kind as ApprovalKind, amount: q.amount ? Number(q.amount) : null, currency: q.currency || null, category: q.category || null, part_id: q.part_id || null }));
});
