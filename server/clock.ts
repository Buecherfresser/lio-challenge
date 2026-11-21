import { config } from "./config.ts";
import { kv } from "./db.ts";

/**
 * The time the app believes it is.
 * Live: real time. Replay: the time of the snapshot that is loaded. NOW in .env overrides both.
 */
export function now(): Date {
  if (config.fixedNow) return new Date(config.fixedNow);
  if (config.source === "replay") {
    const w = kv.get("world_now");
    if (w) return new Date(w);
  }
  return new Date();
}
export const nowIso = () => now().toISOString();

export function hoursBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

/** Packing hours between `from` and the deadline, per the configured shifts. */
export function packingHoursLeft(from: Date = now()): number {
  let h = 0;
  for (const s of config.shifts) {
    const start = Math.max(new Date(s.start).getTime(), from.getTime());
    const end = Math.min(new Date(s.end).getTime(), new Date(config.deadline).getTime());
    if (end > start) h += (end - start) / 3_600_000;
  }
  return h;
}
