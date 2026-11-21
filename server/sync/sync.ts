import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { all, get, kv, run, tx } from "../db.ts";
import { logEvent } from "../events.ts";
import { distinctSnapshots, getSnapshot, hasBlob, manifestOf, saveSnapshot, sha256, writeBlob } from "./archive.ts";
import type { ManifestFile, Snapshot } from "./archive.ts";
import { handlerFor } from "../ingest/base.ts";

// Deterministic. No model involved.
// 1. Ask the portal for the file list and compare checksums with the last snapshot.
// 2. Store the full state as a new snapshot in the archive.
// 3. Apply it to the working database: new and changed files become document versions and events.

export interface ChangedDoc { id: number; path: string; version: number; change: "added" | "changed"; handler: "code" | "openai" }
export interface SyncResult { sync_id: number; snapshot: Snapshot; added: ChangedDoc[]; changed: ChangedDoc[]; removed: string[]; first: boolean }

async function portal(p: string): Promise<Response> {
  if (!config.lio.token) throw new Error("No portal token. Set LIO_TOKEN in app/.env (or BEARER in ../lio-key.env).");
  const res = await fetch(config.lio.baseUrl + p, { headers: { Authorization: `Bearer ${config.lio.token}` } });
  if (!res.ok) throw new Error(`Portal returned ${res.status} for ${p}`);
  return res;
}
const encodePath = (p: string) => p.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

/** Poll the live portal, archive the state, apply it. */
export async function syncLive(): Promise<SyncResult> {
  const takenAt = new Date().toISOString();
  const data = (await (await portal("/api/v1/files")).json()) as { files: { path: string; bytes: number; sha256: string }[] };
  const files: ManifestFile[] = data.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));
  const missing = files.filter((f) => !hasBlob(f.sha256));
  await pool(missing, 8, async (f) => {
    const buf = new Uint8Array(await (await portal(`/api/v1/files/${encodePath(f.path)}`)).arrayBuffer());
    const got = writeBlob(buf);
    // The file may have been replaced between the listing and the download. Trust what we actually hold.
    if (got !== f.sha256) { f.sha256 = got; f.bytes = buf.length; }
  });
  const snap = saveSnapshot(takenAt, "live", files);
  return applySnapshot(snap, "live");
}

/** Archive a local copy of the portal (for example the folder downloaded at kickoff) as one snapshot. */
export function importFolder(dir: string, takenAt?: string, note?: string): Snapshot {
  const root = path.resolve(dir);
  const files: ManifestFile[] = [];
  let newest = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const buf = fs.readFileSync(p);
        writeBlob(buf);
        newest = Math.max(newest, fs.statSync(p).mtimeMs);
        files.push({ path: path.relative(root, p).split(path.sep).join("/"), sha256: sha256(buf), bytes: buf.length });
      }
    }
  };
  walk(root);
  return saveSnapshot(takenAt ?? new Date(newest || Date.now()).toISOString(), "import", files, note ?? `imported from ${root}`);
}

/** Replay mode: load the next stored snapshot. Returns null at the end of the timeline. */
export function replayNext(): SyncResult | null {
  const timeline = distinctSnapshots();
  const pos = Number(kv.get("replay_position") ?? "0");
  if (pos >= timeline.length) return null;
  const res = applySnapshot(timeline[pos], "replay");
  kv.set("replay_position", String(pos + 1));
  return res;
}
export function replayState(): { position: number; total: number } {
  return { position: Number(kv.get("replay_position") ?? "0"), total: distinctSnapshots().length };
}

interface DocRow { id: number; path: string; sha256: string; version: number; handler: "code" | "openai" }

