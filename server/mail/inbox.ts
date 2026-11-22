import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Message } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, get, kv, run } from "../db.ts";
import { nowIso } from "../clock.ts";
import { logEvent } from "../events.ts";
import { toMessage } from "../agents/data/rows.ts";
import type { MessageDb } from "../agents/data/rows.ts";

// Incoming mail. Replies of suppliers arrive over IMAP, or are pasted through the dev endpoint.
// Both end in the same place: a row in messages with direction 'in' that the data agent then reads.

interface Inbound {
  from: string;
  from_name?: string | null;
  to: string;
  subject: string;
  body: string;
  external_id: string;          // Message-ID, or a generated id for pasted replies
  in_reply_to?: string | null;
  references?: string[];
  supplier_id?: string | null;  // known up front for pasted replies
  date?: string | null;         // when it was sent
  via: "imap" | "dev";
}

const normAddr = (a: string) => a.trim().toLowerCase();

function supplierByAddress(addr: string): { supplier_id: string; name: string; language: string | null } | undefined {
  return all<{ supplier_id: string; name: string; language: string | null; contact_email: string | null }>("SELECT supplier_id, name, language, contact_email FROM suppliers")
    .find((s) => s.contact_email && normAddr(s.contact_email) === normAddr(addr));
}

/** Store one incoming mail. Returns null if we already have it or if it belongs to nobody we know. */
function storeInbound(m: Inbound): MessageDb | null {
  if (get("SELECT 1 AS x FROM messages WHERE external_id = ?", m.external_id)) return null;
  let supplier = m.supplier_id ? get<{ supplier_id: string; name: string; language: string | null }>("SELECT supplier_id, name, language FROM suppliers WHERE supplier_id = ?", m.supplier_id) : supplierByAddress(m.from);
  let threadId = supplier ? `supplier:${supplier.supplier_id}` : null;
  let person: string | null = null;
  if (!threadId) {
    // Not a supplier address: it still belongs to us if it answers one of our mails.
    const refs = [m.in_reply_to, ...(m.references ?? [])].filter((x): x is string => Boolean(x));
    const parent = refs.length ? get<MessageDb>(`SELECT * FROM messages WHERE external_id IN (${refs.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`, ...refs) : undefined;
    if (!parent) return null;
    threadId = parent.thread_id;
    person = parent.person ?? m.from_name ?? m.from;
    if (parent.supplier_id) supplier = get<{ supplier_id: string; name: string; language: string | null }>("SELECT supplier_id, name, language FROM suppliers WHERE supplier_id = ?", parent.supplier_id);
  }
  const body = m.body.replace(/\r\n/g, "\n").trim();
  const id = run(
    `INSERT INTO messages (thread_id, direction, status, from_addr, to_addr, subject, language, body_original, body_en, supplier_id, person, created_by, issue_ids, external_id, in_reply_to, processed, created_at, sent_at)
     VALUES (?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 0, ?, ?)`,
    threadId, m.from, m.to, m.subject || "(no subject)", (supplier?.language ?? "en").toLowerCase(), body, body, supplier?.supplier_id ?? null, supplier ? null : person,
    m.via === "dev" ? "human" : "system", m.external_id, m.in_reply_to ?? null, nowIso(), m.date ?? nowIso()).lastId;
  logEvent({
    actor: m.via === "dev" ? "human" : "data_agent", action: "mail.received", object: { type: "message", id: String(id), label: m.subject },
    summary: m.via === "dev" ? `A reply from ${supplier?.name ?? m.from} was pasted in: "${m.subject}".` : `I received a mail from ${supplier?.name ?? m.from}: "${m.subject}".`,
    input: { via: m.via, from: m.from, message_id_header: m.external_id, in_reply_to: m.in_reply_to ?? null }, output: { message_id: id, thread_id: threadId, supplier_id: supplier?.supplier_id ?? null, characters: body.length },
  });
  return get<MessageDb>("SELECT * FROM messages WHERE id = ?", id) ?? null;
}

/** A reply pasted into the dashboard. Takes the same path as a mail from the mailbox, so the flow works without one. */
export function recordInbound(input: { supplier_id: string; subject: string; body: string }): Message {
  const sup = get<{ supplier_id: string; name: string; contact_email: string | null }>("SELECT supplier_id, name, contact_email FROM suppliers WHERE supplier_id = ?", String(input.supplier_id ?? "").trim());
  if (!sup) throw new Error(`Supplier ${input.supplier_id} is not in the vendor master.`);
  if (!String(input.body ?? "").trim()) throw new Error("The reply has no text.");
  const row = storeInbound({
    from: sup.contact_email ?? `${sup.supplier_id}@unknown`, to: config.mail.from || "procurement@localhost", subject: String(input.subject ?? "").trim() || "(no subject)", body: String(input.body),
    external_id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, supplier_id: sup.supplier_id, date: nowIso(), via: "dev",
  });
  if (!row) throw new Error("The reply could not be stored.");
  return toMessage(row);
}

