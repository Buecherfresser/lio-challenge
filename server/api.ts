import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.ts";
import { factsById, factsOf } from "./facts.ts";
import { listEvents } from "./events.ts";
import { pastView } from "./db.ts";
import { listHistory, openPast } from "./history.ts";
import { runAction, runCycle, runData, runRisk, runSync, status } from "./pipeline.ts";
import { dataApi } from "./api/data.ts";
import { riskApi } from "./api/risk.ts";

export const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse(); // e.g. 401 from the login
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// For the container health check. Answers without a password.
app.get("/healthz", (c) => c.text("ok"));

// On a public server APP_PASSWORD puts the whole dashboard and API behind a login. Locally it stays open.
if (config.appPassword) app.use("*", basicAuth({ username: config.appUser, password: config.appPassword }));

const api = new Hono();

// What can be looked at again: the events since the first full reading, each with its recorded moments.
api.get("/history", (c) => c.json(listHistory()));

// ?at=<moment id> answers any read with the state of that moment. Nothing can be changed there.
api.use("*", async (c, next) => {
  const at = c.req.query("at");
  if (!at) return next();
  const view = openPast(Number(at));
  if (!view) return c.json({ error: "That moment is not on record." }, 404);
  if (c.req.method !== "GET") return c.json({ error: "You are looking at the past. Go back to live to change something." }, 409);
  return pastView.run(view, () => next());
});

api.get("/status", (c) => c.json(status()));

api.get("/events", (c) => {
  const q = c.req.query();
  return c.json(listEvents({
    actor: q.actor || undefined, object_type: q.object_type || undefined, object_id: q.object_id || undefined, q: q.q || undefined,
    limit: q.limit ? Number(q.limit) : undefined, before_id: q.before_id ? Number(q.before_id) : undefined,
  }));
});

api.get("/facts", (c) => {
  const { object_type, object_id, ids } = c.req.query();
  if (ids) return c.json(factsById(ids.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500)));
  if (!object_type || !object_id) return c.json({ error: "object_type and object_id, or ids, are required" }, 400);
  return c.json(factsOf(object_type, object_id).reverse().slice(0, 500));
});

// Starts a step in the background and returns at once. The dashboard follows progress through /status and /events.
api.post("/run/:what", (c) => {
  const what = c.req.param("what");
  const jobs: Record<string, () => Promise<unknown>> = {
    sync: () => runSync(), "data-agent": () => runData(), "risk-agent": () => runRisk(true), "action-agent": () => runAction(), all: () => runCycle(),
  };
  const job = jobs[what];
  if (!job) return c.json({ error: `unknown step ${what}` }, 404);
  void job();
  return c.json({ started: true });
});

api.post("/replay/next", (c) => {
  if (config.source !== "replay") return c.json({ error: "The app runs on the live portal. Set SOURCE=replay to step through stored snapshots." }, 400);
  void runCycle({ advanceReplay: true });
  return c.json(status());
});

api.route("/", dataApi);
api.route("/", riskApi);
api.all("*", (c) => c.json({ error: "not found" }, 404));

app.route("/api", api);

// The built dashboard, served from the same port.
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", json: "application/json", woff2: "font/woff2", map: "application/json", txt: "text/plain" };
app.get("*", (c) => {
  const root = config.webDist;
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
  let file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  if (!fs.existsSync(file)) return c.text("The dashboard is not built yet. Run: npm run web:build", 404);
  const ext = file.split(".").pop() ?? "";
  return c.body(fs.readFileSync(file), 200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
});