/** Compare a snapshot with the current working state and record the differences. */
export function applySnapshot(snap: Snapshot, source: "live" | "replay" | "import"): SyncResult {
  const manifest = manifestOf(snap.manifest_sha);
  const current = new Map(all<DocRow>("SELECT id, path, sha256, version, handler FROM documents WHERE current = 1").map((d) => [d.path, d]));
  const first = !get("SELECT 1 AS x FROM syncs LIMIT 1");
  const added: ChangedDoc[] = [], changed: ChangedDoc[] = [], removed: string[] = [];

  const syncId = tx(() => {
    const sid = run("INSERT INTO syncs (at, world_at, snapshot_id, source, added, changed, removed) VALUES (?, ?, ?, ?, 0, 0, 0)", new Date().toISOString(), snap.taken_at, snap.id, source).lastId;
    const seen = new Set<string>();
    for (const f of manifest) {
      seen.add(f.path);
      const cur = current.get(f.path);
      if (cur && cur.sha256 === f.sha256) continue;
      const handler = handlerFor(f.path);
      if (cur) run("UPDATE documents SET current = 0 WHERE id = ?", cur.id);
      // A file can go back to content we have seen before. Then that version becomes current again.
      const again = get<DocRow>("SELECT id, path, sha256, version, handler FROM documents WHERE path = ? AND sha256 = ?", f.path, f.sha256);
      let doc: ChangedDoc;
      if (again) {
        run("UPDATE documents SET current = 1, removed_at = NULL WHERE id = ?", again.id);
        doc = { id: again.id, path: f.path, version: again.version, change: cur ? "changed" : "added", handler: again.handler };
      } else {
        const version = (get<{ v: number | null }>("SELECT MAX(version) AS v FROM documents WHERE path = ?", f.path)?.v ?? 0) + 1;
        const id = run("INSERT INTO documents (path, sha256, version, bytes, sync_id, seen_at, current, handler, status) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending')",
          f.path, f.sha256, version, f.bytes, sid, snap.taken_at, handler).lastId;
        doc = { id, path: f.path, version, change: cur ? "changed" : "added", handler };
      }
      (cur ? changed : added).push(doc);
    }
    for (const [p, cur] of current) {
      if (seen.has(p)) continue;
      run("UPDATE documents SET current = 0, removed_at = ? WHERE id = ?", snap.taken_at, cur.id);
      removed.push(p);
    }
    run("UPDATE syncs SET added = ?, changed = ?, removed = ? WHERE id = ?", added.length, changed.length, removed.length, sid);
    return sid;
  });

  kv.set("world_now", snap.taken_at);
  kv.set("last_sync", JSON.stringify({ at: snap.taken_at, snapshot_id: snap.id, added: added.length, changed: changed.length, removed: removed.length, source }));

  const total = added.length + changed.length + removed.length;
  if (first) {
    const perFolder: Record<string, number> = {};
    for (const d of added) { const k = d.path.split("/").slice(0, 2).join("/"); perFolder[k] = (perFolder[k] ?? 0) + 1; }
    logEvent({ actor: "sync", action: "sync.first", summary: `I took the first snapshot of the portal: ${added.length} files.`, input: { snapshot_id: snap.id, source }, output: { files_per_folder: perFolder } });
  } else if (total === 0) {
    logEvent({ actor: "sync", action: "sync.unchanged", summary: `I checked the portal and nothing changed (${manifest.length} files).`, input: { snapshot_id: snap.id, source } });
  } else {
    logEvent({ actor: "sync", action: "sync.completed", summary: `I found ${added.length} new, ${changed.length} replaced and ${removed.length} removed files in the portal.`,
      input: { snapshot_id: snap.id, source }, output: { added: added.map((d) => d.path), changed: changed.map((d) => d.path), removed } });
    for (const d of added) logEvent({ actor: "sync", action: "file.new", summary: `New file: ${d.path}.`, object: { type: "document", id: d.path }, output: { version: d.version } });
    for (const d of changed) logEvent({ actor: "sync", action: "file.replaced", summary: `${d.path} was replaced. This is version ${d.version}.`, object: { type: "document", id: d.path }, output: { version: d.version } });
    for (const p of removed) logEvent({ actor: "sync", action: "file.removed", summary: `${p} is gone from the portal.`, object: { type: "document", id: p } });
  }
  return { sync_id: syncId, snapshot: snap, added, changed, removed, first };
}

export { getSnapshot };
