# 1e16

1e16 tells Soony's procurement team about supply problems before the supplier does, and hands them decisions with a price instead of more tables. It watches Soony's supplier portal, reads every document into one table of facts, and works out how many copies of Grand Heist 6 will be packed in Hamburg by Sunday 22 Nov, 20:00.

The name comes from our team: 10^16 watts is roughly all the sunlight that reaches Earth, the energy of a civilization that uses its whole planet. The dashboard takes it from `web/src/lib/config.ts`.

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

- The portal token. 1e16 reads `BEARER` from `../lio-key.env`, or `LIO_TOKEN` from `app/.env`.
- Your OpenAI key. Put `OPENAI_API_KEY=...` into `app/.env`. Without it 1e16 still syncs, loads the base data and checks the rules, but documents wait unread and the risk and action agents stay off.

`.env.example` lists every setting with its default.

## What happens in one cycle

Every 3 minutes 1e16 runs these steps in order. "Sync now" in the dashboard starts a cycle at once.

1. **Sync** (code only). It asks the portal for the file list and compares checksums with the last snapshot. New and replaced files become events. Every sync is stored as a complete version in `data/archive` and is never deleted.
2. **Base data** (code only). Master data, purchase orders from both exports, goods receipts, stock, shipments and the pack-out log are loaded into tables.
3. **Data agent**. A reading agent works through every new or changed document and every received mail, one at a time. It looks things up in Soony's data, records facts (code checks each one and tells the agent at once when one does not fit), keeps notes per supplier and part, and writes down questions. Soony's own files come first, then each supplier's files in order, suppliers in parallel. Rules then compare the facts with what Soony expects. Once nothing new is left to read, a clarification round turns all open issues into one mail per supplier in the supplier's language, one task per role at Soony, or closes them.
4. **Risk agent**. It connects facts that single rules miss and reports risks. It states what could go wrong, and code works out how many copies that costs.
5. **Action agent**. One agent works through each open risk where something changed since it last looked: a new risk, a supplier's answer, a decision, an overdue answer. It looks for the way out, checks it against the other facts, asks the supplier what is missing, and hands a decision card to the person who has to approve it. After the approval it sends the order and follows up until the supply is confirmed.

The rule behind steps 4 and 5: the model thinks, the code computes. Quantities, copies, their value, costs, deadlines and approvers always come from code.

## What the action agent may do on its own

The tool it calls decides, not its wording.

- **Asking is free.** A question to a supplier or a colleague leaves without a click. Three rules are enforced in code, because a mail costs the other side attention: questions are collected and leave as one mail per supplier at the end of a pass, the same thing is never asked twice (a question that is out or answered is refused, with the answer), and there is one reminder before the matter goes on inside the company.
- **Anything that binds the company is a decision card.** An order, an accepted offer, a freight booking, a quality release. The card names who signs under the approval policy, also when two people sign or the role is vacant.
- **The dial.** On the History page you set an amount below which the agent carries out an order or a freight booking itself and reports it (`AUTONOMY_LIMIT_EUR`, default 0 = never). Quality releases and exceptions always need a person.

An approved decision counts in the numbers at once: its supply shows as uncertain until it is in the building, and its route shows on the map.

## The dashboard

There are two views. A switch at the top changes between them.

**Management** (`/`, for the head of procurement) shows one number, how many copies are ready by the deadline, split into safe, uncertain and lost. Under the number stands what the lost copies cost. Below it is the map, and one line appears when a decision waits for approval. There is no sidebar, no agent status and no lists.

**Buyer** (`/buyer` and every page below) is the workspace. Its sidebar is a rail of icons that opens over the page on hover; the button in the header pins it open.

