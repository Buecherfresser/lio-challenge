import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { Actor, Message } from "../../shared/api.ts";
import { config } from "../config.ts";
import { get, run } from "../db.ts";
import { nowIso } from "../clock.ts";
import { logEvent } from "../events.ts";
import { toMessage } from "../agents/data/rows.ts";
import type { MessageDb } from "../agents/data/rows.ts";

// Outgoing mail. One switch decides where it goes:
//   MAIL_MODE=outbox  every mail is written to data/outbox as an .eml file (development, demo without a mail server)
//   MAIL_MODE=live    it is sent over SMTP, and only from an address that is registered as sender
// Every send, and every refusal, is logged.

const ACTORS: Actor[] = ["sync", "data_agent", "risk_agent", "action_agent", "human", "system"];
const actorOf = (by: string): Actor => (ACTORS.includes(by as Actor) ? (by as Actor) : "human");
const address = (name: string, addr: string) => (name ? { name, address: addr } : addr);
const safe = (s: string) => s.replace(/[^a-zA-Z0-9@._-]+/g, "_").slice(0, 60);

export const loadMessage = (id: number): MessageDb | undefined => get<MessageDb>("SELECT * FROM messages WHERE id = ?", id);

/** Whether mail may leave from this address. */
export const senderAllowed = (addr: string) => config.mail.allowedSenders.includes(addr.trim().toLowerCase());

function refuse(m: MessageDb | undefined, id: number, by: string, reason: string): never {
  logEvent({ actor: actorOf(by), action: "mail.refused", object: { type: "message", id: String(id), label: m?.subject },
    summary: `I did not send the mail${m ? ` "${m.subject}" to ${m.to_addr || "an unknown address"}` : ` ${id}`}: ${reason}`, input: { message_id: id, by, mode: config.mail.mode }, output: { reason } });
  throw new Error(reason);
}

/**
 * Send a stored message. In outbox mode it is written to a file and marked `outbox`, in live mode it goes out
 * over SMTP and is marked `sent`. Throws with a clear reason if it cannot go out. The message then stays as it was.
 */
export async function sendMessage(messageId: number, by: string): Promise<Message> {
  const m = loadMessage(messageId);
  if (!m) refuse(m, messageId, by, "There is no such message.");
  if (m.direction !== "out") refuse(m, messageId, by, "This is a received mail. It cannot be sent.");
  if (m.status === "sent" || m.status === "outbox") refuse(m, messageId, by, "This mail has already gone out.");
  if (m.status === "rejected") refuse(m, messageId, by, "This mail was rejected. It is not sent.");
  if (!m.to_addr.trim()) refuse(m, messageId, by, "The mail has no recipient address.");

  const from = (m.from_addr || config.mail.from).trim();
  const live = config.mail.mode === "live";
  if (live) {
    if (!from) refuse(m, messageId, by, "No sender address is set (MAIL_FROM).");
    if (!senderAllowed(from)) refuse(m, messageId, by, `${from} is not a registered sender (MAIL_ALLOWED_SENDERS), so the mail stays here.`);
    if (!config.mail.smtp.host || !config.mail.smtp.user || !config.mail.smtp.pass) refuse(m, messageId, by, "The mail server is not set up (SMTP_HOST, SMTP_USER, SMTP_PASS).");
  }

  // Answer in the thread if the other side wrote last.
  const lastIn = get<{ external_id: string | null }>("SELECT external_id FROM messages WHERE thread_id = ? AND direction = 'in' AND external_id IS NOT NULL AND external_id NOT LIKE 'dev-%' ORDER BY id DESC LIMIT 1", m.thread_id);
  const mail = {
    from: address(config.mail.fromName, from || "outbox@localhost"),
    to: m.to_addr,
    subject: m.subject,
    text: m.body_original,
    ...(lastIn?.external_id ? { inReplyTo: lastIn.external_id, references: lastIn.external_id } : {}),
  };

  let externalId: string | null = null;
  let file: string | null = null;
  try {
    if (live) {
      const smtp = nodemailer.createTransport({ host: config.mail.smtp.host, port: config.mail.smtp.port, secure: config.mail.smtp.port === 465, auth: { user: config.mail.smtp.user, pass: config.mail.smtp.pass } });
      const info = await smtp.sendMail(mail);
      externalId = info.messageId ?? null;
    } else {
      const info = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" }).sendMail(mail);
      externalId = info.messageId ?? null;
      fs.mkdirSync(config.outboxDir, { recursive: true });
      file = path.join(config.outboxDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${m.id}_${safe(m.to_addr)}.eml`);
      fs.writeFileSync(file, info.message as Buffer);
    }
  } catch (e) {
    refuse(m, messageId, by, `Sending failed: ${(e as Error).message}`);
  }

  const status = live ? "sent" : "outbox";
  // A Message-ID we have seen before (a resend of the same content) must not break the unique index.
  const taken = externalId ? get<{ id: number }>("SELECT id FROM messages WHERE external_id = ? AND id != ?", externalId, m.id) : undefined;
  run("UPDATE messages SET status = ?, sent_at = ?, from_addr = ?, external_id = COALESCE(?, external_id) WHERE id = ?", status, nowIso(), from, taken ? null : externalId, m.id);
  const unregistered = !live && Boolean(from) && !senderAllowed(from);
  logEvent({
    actor: actorOf(by), action: live ? "mail.sent" : "mail.outbox", object: { type: "message", id: String(m.id), label: m.subject },
    summary: live ? `I sent the mail "${m.subject}" to ${m.to_addr}.` : `I put the mail "${m.subject}" to ${m.to_addr} into the local outbox instead of sending it.`,
    input: { message_id: m.id, by, mode: config.mail.mode, from, to: m.to_addr, thread_id: m.thread_id, issue_ids: JSON.parse(m.issue_ids || "[]"), decision_id: m.decision_id },
    output: { status, message_id_header: externalId, file, ...(unregistered ? { note: `${from} is not a registered sender. In live mode this mail would be refused.` } : {}) },
  });
  return toMessage(loadMessage(m.id)!);
}
