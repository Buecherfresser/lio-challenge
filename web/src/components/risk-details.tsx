import type { Fact, Risk } from "@shared/api.ts"
import { FactSources } from "@/components/fact-source"
import { JsonBlock } from "@/components/json-block"
import { num, pct } from "@/lib/format"

/** What the risk agent found: explanation, numbers, the facts it cites and the tools it called. */
export function RiskDetails({ risk, facts, showTitle = false }: { risk: Risk; facts?: Fact[]; showTitle?: boolean }) {
  return (
    <div className="space-y-3 text-sm">
      {showTitle && <div className="font-medium">{risk.title}</div>}
      <p className="text-muted-foreground">{risk.explanation}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Copies at risk</dt>
          <dd className="font-medium tabular-nums">{num(risk.copies_at_risk)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Probability</dt>
          <dd className="font-medium tabular-nums">{pct(risk.probability)}</dd>
        </div>
        {risk.status !== "open" && (
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium">{risk.status}</dd>
          </div>
        )}
      </dl>
      {risk.fact_ids.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium">Facts it rests on</div>
          <FactSources factIds={risk.fact_ids} facts={risk.facts ?? facts} showValue />
        </div>
      )}
      {risk.tool_calls.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium">What the agent looked up</div>
          <ul className="space-y-1.5">
            {risk.tool_calls.map((call) => (
              <li key={call.id} className="rounded-md border px-2 py-1.5">
                <div className="font-mono text-xs">{call.name}</div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  <JsonBlock label="Arguments" value={call.args} />
                  <JsonBlock label="Result" value={call.result} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
