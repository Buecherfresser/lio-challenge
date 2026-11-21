import { geoDistance } from "d3-geo"
import { type Coord, densifyGreatCircle, joinPaths } from "./coords.ts"

// A small graph of real shipping lanes. Ships follow it with shortest-path routing, so they never
// cross land. Nodes sit in open water off capes, in straits and at port approaches.

export const SEA_NODES = {
  // Elbe and North Sea
  HAM: [9.95, 53.54],
  ELBE_A: [9.45, 53.72],
  ELBE_B: [9.05, 53.9],
  ELBE_MOUTH: [8.3, 54.02],
  WESER: [8.25, 53.85],
  GERMAN_BIGHT: [6.5, 53.92],
  TEXEL: [4.25, 53.3],
  ROTTERDAM: [3.75, 52.0],
  SCHELDT: [3.3, 51.55],
  THAMES: [1.9, 51.75],
  DOVER: [1.5, 50.98],
  // Channel and Atlantic coast of Europe
  CHANNEL: [-1.0, 50.2],
  CHANNEL_W: [-4.0, 49.6],
  USHANT: [-5.9, 48.7],
  FINISTERRE: [-10.0, 43.4],
  ROCA: [-10.0, 38.9],
  ST_VINCENT: [-9.4, 36.6],
  // Mediterranean
  GIBRALTAR_W: [-6.4, 35.9],
  GIBRALTAR: [-5.55, 35.96],
  ALBORAN: [-3.0, 36.05],
  WMED_A: [1.0, 37.3],
  WMED_B: [6.0, 37.6],
  GULF_OF_LION: [5.0, 42.6],
  LIGURIAN: [8.5, 43.3],
  SARDINIA_S: [9.0, 38.0],
  SICILY_STRAIT: [11.7, 37.35],
  MALTA: [14.4, 35.5],
  IONIAN: [19.0, 35.0],
  KYTHIRA: [23.1, 36.0],
  AEGEAN_S: [24.0, 36.3],
  CRETE_S: [24.0, 34.3],
  KASOS: [26.7, 35.2],
  PORT_SAID_N: [32.35, 31.6],
  // Suez Canal and Red Sea
  PORT_SAID: [32.32, 31.25],
  ISMAILIA: [32.33, 30.6],
  BITTER_LAKE: [32.45, 30.3],
  SUEZ: [32.55, 29.88],
  GULF_OF_SUEZ: [32.75, 29.3],
  GULF_OF_SUEZ_S: [33.15, 28.5],
  SUEZ_SOUTH: [33.9, 27.6],
  RED_SEA_N: [35.3, 26.0],
  RED_SEA_MID: [38.3, 20.8],
  RED_SEA_S: [41.4, 15.2],
  BAB_EL_MANDEB: [43.35, 12.55],
  // Gulf of Aden, Arabian Sea, Indian Ocean
  ADEN_W: [45.5, 12.0],
  ADEN_E: [50.5, 12.8],
  SOCOTRA_N: [54.0, 13.4],
  MUMBAI: [72.3, 18.6],
  LACCADIVE_E: [74.3, 11.0],
  EIGHT_DEGREE: [73.0, 7.7],
  SRI_LANKA_S: [80.6, 5.4],
  ACEH: [95.4, 6.3],
  // Strait of Malacca and Singapore
  MALACCA_N: [98.7, 5.3],
  MALACCA_C: [100.6, 3.2],
  MALACCA_S: [102.0, 2.0],
  SINGAPORE_W: [103.3, 1.15],
  SINGAPORE: [103.8, 1.2],
  SINGAPORE_E: [104.5, 1.35],
  // South and East China Sea, Korea, Japan
  VIETNAM_SE: [109.8, 11.0],
  PARACEL_E: [113.0, 16.0],
  PEARL_RIVER: [113.75, 22.1],
  HONG_KONG: [114.35, 22.05],
  TAIWAN_STRAIT_S: [117.5, 22.9],
  TAIWAN_STRAIT: [119.3, 24.4],
  TAIWAN_STRAIT_N: [120.5, 25.6],
  EAST_CHINA_SEA: [123.3, 29.8],
  SHANGHAI: [122.6, 31.0],
  YELLOW_SEA_S: [124.8, 34.8],
  QINGDAO: [121.0, 35.6],
  INCHEON: [125.9, 37.2],
  JEJU_SW: [126.0, 32.7],
  KOREA_S: [128.2, 34.0],
  BUSAN: [129.0, 34.85],
  JAPAN_SW: [131.6, 30.2],
  KII: [135.3, 33.2],
  TOKYO: [139.8, 34.7],
  // Cape of Good Hope
  INDIAN_OCEAN: [70.0, -15.0],
  MADAGASCAR_S: [46.0, -30.0],
  AGULHAS: [21.0, -36.0],
  CAPE: [18.0, -34.7],
  TABLE_BAY: [18.2, -33.75],
  NAMIBIA_W: [10.0, -22.0],
  GUINEA_S: [0.0, -3.0],
  LIBERIA_W: [-14.0, 5.0],
  DAKAR_W: [-19.0, 14.5],
  SAHARA_W: [-19.0, 25.5],
  CANARIES_W: [-19.2, 30.0],
  MADEIRA_N: [-18.0, 34.0],
  // North Atlantic
  ATLANTIC_E: [-12.0, 49.0],
  ATLANTIC_MID: [-30.0, 46.5],
  GRAND_BANKS: [-50.0, 42.5],
  NANTUCKET: [-69.5, 40.0],
  NEW_YORK: [-73.3, 40.25],
  HATTERAS: [-74.8, 34.9],
  NORFOLK: [-75.6, 36.9],
  SAVANNAH: [-80.3, 31.8],
} satisfies Record<string, Coord>

