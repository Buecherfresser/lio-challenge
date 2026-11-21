import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { archive } from "../db.ts";
import { config } from "../config.ts";

// The archive keeps every state of the portal we ever saw: one manifest per sync plus the file contents,
// stored once per SHA-256. Nothing in here is ever deleted. Replay mode reads from it.

export interface ManifestFile { path: string; sha256: string; bytes: number }
export interface Snapshot { id: number; taken_at: string; origin: "live" | "import"; manifest_sha: string; file_count: number; note: string | null }

const blobPath = (sha: string) => path.join(config.archiveDir, "blobs", sha.slice(0, 2), sha);

export const sha256 = (buf: Uint8Array) => crypto.createHash("sha256").update(buf).digest("hex");
export const hasBlob = (sha: string) => fs.existsSync(blobPath(sha));
export const readBlob = (sha: string): Uint8Array => fs.readFileSync(blobPath(sha));

export function writeBlob(buf: Uint8Array): string {
  const sha = sha256(buf);
  const p = blobPath(sha);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + ".tmp", buf);
    fs.renameSync(p + ".tmp", p);
  }
  return sha;
}

export function manifestSha(files: ManifestFile[]): string {
  const lines = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\t${f.sha256}`).join("\n");
  return crypto.createHash("sha256").update(lines).digest("hex");
}

/** Store one complete version of the portal. All blobs must already be in the archive. */
export function saveSnapshot(takenAt: string, origin: "live" | "import", files: ManifestFile[], note: string | null = null): Snapshot {
  const msha = manifestSha(files);
  const known = archive.prepare("SELECT 1 AS x FROM manifest_files WHERE manifest_sha = ? LIMIT 1").get(msha);
  archive.exec("BEGIN");
  try {
    if (!known) {
      const ins = archive.prepare("INSERT INTO manifest_files (manifest_sha, path, sha256, bytes) VALUES (?, ?, ?, ?)");
      for (const f of files) ins.run(msha, f.path, f.sha256, f.bytes);
    }
    const r = archive.prepare("INSERT INTO snapshots (taken_at, origin, manifest_sha, file_count, note) VALUES (?, ?, ?, ?, ?)").run(takenAt, origin, msha, files.length, note);
    archive.exec("COMMIT");
    return { id: Number(r.lastInsertRowid), taken_at: takenAt, origin, manifest_sha: msha, file_count: files.length, note };
  } catch (e) {
    archive.exec("ROLLBACK");
    throw e;
  }
}

export const getSnapshot = (id: number) => archive.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as unknown as Snapshot | undefined;
export const latestSnapshot = () => archive.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").get() as unknown as Snapshot | undefined;
export const manifestOf = (manifestShaValue: string) => archive.prepare("SELECT path, sha256, bytes FROM manifest_files WHERE manifest_sha = ? ORDER BY path").all(manifestShaValue) as unknown as ManifestFile[];

/** Snapshots in order, without consecutive repeats of the same state. This is the replay timeline. */
export function distinctSnapshots(): Snapshot[] {
  const rows = archive.prepare("SELECT * FROM snapshots ORDER BY taken_at, id").all() as unknown as Snapshot[];
  const out: Snapshot[] = [];
  for (const s of rows) if (!out.length || out[out.length - 1].manifest_sha !== s.manifest_sha) out.push(s);
  return out;
}