/**
 * A colleague's answer that someone typed into the dashboard, for people who never open it (warehouse, logistics,
 * quality). It is stored like a received mail in that person's thread, so the data agent reads it like any other reply.
 */
export function recordColleagueReply(input: { person: string; subject: string; body: string; by: string }): Message {
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new Error("The answer has no text.");
  const id = run(
    `INSERT INTO messages (thread_id, direction, status, from_addr, to_addr, subject, language, body_original, body_en, supplier_id, person, created_by, issue_ids, external_id, processed, created_at, sent_at)
     VALUES (?, 'in', 'received', ?, ?, ?, 'en', ?, ?, NULL, ?, 'human', '[]', ?, 0, ?, ?)`,
    `person:${input.person}`, input.person, config.mail.from || "procurement@localhost", input.subject.trim() || "(no subject)", body, body, input.person,
    `colleague-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, nowIso(), nowIso()).lastId;
  logEvent({
    actor: "human", action: "mail.received", object: { type: "message", id: String(id), label: input.subject },
    summary: `${input.by} recorded what ${input.person} answered: "${input.subject}".`,
    input: { via: "dashboard", person: input.person, by: input.by }, output: { message_id: id, thread_id: `person:${input.person}`, characters: body.length },
  });
  return toMessage(get<MessageDb>("SELECT * FROM messages WHERE id = ?", id)!);
}

let saidNotConfigured = false;
let polling = false;

/** Fetch new mails from the mailbox. Does nothing, and says so once, when no mailbox is set up. */
export async function pollInbox(): Promise<{ imported: number; skipped: number }> {
  const { host, port, user, pass } = config.mail.imap;
  if (!host || !user || !pass) {
    if (!saidNotConfigured) {
      saidNotConfigured = true;
      logEvent({ actor: "data_agent", action: "mail.inbox_off", summary: "I do not check a mailbox because none is set up (IMAP_HOST, IMAP_USER, IMAP_PASS), so replies come in through the dashboard." });
    }
    return { imported: 0, skipped: 0 };
  }
  if (polling) return { imported: 0, skipped: 0 };
  polling = true;
  let imported = 0, skipped = 0;
  const client = new ImapFlow({ host, port, secure: port === 993, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const box = client.mailbox;
      const validity = box ? String(box.uidValidity) : "";
      // Remember how far we got. A mailbox that was rebuilt (new validity) is read again, duplicates are dropped by Message-ID.
      const state = JSON.parse(kv.get("imap_state") ?? "{}") as { validity?: string; lastUid?: number };
      const first = kv.get("imap_state") === null;
      let lastUid = state.validity === validity ? (state.lastUid ?? 0) : 0;
      // On the very first poll only look at the last days, not at the whole history of the mailbox.
      const uids = await client.search(first ? { since: new Date(Date.now() - 3 * 86_400_000) } : { uid: `${lastUid + 1}:*` }, { uid: true });
      const todo = (Array.isArray(uids) ? uids : []).filter((u) => u > lastUid).sort((a, b) => a - b);
      for (const uid of todo) {
        const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        lastUid = Math.max(lastUid, uid);
        if (!msg || !msg.source) { skipped++; continue; }
        const mail = await simpleParser(msg.source);
        const from = mail.from?.value?.[0];
        if (!from?.address) { skipped++; continue; }
        const to = Array.isArray(mail.to) ? mail.to[0]?.value?.[0]?.address : mail.to?.value?.[0]?.address;
        const stored = storeInbound({
          from: from.address, from_name: from.name || null, to: to ?? user, subject: mail.subject ?? "", body: mail.text ?? "",
          external_id: mail.messageId ?? `imap-${validity}-${uid}`, in_reply_to: mail.inReplyTo ?? null,
          references: typeof mail.references === "string" ? [mail.references] : (mail.references ?? []),
          date: mail.date ? mail.date.toISOString() : null, via: "imap",
        });
        if (stored) imported++; else skipped++;
      }
      kv.set("imap_state", JSON.stringify({ validity, lastUid }));
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    logEvent({ actor: "data_agent", action: "mail.inbox_failed", summary: `I could not read the mailbox: ${(e as Error).message.slice(0, 200)}`, output: { error: String((e as Error).message), host } });
    try { client.close(); } catch { /* already closed */ }
  } finally {
    polling = false;
  }
  if (imported || skipped) {
    logEvent({ actor: "data_agent", action: "mail.inbox_checked", summary: `I checked the mailbox and took in ${imported} new ${imported === 1 ? "mail" : "mails"}${skipped ? `, and left ${skipped} that are not from a supplier or are already here` : ""}.`, output: { imported, skipped } });
  }
  return { imported, skipped };
}