export type SeaNode = keyof typeof SEA_NODES

const EDGES: [SeaNode, SeaNode][] = [
  ["HAM", "ELBE_A"], ["ELBE_A", "ELBE_B"], ["ELBE_B", "ELBE_MOUTH"],
  ["ELBE_MOUTH", "WESER"], ["ELBE_MOUTH", "GERMAN_BIGHT"], ["WESER", "GERMAN_BIGHT"],
  ["GERMAN_BIGHT", "TEXEL"], ["TEXEL", "ROTTERDAM"], ["TEXEL", "THAMES"],
  ["ROTTERDAM", "SCHELDT"], ["ROTTERDAM", "THAMES"], ["ROTTERDAM", "DOVER"], ["SCHELDT", "DOVER"], ["THAMES", "DOVER"],
  ["DOVER", "CHANNEL"], ["CHANNEL", "CHANNEL_W"], ["CHANNEL_W", "USHANT"], ["CHANNEL_W", "ATLANTIC_E"],
  ["USHANT", "ATLANTIC_E"], ["USHANT", "FINISTERRE"], ["FINISTERRE", "ROCA"], ["ROCA", "ST_VINCENT"],
  ["ST_VINCENT", "GIBRALTAR_W"], ["GIBRALTAR_W", "GIBRALTAR"], ["GIBRALTAR", "ALBORAN"],
  ["ALBORAN", "WMED_A"], ["WMED_A", "WMED_B"], ["WMED_B", "GULF_OF_LION"],
  ["GULF_OF_LION", "LIGURIAN"], ["WMED_B", "LIGURIAN"], ["WMED_B", "SARDINIA_S"],
  ["SARDINIA_S", "SICILY_STRAIT"], ["SICILY_STRAIT", "MALTA"], ["MALTA", "IONIAN"],
  ["MALTA", "CRETE_S"], ["IONIAN", "CRETE_S"], ["IONIAN", "KYTHIRA"], ["KYTHIRA", "AEGEAN_S"],
  ["AEGEAN_S", "KASOS"], ["KASOS", "PORT_SAID_N"], ["CRETE_S", "PORT_SAID_N"],
  ["PORT_SAID_N", "PORT_SAID"], ["PORT_SAID", "ISMAILIA"], ["ISMAILIA", "BITTER_LAKE"], ["BITTER_LAKE", "SUEZ"],
  ["SUEZ", "GULF_OF_SUEZ"], ["GULF_OF_SUEZ", "GULF_OF_SUEZ_S"], ["GULF_OF_SUEZ_S", "SUEZ_SOUTH"], ["SUEZ_SOUTH", "RED_SEA_N"],
  ["RED_SEA_N", "RED_SEA_MID"], ["RED_SEA_MID", "RED_SEA_S"], ["RED_SEA_S", "BAB_EL_MANDEB"],
  ["BAB_EL_MANDEB", "ADEN_W"], ["ADEN_W", "ADEN_E"], ["ADEN_E", "SOCOTRA_N"],
  ["SOCOTRA_N", "MUMBAI"], ["SOCOTRA_N", "EIGHT_DEGREE"], ["MUMBAI", "LACCADIVE_E"], ["LACCADIVE_E", "EIGHT_DEGREE"],
  ["EIGHT_DEGREE", "SRI_LANKA_S"], ["SRI_LANKA_S", "ACEH"],
  ["ACEH", "MALACCA_N"], ["MALACCA_N", "MALACCA_C"], ["MALACCA_C", "MALACCA_S"], ["MALACCA_S", "SINGAPORE_W"],
  ["SINGAPORE_W", "SINGAPORE"], ["SINGAPORE", "SINGAPORE_E"],
  ["SINGAPORE_E", "VIETNAM_SE"], ["VIETNAM_SE", "PARACEL_E"], ["PARACEL_E", "PEARL_RIVER"], ["PARACEL_E", "HONG_KONG"],
  ["PEARL_RIVER", "HONG_KONG"], ["HONG_KONG", "TAIWAN_STRAIT_S"], ["TAIWAN_STRAIT_S", "TAIWAN_STRAIT"],
  ["TAIWAN_STRAIT", "TAIWAN_STRAIT_N"], ["TAIWAN_STRAIT_N", "EAST_CHINA_SEA"], ["EAST_CHINA_SEA", "SHANGHAI"],
  ["EAST_CHINA_SEA", "JEJU_SW"], ["JEJU_SW", "YELLOW_SEA_S"], ["YELLOW_SEA_S", "QINGDAO"], ["YELLOW_SEA_S", "INCHEON"],
  ["JEJU_SW", "KOREA_S"], ["KOREA_S", "BUSAN"],
  ["TAIWAN_STRAIT_N", "JAPAN_SW"], ["JAPAN_SW", "KII"], ["KII", "TOKYO"],
  ["EIGHT_DEGREE", "INDIAN_OCEAN"], ["SRI_LANKA_S", "INDIAN_OCEAN"], ["ACEH", "INDIAN_OCEAN"],
  ["INDIAN_OCEAN", "MADAGASCAR_S"], ["MADAGASCAR_S", "AGULHAS"], ["AGULHAS", "CAPE"], ["CAPE", "TABLE_BAY"],
  ["CAPE", "NAMIBIA_W"], ["TABLE_BAY", "NAMIBIA_W"], ["NAMIBIA_W", "GUINEA_S"], ["GUINEA_S", "LIBERIA_W"],
  ["LIBERIA_W", "DAKAR_W"], ["DAKAR_W", "SAHARA_W"], ["SAHARA_W", "CANARIES_W"], ["CANARIES_W", "MADEIRA_N"],
  ["MADEIRA_N", "ROCA"], ["MADEIRA_N", "ST_VINCENT"], ["MADEIRA_N", "FINISTERRE"],
  ["ATLANTIC_E", "ATLANTIC_MID"], ["ATLANTIC_MID", "GRAND_BANKS"], ["GRAND_BANKS", "NANTUCKET"],
  ["GRAND_BANKS", "HATTERAS"], ["NANTUCKET", "NEW_YORK"], ["NEW_YORK", "HATTERAS"], ["NORFOLK", "HATTERAS"],
  ["NORFOLK", "NEW_YORK"], ["HATTERAS", "SAVANNAH"],
]

