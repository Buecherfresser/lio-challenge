# 1e16

**Live: https://procurement.jonasdrechsel.com** It runs on our own server in Nuremberg, Germany, and has been reading Soony's portal since Saturday.

**Our goal:** 1e16 finds a supply problem and starts solving it before the supplier mentions it.

## What our customers want and what we delivered

- **Just Act:** We hand over actions. Our agents find problems, research them and solve them. If a step needs approval, they send a mail.
- **Know first:** find a late delivery before the supplier reports it. Our agents connect all sources, warn early and act early.
- **Work for the next customer too:** a knowledge base holds each customer's contacts, products and deadlines, and adapters connect to their systems.

## Two moments from this weekend

- **Sun 00:15.** The agents found that a goods receipt for art books was booked as 80,000 pieces on an order of 8,000, so the Collector's Edition was short. A supplier in Poland had books in stock, but the order had to leave by 00:22. The mail went out at 00:19.
- **Sun 09:17.** A supplier sent a contract amendment with a new paragraph 4 that nobody had announced. Unnoticed, it would have cost USD 13,600. 1e16 read the redline like every other document and raised and solved it within minutes.

## How it works under the hood

1. **Sync** (code). It compares the checksums of every file in the portal with the last snapshot. Every state is archived.
2. **Data agent.** It reads each new document and mail, in any language, and records facts with their source. Rules then compare the sources and find what does not match. Open points go to the supplier in one mail, or to a colleague as a task.
3. **Risk agent.** It connects what single rules miss and says what could go wrong. Code calculates how much money is at risk.
4. **Action agent.** For each risk it looks for the way out, asks suppliers for what is missing, and prepares a decision. After the (sometimes necessary) approval it sends the order and follows up until the supply is confirmed.
