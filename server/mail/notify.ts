import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { DecisionCard } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, kv, run } from "../db.ts";
import { logEvent } from "../events.ts";
import { fmtQty, fmtTime } from "../compute/settings.ts";
import { decisionById } from "../compute/rows.ts";
import type { TaskDb } from "../agents/data/rows.ts";

// Tells the person who has to sign a decision that it waits for them, by mail. The Head of Procurement lives in Outlook,
// so a short mail with a link reaches her faster than the dashboard.
// For the hackathon every notice goes to one address (NOTIFY_EMAIL) and names the person it is meant for.
// Each person hears about each decision once: when it is proposed, or when the signature before theirs is in.

let saidOff = false;

const fmtEur = (n: number) => `EUR ${fmtQty(n)}`;

function text(d: DecisionCard, person: string, role: string): { subject: string; body: string } {
  const link = `${config.notify.appUrl.replace(/\/$/, "")}/decisions?item=decision-${d.id}`;
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
    config.mail.fromName,
  ].join("\n");
  return { subject: `Approval needed${due ? ` by ${fmtTime(due)}` : ""}: ${d.title}`, body };
}

/** Send one notice to NOTIFY_EMAIL, or write it to the outbox when live mail is off. Returns the outbox file, if any. */
async function sendNotice(subject: string, body: string, fileTag: string): Promise<string | null> {
  const from = config.mail.from || "outbox@localhost";
  const mail = { from: `"${config.mail.fromName}" <${from}>`, to: config.notify.to, subject, text: body };
  if (config.mail.mode === "live" && config.mail.smtp.host && config.mail.smtp.user && config.mail.smtp.pass) {
    const smtp = nodemailer.createTransport({ host: config.mail.smtp.host, port: config.mail.smtp.port, secure: config.mail.smtp.port === 465, auth: { user: config.mail.smtp.user, pass: config.mail.smtp.pass } });
    await smtp.sendMail(mail);
    return null;
  }
  const info = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" }).sendMail(mail);
  fs.mkdirSync(config.outboxDir, { recursive: true });
  const file = path.join(config.outboxDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_notify_${fileTag}.eml`);
  fs.writeFileSync(file, info.message as Buffer);
  return file;
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
  const object = { type: "decision" as const, id: String(d.id), label: d.title };
  try {
    const file = await sendNotice(subject, body, `decision-${d.id}`);
    kv.set(key, new Date().toISOString());
    logEvent({ actor: "system", action: "notify.sent", object,
      summary: file ? `I put a notice for ${person} about "${d.title}" into the local outbox.` : `I told ${person} by mail that "${d.title}" waits for their approval (sent to ${to}).`,
      output: { to, for: person, role: next.role, subject, file } });
  } catch (e) {
    logEvent({ actor: "system", action: "notify.failed", object,
      summary: `I could not send the approval notice for "${d.title}" to ${person}: ${(e as Error).message.slice(0, 200)}`, output: { to, for: person } });
  }
}

let sending = false;

/**
 * Tell the person of every new open task about it by mail, once per task, with a link to the Tasks page.
 * Runs after each agent step. Never throws: a failed notice is logged and tried again on the next run.
 */
export async function notifyNewTasks(): Promise<number> {
  if (!config.notify.to || sending) return 0;
  sending = true;
  let sent = 0;
  try {
    for (const t of all<TaskDb>("SELECT * FROM tasks WHERE notified_at IS NULL AND status = 'open' ORDER BY id")) {
      const person = t.person ?? t.role;
      const link = `${config.notify.appUrl.replace(/\/$/, "")}/tasks?item=task-${t.id}`;
      const subject = `New task for ${person}: ${t.title}`;
      const body = [
        `Hello ${person},`,
        "",
        `the procurement agents need something from you (${t.role}):`,
        "",
        t.title,
        "",
        t.body.trim(),
        "",
        `See the task and its state here: ${link}`,
        "",
        `Hackathon note: this mail is meant for ${person} (${t.role}) and goes to ${config.notify.to} instead.`,
        "",
        config.mail.fromName,
      ].join("\n");
      const object = { type: "task" as const, id: String(t.id), label: t.title };
      try {
        const file = await sendNotice(subject, body, `task-${t.id}`);
        run("UPDATE tasks SET notified_at = ? WHERE id = ?", new Date().toISOString(), t.id);
        sent++;
        logEvent({ actor: "system", action: "notify.task", object,
          summary: file ? `I put a mail for ${person} about the task "${t.title}" into the local outbox.` : `I told ${person} by mail about the new task "${t.title}" (sent to ${config.notify.to}).`,
          output: { to: config.notify.to, for: person, role: t.role, task_id: t.id, subject, file } });
      } catch (e) {
        logEvent({ actor: "system", action: "notify.failed", object,
          summary: `I could not tell ${person} about the task "${t.title}": ${(e as Error).message.slice(0, 200)}`, output: { to: config.notify.to, for: person, task_id: t.id } });
        break; // the mail server is not answering: try the rest on the next run
      }
    }
  } finally {
    sending = false;
  }
  return sent;
}
