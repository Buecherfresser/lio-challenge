# 1e16

**Live: https://procurement.jonasdrechsel.com** (the login is in our submission). It runs on our own server in Nuremberg, Germany, and has been reading Soony's portal since Saturday.

**Our goal:** 1e16 tells a procurement team about a supply problem before the supplier does, and works on it until a person only has to sign.

Built by Jonas and Georg at START Hack Munich 2026 for the Lio challenge "Keep the Line Running". The name is 10^16 watts, roughly all the sunlight that reaches Earth.

## What Soony's team asked for

We talked to three groups at Soony. Each one changed what we built.

| Who | What they told us | What 1e16 does about it |
|---|---|---|
| Felix Brunner, Senior Buyer | He only uses a tool that tells him about a late delivery before the supplier does. Today they find out when something is missing at the end. | A risk agent connects facts from all sources and reports a risk with a probability while the supplier still says nothing. Code counts the copies it costs. |
| Dr. Maren Vogt, Head of Procurement | She has 40 dashboards and wants actions. The Collector's Edition comes first: a missed copy loses EUR 120 and the pre-order is refunded. The approval policy stays, but how much the agents may do alone should be a setting. Mail reaches her best. | An action agent hands over decision cards with the copies saved, the cost, the time to decide by and who signs. The limit up to which it orders alone is a setting. Whoever has to sign gets a mail. |
| IT | Hosting in the EU. SAP is central but cannot always be trusted, so ask the person. Most errors are human errors in the data. | Hosted in Germany. It reads both SAP exports, compares them with delivery notes, spreadsheets and supplier documents, and asks the responsible person by mail when they disagree. |

## Two moments from this weekend

- **Sun 00:15.** The agents found that a goods receipt for art books was booked as 80,000 pieces on an order of 8,000, so the Collector's Edition was short. A supplier in Poland had books in stock, but the order had to leave by 00:22. The mail went out at 00:19.
- **Sun 09:17.** A supplier sent a contract amendment with a new paragraph 4 that nobody had announced. Unnoticed, it would have cost USD 13,600. 1e16 read the redline like every other document and raised it within minutes.

## How it works

Every 3 minutes 1e16 runs one cycle:

1. **Sync** (code). It compares the checksums of every file in the portal with the last snapshot. Every state is archived.
2. **Data agent.** It reads each new document and mail, in any language, and records facts with their source. Rules then compare the sources and find what does not match. Open points go to the supplier in one mail, or to a colleague as a task.
3. **Risk agent.** It connects what single rules miss and says what could go wrong. Code works out how many copies that costs.
4. **Action agent.** For each risk it looks for the way out, asks what is missing, and prepares a decision card. After the approval it sends the order and follows up until the supply is confirmed.

Three rules hold it together:

- **The model thinks, the code computes.** Quantities, copies, their value, costs, deadlines and approvers always come from code.
- **Asking is free, binding needs a signature.** A question leaves without a click. An order, a freight booking or a quality release waits for the person the customer's approval policy names.
- **Everything can be looked at again.** The time bar shows the whole product as it was at an earlier moment, step by step.

## Not only Soony

The agents' prompts and tools know nothing about Soony. What is specific to a customer sits in three places:

- `prompts/customer.md`: what the agents should know about the company and its people.
- `.env`: deadline, shifts, what a copy is worth, mailbox (see `.env.example`).
- `server/adapters`: one small file per portal that says which file fills which table. `soony.ts` is Soony's.

The approval policy, the organisation chart and the supplier contacts are read from the customer's own documents.

## Run it

You need Node 24 or newer, the portal token and a model key.

```bash
cp .env.example .env
npm install
npm --prefix web install
npm run web:build
npm start
```

Then open http://localhost:8787. Set `LIO_TOKEN` and `OPENAI_API_KEY` in `.env` first. Mail stays in `data/outbox` until `MAIL_MODE=live`. With Docker, `docker compose up -d --build` does the same on port 8101.

| Folder | What is in it |
|---|---|
| `server/agents` | Data agent, risk agent, action agent |
| `server/compute` | Everything that is counted: parts, copies, what-if, approvals, value |
| `server/sync`, `server/ingest`, `server/adapters` | Portal sync, archive, base tables |
| `server/mail`, `server/history.ts` | Mailbox, and the recording behind the time bar |
| `prompts` | The agents' prompts and `customer.md` |
| `web` | The dashboard. `web/dev` is a test page for the map with sample data, the app never loads it |
| `deploy` | How it gets onto our server on every push to `main` |

## What is not built

- Nothing is written back to SAP. IT asked for it as a next step.
- Teams. Approvals go by mail.
- Automated tests. CI checks types and the build.