- **Overview**: only what is urgent. The items due in the next 24 hours, one number per edition (a click shows the breakdown and the bottleneck), and one link each to the to-do list, the parts and what the agents handle on their own.
- **To do**: everything that waits for a person, one line per item, grouped by priority (urgent, important, normal, later) and within a group by deadline. Agents set the priority (`priority` on decisions, mails and tasks). While they have not, a decision due within two hours counts as urgent, any other open decision as important, and mails and tasks as normal. Decisions, mails to release and tasks sit in it side by side, with a filter by kind and by person. A click opens the item in a side panel with its buttons at the top.
  A decision shows the copies it saves, the cost, the time by which to decide and who signs, then the buttons, then the problem and what happens after approval. What the agent looked at, what is agreed with the supplier, the options it ruled out and how cost and deadline are worked out are folded below.
- **Supply**: every part with what is needed, what is safe, what may still come and the gap. A switch shows the same parts on the map. A click on a part opens its sources (each with its documents folded), contradictions, open questions and history.
- **Mail**: every conversation per supplier or person. It opens on the mails that wait for approval. Supplier mails show the original next to the English version.
- **History**: what the agents are doing right now, the dial for what they may order on their own, then every step of every agent in one sentence, with the model, tokens and cost. Sync now sits in the header of every page.

The map shows only critical supply, which means shipments that carry a part with the status uncertain or lost. Parts that are on track appear in the list next to the map. Ships, planes and trucks sit where they probably are now. That position comes from the last tracked position, or from departure and arrival time along a real shipping lane or flight path. A click on a vehicle shows its arrival, quantity and goods value. When a risk assumes a shipment does not make it, its route is crossed out, and the replacement route from a decision card is drawn in blue: dashed while the decision is pending, solid once it is approved.

## Safe, uncertain, lost

- **Safe**: the parts are in the building and usable.
- **Uncertain**: the copies depend on something that is not confirmed yet, such as a lot on quality hold, a shipment that is due before the deadline, or a part with no stock record at all.
- **Lost**: the parts cannot be on the line before the deadline as things stand.

An arrival date without a time counts as the end of that day, which is the careful reading. You change that with `ETA_DATE_ONLY_TIME`.

## Mail

The suppliers in the challenge are played by AI agents that answer real e-mail. Their addresses are in the supplier profiles. The portal has no mail endpoint, so 1e16 sends and receives through an ordinary mailbox:

1. Take a mailbox with SMTP and IMAP access, for example a Gmail account with an app password.
2. Register its address in the portal under Settings. Suppliers do not answer other senders.
3. Set in `app/.env`: `MAIL_MODE=live`, `MAIL_FROM`, `MAIL_ALLOWED_SENDERS`, and the `SMTP_*` and `IMAP_*` settings.

1e16 checks the mailbox every two minutes and reads replies like any other source. While `MAIL_MODE=outbox`, which is the default, outgoing mail is written to `data/outbox` as files instead.

Questions to suppliers go out without a click. Set `AUTO_SEND_CLARIFICATIONS=false` to hold them in the inbox under "Needs approval" until you click Send. Approving a decision card sends its mail (`SEND_ON_APPROVAL=false` holds it in the inbox instead).

What a copy is worth comes from `VALUE_PER_COPY_EUR` (per product id). Without it the cards show copies only.

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
| `server/agents` | Data agent, risk agent, action agent (`action.ts`), its questions (`questions.ts`) and the read tools the agents share (`tools.ts`) |
| `server/compute` | The tools that count: parts, copies per edition, what-if, supplier reliability, approvals, the value of copies and what waiting costs (`value.ts`) |
| `server/mail` | Sending, outbox, mailbox polling |
| `prompts` | The agents' task prompts, free of anything customer specific, and `customer.md` with what the agents know about the customer |
| `.claude/skills/writing-style` | The writing style. Coding agents use it as a skill, and the app appends it to every agent prompt |
| `shared/api.ts` | The types and routes the dashboard and the backend share |
| `web` | The dashboard |
| `data` | Working database, archive and outbox (not in version control) |

For development, `npm run dev` restarts the backend on changes and `npm run web:dev` serves the dashboard on http://localhost:5173.