/** Above this distance from the nearest lane node a port counts as off the network (about 1,300 km). */
const MAX_CONNECTOR = 0.2

const NODE_IDS = Object.keys(SEA_NODES) as SeaNode[]
let adjacency: Map<SeaNode, { to: SeaNode; w: number }[]> | null = null

function graph() {
  if (adjacency) return adjacency
  adjacency = new Map(NODE_IDS.map((id) => [id, []]))
  for (const [a, b] of EDGES) {
    const w = geoDistance(SEA_NODES[a], SEA_NODES[b])
    adjacency.get(a)!.push({ to: b, w })
    adjacency.get(b)!.push({ to: a, w })
  }
  return adjacency
}

export function nearestNode(p: Coord): { id: SeaNode; distance: number } {
  let best = { id: NODE_IDS[0], distance: Infinity }
  for (const id of NODE_IDS) {
    const d = geoDistance(p, SEA_NODES[id])
    if (d < best.distance) best = { id, distance: d }
  }
  return best
}

/** Dijkstra over the lane graph. The graph has about 100 nodes, so a linear scan for the minimum is fine. */
export function shortestLane(from: SeaNode, to: SeaNode): SeaNode[] | null {
  const adj = graph()
  const dist = new Map<SeaNode, number>(NODE_IDS.map((id) => [id, Infinity]))
  const prev = new Map<SeaNode, SeaNode>()
  const open = new Set<SeaNode>(NODE_IDS)
  dist.set(from, 0)
  while (open.size) {
    let u: SeaNode | null = null
    for (const id of open) if (u === null || dist.get(id)! < dist.get(u)!) u = id
    if (u === null || dist.get(u) === Infinity) break
    if (u === to) break
    open.delete(u)
    for (const { to: v, w } of adj.get(u)!) {
      const alt = dist.get(u)! + w
      if (alt < dist.get(v)!) {
        dist.set(v, alt)
        prev.set(v, u)
      }
    }
  }
  if (dist.get(to) === Infinity) return null
  const path: SeaNode[] = [to]
  while (path[0] !== from) path.unshift(prev.get(path[0])!)
  return path
}

/**
 * A ship's path from one port to another along the lanes, densified for drawing.
 * Each port connects to its nearest lane node with a short straight connector.
 * Ports far from every lane fall back to a great circle.
 */
export function seaRoute(from: Coord, to: Coord): Coord[] {
  const a = nearestNode(from)
  const b = nearestNode(to)
  if (a.distance > MAX_CONNECTOR || b.distance > MAX_CONNECTOR) return densifyGreatCircle([from, to])
  const lane = shortestLane(a.id, b.id)
  if (!lane) return densifyGreatCircle([from, to])
  return joinPaths(densifyGreatCircle([from, ...lane.map((id) => SEA_NODES[id]), to]))
}
