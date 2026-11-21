import { serve } from "@hono/node-server";
import { config } from "./config.ts";
import { app } from "./api.ts";
import { startScheduler, stopPipeline } from "./pipeline.ts";
import { logEvent } from "./events.ts";
import { llmAvailable } from "./llm.ts";

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logEvent({
    actor: "system", action: "server.started",
    summary: `I started on port ${info.port}, reading from the ${config.source === "live" ? "live portal" : "stored snapshots"}, with outgoing mail going to ${config.mail.mode === "outbox" ? "the local outbox" : "the mail server"}${llmAvailable() ? "" : " and without an OpenAI key, so documents wait to be read"}.`,
    output: { source: config.source, mail: config.mail.mode, llm: llmAvailable(), deadline: config.deadline },
  });
  // SCHEDULER=off serves the dashboard and API only, for looking at a data folder without changing it.
  if (process.env.SCHEDULER !== "off") startScheduler();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopPipeline(); process.exit(0); });
