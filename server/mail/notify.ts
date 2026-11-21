import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { DecisionCard } from "../../shared/api.ts";
import { config } from "../config.ts";
import { kv } from "../db.ts";
import { logEvent } from "../events.ts";
import { fmtQty, fmtTime } from "../compute/settings.ts";
import { decisionById } from "../compute/rows.ts";

// Tells the person who has to sign a decision that it waits for them, by mail. The Head of Procurement lives in Outlook,
// so a short mail with a link reaches her faster than the dashboard.
// For the hackathon every notice goes to one address (NOTIFY_EMAIL) and names the person it is meant for.
// Each person hears about each decision once: when it is proposed, or when the signature before theirs is in.

let saidOff = false;

const fmtEur = (n: number) => `EUR ${fmtQty(n)}`;

function text(d: DecisionCard, person: string, role: string): { subject: string; body: string } {
  const link = `${config.notify.appUrl.replace(/\/$/, "")}/todo?item=decision-${d.id}`;
  const due = d.decide_by ? new Date(d.decide_by).getTime() : null;
  const lines = [
    `Saves ${fmtQty(d.copies_saved)} copies${d.value_eur ? `, worth ${fmtEur(d.value_eur)}` : ""}.`,
    d.cost_eur === null ? "Cost: needs a quote." : `Cost: ${fmtEur(d.cost_eur)}.`,
    due
      ? `Decide by ${fmtTime(due)}.${d.wait_copies_per_hour ? ` Each hour later costs ${fmtQty(d.wait_copies_per_hour)} copies.` : ""}`
      : "No deadline.",
  ];
  const body = [
    `Hello ${person},`,
    "",
    `"${d.title}" waits for your approval.`,
    "",
    d.option,
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    `Approve or reject it here: ${link}`,
    "",
    `Hackathon note: this notice is meant for ${person} (${role}) and goes to ${config.notify.to} instead.`,
    "",
    "Soony Procurement",
  ].join("\n");
  return { subject: `Approval needed${due ? ` by ${fmtTime(due)}` : ""}: ${d.title}`, body };
}

/**
 * Notify whoever signs next on a pending decision. Does nothing when no address is set, when the decision is no
 * longer pending, or when that person has already been told about it. Never throws: a failed notice is logged.
 */
export async function notifyNextSigner(decisionId: number): Promise<void> {
  const to = config.notify.to;
  if (!to) {
    if (!saidOff) {
      saidOff = true;
      logEvent({ actor: "system", action: "notify.off", summary: "I do not send approval notices because no address is set (NOTIFY_EMAIL)." });
    }
    return;
  }
  const d = decisionById(decisionId);
  if (!d || d.status !== "pending") return;
  const sigs = d.signatures.length ? d.signatures : [{ role: d.approver.role, person: d.approver.person, signed_by: null }];
  const next = sigs.find((s) => !s.signed_by);
  if (!next) return;
  const person = next.person ?? next.role;
  const key = `notified:${d.id}:${person}`;
  if (kv.get(key)) return;

  const { subject, body } = text(d, person, next.role);
  const from = config.mail.from || "outbox@localhost";
  const mail = { from: `"${config.mail.fromName}" <${from}>`, to, subject, text: body };
  const object = { type: "decision" as const, id: String(d.id), label: d.title };
  try {
    let file: string | null = null;
    if (config.mail.mode === "live" && config.mail.smtp.host && config.mail.smtp.user && config.mail.smtp.pass) {
      const smtp = nodemailer.createTransport({ host: config.mail.smtp.host, port: config.mail.smtp.port, secure: config.mail.smtp.port === 465, auth: { user: config.mail.smtp.user, pass: config.mail.smtp.pass } });
      await smtp.sendMail(mail);
    } else {
      const info = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" }).sendMail(mail);
      fs.mkdirSync(config.outboxDir, { recursive: true });
      file = path.join(config.outboxDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_notify_decision-${d.id}.eml`);
      fs.writeFileSync(file, info.message as Buffer);
    }
    kv.set(key, new Date().toISOString());
    logEvent({ actor: "system", action: "notify.sent", object,
      summary: file ? `I put a notice for ${person} about "${d.title}" into the local outbox.` : `I told ${person} by mail that "${d.title}" waits for their approval (sent to ${to}).`,
      output: { to, for: person, role: next.role, subject, file } });
  } catch (e) {
    logEvent({ actor: "system", action: "notify.failed", object,
      summary: `I could not send the approval notice for "${d.title}" to ${person}: ${(e as Error).message.slice(0, 200)}`, output: { to, for: person } });
  }
}
