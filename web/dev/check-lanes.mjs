// Dev check: no lane edge may cross land (except the Suez Canal). Run: node dev/check-lanes.mjs
import { readFileSync } from "node:fs"
import { geoContains, geoInterpolate, geoDistance } from "d3-geo"
import { feature } from "topojson-client"
import { SEA_NODES, nearestNode, seaRoute } from "../src/lib/geo/sea-lanes.ts"

const topo = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/land-50m.json", import.meta.url)))
const land = feature(topo, topo.objects.land)
const src = readFileSync(new URL("../src/lib/geo/sea-lanes.ts", import.meta.url), "utf8")
const edges = [...src.matchAll(/\["([A-Z_]+)", "([A-Z_]+)"\]/g)].map((m) => [m[1], m[2]])
const canal = new Set(["PORT_SAID", "ISMAILIA", "BITTER_LAKE", "SUEZ", "HAM", "ELBE_A", "ELBE_B"])
let bad = 0
for (const [id, p] of Object.entries(SEA_NODES)) if (!canal.has(id) && geoContains(land, p)) { console.log("node on land", id); bad++ }
for (const [a, b] of edges) {
  if (canal.has(a) && canal.has(b)) continue
  const pa = SEA_NODES[a], pb = SEA_NODES[b]
  const n = Math.ceil(geoDistance(pa, pb) / 0.002)
  const at = geoInterpolate(pa, pb)
  const hits = []
  for (let k = 1; k < n; k++) { const q = at(k / n); if (geoContains(land, q)) hits.push(q.map((v) => v.toFixed(2)).join(",")) }
  if (hits.length) { console.log(`edge ${a}-${b} crosses land at ${hits.length} samples, e.g. ${hits[0]}`); bad++ }
}
console.log(bad ? `${bad} problems` : "lanes clear")
const P = { YTN: [114.27, 22.57], HAM: [9.97, 53.54], PUS: [129.04, 35.08], NSA: [72.95, 18.95], CPT: [18.43, -33.91], NYC: [-74.05, 40.67], RTM: [4.05, 51.95] }
for (const [a, b] of [["YTN", "HAM"], ["PUS", "HAM"], ["NSA", "HAM"], ["NYC", "HAM"], ["YTN", "CPT"], ["CPT", "HAM"]]) {
  const r = seaRoute(P[a], P[b])
  console.log(a, "->", b, nearestNode(P[a]).id, nearestNode(P[b]).id, r.length, "pts")
}
