import path from "node:path";
import { importFolder, syncLive, applySnapshot } from "./sync/sync.ts";
import { loadBase } from "./ingest/base.ts";
import { all } from "./db.ts";

// Small command line helpers. The server (main.ts) does the same things on a schedule.
const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith("--"));
const args = rest.filter((a) => !a.startsWith("--"));

if (cmd === "import-folder") {
  // node server/cli.ts import-folder ../soony-data [ISO time] : archive a local copy as a snapshot (does not apply it)
  const snap = importFolder(path.resolve(args[0] ?? "../soony-data"), args[1]);
  console.log(`Archived snapshot ${snap.id} (${snap.file_count} files, taken ${snap.taken_at}).`);
  if (flags.includes("--apply")) { applySnapshot(snap, "import"); console.log(loadBase().loaded.length, "base files loaded"); }
} else if (cmd === "sync") {
  const r = await syncLive();
  const base = loadBase();
  console.log(`Sync ${r.sync_id}: ${r.added.length} new, ${r.changed.length} replaced, ${r.removed.length} removed. ${base.loaded.length} base files loaded, ${base.facts} new facts.`);
  if (base.needsMapping.length) console.log("Needs column mapping:", base.needsMapping.map((x) => x.doc.path));
  console.log(all("SELECT handler, status, COUNT(*) AS n FROM documents WHERE current = 1 GROUP BY 1, 2"));
} else if (cmd === "snapshots") {
  const { distinctSnapshots } = await import("./sync/archive.ts");
  for (const s of distinctSnapshots()) console.log(`${s.id}\t${s.taken_at}\t${s.origin}\t${s.file_count} files`);
} else if (cmd === "data-agent") {
  // node server/cli.ts data-agent [--limit=20] : one pass of the data agent (read documents and mails, check rules, write questions)
  const { runDataAgent } = await import("./agents/data/index.ts");
  const limit = flags.find((f) => f.startsWith("--limit="))?.split("=")[1];
  const perLane = flags.find((f) => f.startsWith("--per-lane="))?.split("=")[1];
  console.log(await runDataAgent({ limit: limit !== undefined ? Number(limit) : undefined, perLane: perLane !== undefined ? Number(perLane) : undefined, clarify: flags.includes("--clarify"), mailsOnly: flags.includes("--mails") }));
} else if (cmd === "inbound") {
  // node server/cli.ts inbound <supplier id> <subject> <file with the body> : store a received mail, as if it came in by IMAP
  const { recordInbound } = await import("./mail/inbox.ts");
  const fs = await import("node:fs");
  console.log(recordInbound({ supplier_id: args[0], subject: args[1], body: fs.readFileSync(args[2], "utf8") }));
} else if (cmd === "rules") {
  // node server/cli.ts rules [--dry] : check for deviations without a model. --dry prints them and writes nothing
  const { findDeviations, runRules } = await import("./agents/data/rules.ts");
  if (flags.includes("--dry")) for (const x of findDeviations()) console.log(`[${x.type}] ${x.title}\n    ${x.detail}\n    expected: ${x.expected ?? "-"} | actual: ${x.actual ?? "-"}\n`);
  else { const r = runRules(); console.log(`${r.opened.length} opened, ${r.reopened.length} reopened, ${r.updated.length} updated, ${r.resolved.length} resolved, ${r.open_total} not cleared.`); }
} else if (cmd === "issues") {
  for (const i of all<{ id: number; type: string; status: string; title: string }>("SELECT id, type, status, title FROM issues ORDER BY status, type, id")) console.log(`${i.id}\t${i.status}\t${i.type}\t${i.title}`);
} else if (cmd === "retry-failed") {
  // Put documents a model could not read back into the queue.
  const { run } = await import("./db.ts");
  console.log(run("UPDATE documents SET status = 'pending', error = NULL WHERE handler = 'openai' AND current = 1 AND status = 'failed'").changes, "documents back in the queue");
} else if (cmd === "bootstrap-export") {
  // node server/cli.ts bootstrap-export <file> : write everything a model has read out of the documents to one file
  if (!args[0]) throw new Error("Usage: bootstrap-export <file>");
  const { bootstrapExport } = await import("./agents/data/bootstrap.ts");
  const r = bootstrapExport(path.resolve(args[0]));
  console.log(`Wrote ${r.documents} documents with ${r.facts} facts to ${path.resolve(args[0])}.`);
} else if (cmd === "bootstrap-import") {
  // node server/cli.ts bootstrap-import <file> : use stored readings for waiting documents with the same content, without a model
  if (!args[0]) throw new Error("Usage: bootstrap-import <file>");
  const { bootstrapImport } = await import("./agents/data/bootstrap.ts");
  const r = bootstrapImport(path.resolve(args[0]));
  console.log(`Loaded stored readings for ${r.documents} documents (${r.facts} new facts). ${r.not_matching} entries in the file match no waiting document.`);
} else if (cmd === "risk-agent") {
  const { runRiskAgent } = await import("./agents/risk.ts");
  console.log(await runRiskAgent({ force: flags.includes("--force") }));
} else if (cmd === "action-agent") {
  const { runActionAgent } = await import("./agents/action.ts");
  console.log(await runActionAgent({ force: flags.includes("--force") }));
} else {
  console.log("Commands: import-folder <dir> [time] [--apply], sync, snapshots, risk-agent [--force], action-agent [--force], data-agent [--limit=N] [--per-lane=N] [--clarify] [--mails], inbound <supplier> <subject> <body file>, rules [--dry], issues, retry-failed, bootstrap-export <file>, bootstrap-import <file>");
}
