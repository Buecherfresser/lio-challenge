# Lineguard

Lineguard tells Soony's procurement team about supply problems before the supplier does, and hands them decisions with a price instead of more tables. It watches Soony's supplier portal, reads every document into one table of facts, and works out how many copies of Grand Heist 6 will be packed in Hamburg by Sunday 22 Nov, 20:00.

"Lineguard" is a working title. You change it in `web/src/lib/config.ts`.

## Run it

You need Node 24 or newer.

```bash
cd app
npm install
npm --prefix web install
npm run web:build
npm start
```

Then open http://localhost:8787.

Two settings matter before the first start:

- The portal token. Lineguard reads `BEARER` from `../lio-key.env`, or `LIO_TOKEN` from `app/.env`.
- Your OpenAI key. Put `OPENAI_API_KEY=...` into `app/.env`. Without it Lineguard still syncs, loads the base data and checks the rules, but documents wait unread and the risk and action agents stay off.

`.env.example` lists every setting with its default.

## What happens in one cycle

Every 3 minutes Lineguard runs these steps in order. "Sync now" in the dashboard starts a cycle at once.

1. **Sync** (code only). It asks the portal for the file list and compares checksums with the last snapshot. New and replaced files become events. Every sync is stored as a complete version in `data/archive` and is never deleted.
2. **Base data** (code only). Master data, purchase orders from both exports, goods receipts, stock, shipments and the pack-out log are loaded into tables.
3. **Data agent**. A reading agent works through every new or changed document and every received mail, one at a time. It looks things up in Soony's data, records facts (code checks each one and tells the agent at once when one does not fit), keeps notes per supplier and part, and writes down questions. Soony's own files come first, then each supplier's files in order, suppliers in parallel. Rules then compare the facts with what Soony expects. Once nothing new is left to read, a correspondence round turns all open issues into one mail per supplier in the supplier's language, one task per role at Soony, or closes them.
4. **Risk agent**. It connects facts that single rules miss and reports risks. It states what could go wrong, and code works out how many copies that costs.
5. **Action agent** (a mock for now). It turns each risk into decision cards: the option, copies saved, cost, who approves under policy PP-07, and a mail draft. Nothing leaves the building. Approve and Reject change the status and are logged.

The rule behind steps 4 and 5: the model thinks, the code computes. Quantities, copies, costs and approvers always come from code.

## The dashboard

- **Overview**: per edition one number, split into safe, uncertain and lost, plus the decisions waiting for you.
- **Parts**: every part with its status. A click opens the sources, contradictions, open questions and history.
- **Approvals**: decision cards with Approve and Reject.
- **Inbox**: mails and tasks from agents and people, per supplier or person. Supplier mails show the original next to the English version.
- **Log**: every step of every agent in one sentence, with the model, tokens and cost.

## Safe, uncertain, lost

- **Safe**: the parts are in the building and usable.
- **Uncertain**: the copies depend on something that is not confirmed yet, such as a lot on quality hold, a shipment that is due before the deadline, or a part with no stock record at all.
- **Lost**: the parts cannot be on the line before the deadline as things stand.

An arrival date without a time counts as the end of that day, which is the careful reading. You change that with `ETA_DATE_ONLY_TIME`.

## Mail

The suppliers in the challenge are played by AI agents that answer real e-mail. Their addresses are in the supplier profiles. The portal has no mail endpoint, so Lineguard sends and receives through an ordinary mailbox:

1. Take a mailbox with SMTP and IMAP access, for example a Gmail account with an app password.
2. Register its address in the portal under Settings. Suppliers do not answer other senders.
3. Set in `app/.env`: `MAIL_MODE=live`, `MAIL_FROM`, `MAIL_ALLOWED_SENDERS`, and the `SMTP_*` and `IMAP_*` settings.

Lineguard checks the mailbox every two minutes and reads replies like any other source. While `MAIL_MODE=outbox`, which is the default, outgoing mail is written to `data/outbox` as files instead.

Mails wait in the inbox under "Needs approval" until you click Send. Set `AUTO_SEND_CLARIFICATIONS=true` to send them without a click.

## Replay

Replay runs the app from stored snapshots, for development and as a backup for the demo.

```bash
rm data/app.db*
SOURCE=replay npm start
```

The dashboard then shows "Next snapshot", which loads the next stored state of the portal. `data/archive` stays untouched. To put a local copy of the portal into the archive as a snapshot, run:

```bash
node server/cli.ts import-folder ../soony-data
```

## Where things live

| Folder | What is in it |
|---|---|
| `server/sync` | Sync, snapshots, replay |
| `server/ingest` | Loaders for the base tables |
| `server/agents` | Data agent, risk agent, action agent |
| `server/compute` | The tools that count: parts, copies per edition, what-if, supplier reliability, approvals |
| `server/mail` | Sending, outbox, mailbox polling |
| `prompts` | The agents' task prompts, free of anything customer specific, and `customer.md` with what the agents know about the customer |
| `.claude/skills/writing-style` | The writing style. Coding agents use it as a skill, and the app appends it to every agent prompt |
| `shared/api.ts` | The types and routes the dashboard and the backend share |
| `web` | The dashboard |
| `data` | Working database, archive and outbox (not in version control) |

For development, `npm run dev` restarts the backend on changes and `npm run web:dev` serves the dashboard on http://localhost:5173.
