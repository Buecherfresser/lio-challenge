import type { Status } from "@shared/api.ts"

export const AGENTS: { key: keyof Status["running"]; label: string }[] = [
  { key: "sync", label: "Sync" },
  { key: "data_agent", label: "Data agent" },
  { key: "risk_agent", label: "Risk agent" },
  { key: "action_agent", label: "Action agent" },
]

/** The agents that run right now, by name. Empty when all are idle. */
export function runningAgents(status: Status | undefined): string[] {
  return status ? AGENTS.filter((agent) => status.running[agent.key]).map((agent) => agent.label) : []
}
