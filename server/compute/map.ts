import type { DecisionCard, GeoPoint, MapReplacement, MapShipment, MapView, PartRow, PartStatus, TransportMode } from "../../shared/api.ts";
import { config } from "../config.ts";
import { all, json } from "../db.ts";
import { settings, toTime } from "./settings.ts";
import { loadSnapshot, memo } from "./state.ts";
import type { ShipmentRow, Snapshot } from "./state.ts";
import { currentWorld, partRows } from "./parts.ts";
import type { InboundState } from "./world.ts";
import { normalizeScenario } from "./scenario.ts";
import type { Scenario, ScenarioChange } from "./scenario.ts";
import { riskById, riskRows } from "./rows.ts";

// The supply map: what travels to the distribution center right now, with every place as coordinates.
// It states facts only. The dashboard draws the lines and estimates where a ship or plane is now.
// Places in the exports are free text (a UN/LOCODE, a port name, a city, a site id). They are resolved against
// the ports, sites and suppliers on file, then against a small list of real places. An unknown place stays null:
// a coordinate is never made up.

const HOUR = 3_600_000;
const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const isoOf = (s: string | null | undefined): string | null => iso(toTime(s));
/** A departure date without a time counts as the start of that day, so a same-day arrival never comes before it. */
const departure = (s: string | null | undefined): string | null =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? iso(Date.parse(`${s.trim()}T00:00:00${settings.localUtcOffset}`)) : isoOf(s);
const uniq = <T>(a: T[]): T[] => [...new Set(a)];
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Transport mode as the exports write it, mapped to the four the map knows. */
export function normMode(raw: string | null | undefined): TransportMode {
  const t = (raw ?? "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (/air|flight|plane|awb/.test(t)) return "air";
  if (/sea|ocean|vessel|ship|fcl|lcl|container|maritime/.test(t)) return "sea";
  if (/rail|train/.test(t)) return "rail";
  if (/road|truck|lkw|lorry|ftl|ltl/.test(t)) return "truck";
  return "unknown";
}

/** Great-circle distance in km. */
export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- places ----

/**
 * Real coordinates of places that come up in launch logistics, used only when the ports, sites and suppliers on file
 * do not know a place. `kind` is left out for a city: it then follows the transport mode of the leg.
 * `city` lets an air leg that names only the city ("Hamburg") land on the airport instead of the seaport.
 */
const GAZETTEER: { code: string | null; name: string; lat: number; lon: number; kind?: "port" | "airport"; city?: string; aliases?: string[] }[] = [
  // China and Hong Kong
  { code: "CNYTN", name: "Yantian", lat: 22.58, lon: 114.27, kind: "port", aliases: ["port of yantian", "shenzhen yantian", "yantian port"] },
  { code: "CNSZX", name: "Shenzhen", lat: 22.5431, lon: 114.0579 },
  { code: "SZX", name: "Shenzhen Bao'an Airport", lat: 22.6393, lon: 113.8107, kind: "airport", city: "Shenzhen", aliases: ["shenzhen airport"] },
  { code: "HKHKG", name: "Hong Kong", lat: 22.3440, lon: 114.12, kind: "port", aliases: ["port of hong kong", "kwai tsing"] },
  { code: "HKG", name: "Hong Kong International Airport", lat: 22.3080, lon: 113.9185, kind: "airport", city: "Hong Kong", aliases: ["hong kong airport", "chek lap kok"] },
  { code: "CNCAN", name: "Guangzhou", lat: 23.1291, lon: 113.2644 },
  { code: "CAN", name: "Guangzhou Baiyun Airport", lat: 23.3924, lon: 113.2988, kind: "airport", city: "Guangzhou", aliases: ["guangzhou airport", "baiyun"] },
  { code: "CNDGG", name: "Dongguan", lat: 23.0207, lon: 113.7518 },
  { code: "CNSHA", name: "Shanghai", lat: 31.36, lon: 121.59, kind: "port", aliases: ["port of shanghai", "waigaoqiao"] },
  { code: "PVG", name: "Shanghai Pudong Airport", lat: 31.1443, lon: 121.8083, kind: "airport", city: "Shanghai", aliases: ["pudong", "shanghai airport"] },
  { code: "CNNGB", name: "Ningbo", lat: 29.94, lon: 121.86, kind: "port", aliases: ["ningbo zhoushan", "beilun"] },
  // Korea
  { code: "KRPUS", name: "Busan", lat: 35.10, lon: 129.04, kind: "port", aliases: ["pusan", "port of busan"] },
  { code: "ICN", name: "Incheon International Airport", lat: 37.4602, lon: 126.4407, kind: "airport", city: "Seoul", aliases: ["incheon airport", "seoul incheon"] },
  { code: "KRINC", name: "Incheon", lat: 37.45, lon: 126.60, kind: "port", aliases: ["port of incheon"] },
  { code: "KRSEL", name: "Seoul", lat: 37.5665, lon: 126.9780 },
  { code: null, name: "Hwaseong", lat: 37.1996, lon: 126.8312 },
  // India
  { code: "INNSA", name: "Nhava Sheva", lat: 18.949, lon: 72.951, kind: "port", aliases: ["jnpt", "jawaharlal nehru port", "jnpa"] },
  { code: "INBOM", name: "Mumbai", lat: 18.95, lon: 72.84, kind: "port", aliases: ["bombay"] },
  { code: "BOM", name: "Mumbai Airport", lat: 19.0896, lon: 72.8656, kind: "airport", city: "Mumbai", aliases: ["chhatrapati shivaji airport", "mumbai international airport"] },
  { code: "INPNQ", name: "Pune", lat: 18.5204, lon: 73.8567 },
  { code: "PNQ", name: "Pune Airport", lat: 18.5821, lon: 73.9197, kind: "airport", city: "Pune" },
  // Other hubs in Asia and the Middle East
  { code: "SGSIN", name: "Singapore", lat: 1.264, lon: 103.84, kind: "port", aliases: ["port of singapore"] },
  { code: "SIN", name: "Singapore Changi Airport", lat: 1.3644, lon: 103.9915, kind: "airport", city: "Singapore", aliases: ["changi"] },
  { code: "TWKHH", name: "Kaohsiung", lat: 22.61, lon: 120.28, kind: "port" },
  { code: "TPE", name: "Taipei Taoyuan Airport", lat: 25.0797, lon: 121.2342, kind: "airport", city: "Taipei", aliases: ["taoyuan airport"] },
  { code: "NRT", name: "Tokyo Narita Airport", lat: 35.7720, lon: 140.3929, kind: "airport", city: "Tokyo", aliases: ["narita"] },
  { code: "DXB", name: "Dubai International Airport", lat: 25.2532, lon: 55.3657, kind: "airport", city: "Dubai", aliases: ["dubai airport"] },
  // North America
  { code: "ORD", name: "Chicago O'Hare Airport", lat: 41.9742, lon: -87.9073, kind: "airport", city: "Chicago", aliases: ["o hare", "chicago o hare", "chicago ohare", "chicago airport"] },
  { code: "USCHI", name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { code: "BOI", name: "Boise Airport", lat: 43.5644, lon: -116.2228, kind: "airport", city: "Boise", aliases: ["boise airport"] },
  { code: "USBOI", name: "Boise", lat: 43.6150, lon: -116.2023 },
  { code: "ANC", name: "Anchorage Airport", lat: 61.1743, lon: -149.9963, kind: "airport", city: "Anchorage", aliases: ["anchorage"] },
  { code: "LAX", name: "Los Angeles Airport", lat: 33.9416, lon: -118.4085, kind: "airport", city: "Los Angeles" },
  { code: "USLAX", name: "Los Angeles", lat: 33.74, lon: -118.27, kind: "port", aliases: ["port of los angeles"] },
  // Europe
  { code: "DEHAM", name: "Hamburg", lat: 53.54, lon: 9.94, kind: "port", aliases: ["port of hamburg", "hamburg port"] },
  { code: "HAM", name: "Hamburg Airport", lat: 53.6304, lon: 9.9882, kind: "airport", city: "Hamburg", aliases: ["fuhlsbuettel", "fuhlsbüttel"] },
  { code: "NLRTM", name: "Rotterdam", lat: 51.949, lon: 4.145, kind: "port", aliases: ["port of rotterdam", "europoort", "maasvlakte"] },
  { code: "DEBRV", name: "Bremerhaven", lat: 53.5653, lon: 8.553, kind: "port" },
  { code: "BEANR", name: "Antwerp", lat: 51.295, lon: 4.32, kind: "port", aliases: ["antwerpen", "port of antwerp"] },
  { code: "FRA", name: "Frankfurt Airport", lat: 50.0379, lon: 8.5622, kind: "airport", city: "Frankfurt", aliases: ["frankfurt am main airport"] },
  { code: "DEFRA", name: "Frankfurt", lat: 50.1109, lon: 8.6821, aliases: ["frankfurt am main"] },
  { code: "LEJ", name: "Leipzig/Halle Airport", lat: 51.4239, lon: 12.2364, kind: "airport", city: "Leipzig", aliases: ["leipzig airport", "leipzig halle"] },
  { code: "DELEJ", name: "Leipzig", lat: 51.3397, lon: 12.3731 },
  { code: "CGN", name: "Cologne Bonn Airport", lat: 50.8659, lon: 7.1427, kind: "airport", city: "Cologne", aliases: ["koeln bonn", "köln bonn"] },
  { code: "AMS", name: "Amsterdam Schiphol Airport", lat: 52.3105, lon: 4.7683, kind: "airport", city: "Amsterdam", aliases: ["schiphol"] },
  { code: "PLGDN", name: "Gdansk", lat: 54.395, lon: 18.67, kind: "port", aliases: ["gdańsk", "danzig", "port of gdansk"] },
  { code: "GDN", name: "Gdansk Airport", lat: 54.3776, lon: 18.4662, kind: "airport", city: "Gdansk", aliases: ["gdańsk airport"] },
  { code: "PLPOZ", name: "Poznan", lat: 52.4064, lon: 16.9252, aliases: ["poznań", "posen"] },
  { code: "POZ", name: "Poznan Airport", lat: 52.421, lon: 16.8263, kind: "airport", city: "Poznan", aliases: ["poznań airport"] },
  { code: "PLWAW", name: "Warsaw", lat: 52.2297, lon: 21.0122, aliases: ["warszawa"] },
  { code: "WAW", name: "Warsaw Chopin Airport", lat: 52.1657, lon: 20.9671, kind: "airport", city: "Warsaw", aliases: ["chopin airport"] },
];

/** Lower case, no accents, words separated by single spaces. */
const words = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/ł/g, "l").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const codeKey = (s: string | null | undefined): string => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

type Source = "port" | "site" | "supplier" | "gazetteer";
interface Place {
  source: Source;
  lat: number; lon: number; name: string; code: string | null;
  kind: GeoPoint["kind"] | null;   // null = follows the mode of the leg
  codes: string[];                 // compared with codeKey
  names: string[];                 // compared with words()
  cities: string[];                // matched only after every name and code failed
}

interface Places { list: Place[]; hub: GeoPoint; hubSite: string | null }

/** Ports, sites, suppliers and the built-in places, plus the distribution center. Loaded once per snapshot. */
function places(snap: Snapshot): Places {
  return memo(snap, "map.places", () => {
    const ok = (lat: unknown, lon: unknown) => typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const list: Place[] = [];
    for (const p of all<{ locode: string; name: string | null; country: string | null; lat: number | null; lon: number | null; mode: string | null }>("SELECT locode, name, country, lat, lon, mode FROM ports")) {
      if (!ok(p.lat, p.lon)) continue;
      const m = (p.mode ?? "").toLowerCase();
      const kind = /air/.test(m) && !/sea|port|ocean/.test(m) ? "airport" : /sea|port|ocean/.test(m) && !/air/.test(m) ? "port" : null;
      list.push({ source: "port", lat: p.lat!, lon: p.lon!, name: p.name ?? p.locode, code: p.locode, kind, codes: [codeKey(p.locode)], names: [words(p.name)].filter(Boolean), cities: [] });
    }
    const sites = all<{ site_id: string; name: string | null; type: string | null; city: string | null; lat: number | null; lon: number | null }>("SELECT site_id, name, type, city, lat, lon FROM sites");
    for (const s of sites) {
      if (!ok(s.lat, s.lon)) continue;
      list.push({ source: "site", lat: s.lat!, lon: s.lon!, name: s.name ?? s.site_id, code: s.site_id, kind: "site", codes: [codeKey(s.site_id)], names: [words(s.name)].filter(Boolean), cities: [words(s.city)].filter(Boolean) });
    }
    for (const s of all<{ supplier_id: string; name: string | null; legal_name: string | null; city: string | null; lat: number | null; lon: number | null }>("SELECT supplier_id, name, legal_name, city, lat, lon FROM suppliers")) {
      if (!ok(s.lat, s.lon)) continue;
      list.push({ source: "supplier", lat: s.lat!, lon: s.lon!, name: s.name ?? s.supplier_id, code: s.supplier_id, kind: "supplier", codes: [codeKey(s.supplier_id)], names: [words(s.name), words(s.legal_name)].filter(Boolean), cities: [words(s.city)].filter(Boolean) });
    }
    for (const g of GAZETTEER) {
      list.push({ source: "gazetteer", lat: g.lat, lon: g.lon, name: g.name, code: g.code, kind: g.kind ?? null, codes: g.code ? [codeKey(g.code)] : [], names: [words(g.name), ...(g.aliases ?? []).map(words)], cities: g.city ? [words(g.city)] : [] });
    }

    // The distribution center: the site the pack-out log and the shipments name, preferring a site typed as one.
    const count = (sql: string) => new Map(all<{ k: string | null; n: number }>(sql).filter((r) => r.k).map((r) => [codeKey(r.k), r.n]));
    const packout = count("SELECT site AS k, COUNT(*) AS n FROM packout GROUP BY site");
    const inbound = count("SELECT dest_site AS k, COUNT(*) AS n FROM shipments GROUP BY dest_site");
    const named = (m: Map<string, number>, s: (typeof sites)[number]) => [s.site_id, s.name, s.city].reduce((a, x) => a + (x ? (m.get(codeKey(x)) ?? 0) : 0), 0);
    const score = (s: (typeof sites)[number]) => [/distribution|\bdc\b|fulfil|warehouse|hub|pack/i.test(s.type ?? "") ? 1 : 0, named(packout, s), named(inbound, s)];
    const ranked = sites.filter((s) => ok(s.lat, s.lon)).map((s) => ({ s, k: score(s) })).filter((x) => x.k.some((v) => v > 0))
      .sort((a, b) => { for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i]; return a.s.site_id.localeCompare(b.s.site_id); });
    const top = ranked[0]?.s;
    const hub: GeoPoint = top ? { lat: top.lat!, lon: top.lon!, name: top.name ?? top.site_id, kind: "hub", code: top.site_id }
      : (() => {
        // No site with coordinates: put the hub where most shipments are headed, if that place is known.
        const dest = all<{ k: string | null }>("SELECT destination AS k FROM shipments WHERE destination IS NOT NULL GROUP BY destination ORDER BY COUNT(*) DESC LIMIT 1")[0]?.k;
        const at = dest ? list.find((p) => p.codes.includes(codeKey(dest)) || p.names.includes(words(dest)) || p.cities.includes(words(dest))) : undefined;
        return { lat: at?.lat ?? 0, lon: at?.lon ?? 0, name: "Distribution center", kind: "hub", code: null } as GeoPoint;
      })();
    for (const p of list) if (p.source === "site" && p.code === hub.code) p.kind = "hub";
    return { list, hub, hubSite: top?.site_id ?? null };
  });
}

const toPoint = (p: Place, mode: TransportMode): GeoPoint => ({
  lat: p.lat, lon: p.lon, name: p.name, code: p.code, kind: p.kind ?? (mode === "air" ? "airport" : "port"),
});

/**
 * A free-text place as coordinates, or null when nothing on file or in the built-in list knows it.
 * Exact codes and names first (ports, then sites, suppliers, built-in places), then cities, then codes written
 * inside the text ("Yantian (CNYTN)"), then the longest known name inside the text ("Port of Yantian").
 * Among equally good matches the mode of the leg picks an airport or a port.
 */
export function resolvePlace(raw: string | null | undefined, mode: TransportMode, snap: Snapshot): GeoPoint | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const { list } = places(snap);
  const key = codeKey(text), w = words(text);
  const want = mode === "air" ? "airport" : mode === "sea" ? "port" : null;
  const order: Source[] = ["port", "site", "supplier", "gazetteer"];
  // Of several matches: the kind the leg needs (airport for air, port for sea), then the longer name, then the order of the sources.
  const prefer = (c: { p: Place; len: number }[]): Place | null => {
    if (!c.length) return null;
    const fit = want && c.some((x) => x.p.kind === want) ? c.filter((x) => x.p.kind === want) : c;
    return [...fit].sort((a, b) => b.len - a.len || order.indexOf(a.p.source) - order.indexOf(b.p.source))[0].p;
  };
  const inside = (n: string) => n.length >= 4 && ` ${w} `.includes(` ${n} `);
  const tries: (() => { p: Place; len: number }[])[] = [
    // the code or name itself, or the city of a place of the kind the leg needs ("Hamburg" by air is the airport)
    () => list.filter((p) => p.codes.includes(key) || p.names.includes(w) || (want && p.kind === want && p.cities.includes(w))).map((p) => ({ p, len: 0 })),
    () => list.filter((p) => p.cities.includes(w)).map((p) => ({ p, len: 0 })),
    () => {
      // UN/LOCODE ("CNYTN", "CN YTN") or IATA code ("ICN") written in capitals inside the text
      const tokens = text.replace(/\b([A-Z]{2}) ([A-Z2-9]{3})\b/g, "$1$2").match(/\b[A-Z]{3}\b|\b[A-Z]{2}[A-Z2-9]{3}\b/g) ?? [];
      return list.filter((p) => tokens.some((t) => p.codes.includes(t))).map((p) => ({ p, len: 0 }));
    },
    // a known name inside the text ("Port of Yantian"); the longest one wins
    () => list.flatMap((p) => [...p.names, ...(want && p.kind === want ? p.cities : [])].filter(inside).map((n) => ({ p, len: n.length }))),
  ];
  for (const t of tries) { const hit = prefer(t()); if (hit) return toPoint(hit, mode); }
  return null;
}

/** Stops in a free-text via column: "KRPUS|NLRTM", "Busan; Rotterdam", "ICN > FRA". */
const splitVia = (raw: string | null | undefined): string[] => (raw ?? "").split(/\s*(?:[|;,>→+]|->|\s\/\s|\bvia\b|\bthen\b)\s*/i).map((x) => x.trim()).filter(Boolean);

const samePlace = (a: GeoPoint | null, b: GeoPoint | null, withinKm = 1) => !!a && !!b && ((a.code !== null && a.code === b.code) || km(a, b) <= withinKm);

/** A supplier's own location: its coordinates on file, else its city among the known places. */
function supplierPoint(id: string | null, snap: Snapshot): GeoPoint | null {
  if (!id) return null;
  const hit = places(snap).list.find((p) => p.source === "supplier" && p.code === id);
  if (hit) return toPoint(hit, "unknown");
  const s = all<{ name: string | null; city: string | null }>("SELECT name, city FROM suppliers WHERE supplier_id = ?", id)[0];
  const city = s?.city ? resolvePlace(s.city, "unknown", snap) : null;
  return city ? { ...city, name: s?.name ?? id, kind: "supplier", code: id } : null;
}

// ---- shipments ----

interface RouteGeo { route_id: string; origin: string | null; destination: string | null; mode: string | null; transit_days: number | null; via: string | null }
const routesOf = (snap: Snapshot): RouteGeo[] => memo(snap, "map.routes", () => all<RouteGeo>("SELECT route_id, origin, destination, mode, transit_days, via FROM routes ORDER BY route_id"));

const RANK = { safe: 0, uncertain: 1, lost: 2 } as const;
const worst = (a: MapShipment["status_class"], b: MapShipment["status_class"]) => (RANK[b] > RANK[a] ? b : a);
const PART_RANK: Record<PartStatus, number> = { ok: 0, uncertain: 1, lost: 2 };

/** Goods value of the units on board, from the order line, else the supplier's price list. Null unless every part has a price. */
function shipmentValue(row: ShipmentRow, parts: { part_id: string; quantity: number }[], snap: Snapshot): { value: MapShipment["value"]; value_eur: number | null } {
  const pos = json<string[]>(row.po_numbers, []);
  const priced: { amount: number; currency: string }[] = [];
  for (const p of parts) {
    let price: number | null = null, currency: string | null = null;
    for (const l of snap.poLines.filter((x) => x.part_id === p.part_id && pos.includes(x.po_number))) {
      const f = snap.fx.latest("po_line", l.po_line_id, "confirmed_unit_price") ?? snap.fx.latest("po_line", l.po_line_id, "unit_price");
      const v = f && Number.isFinite(Number(f.value)) && Number(f.value) > 0 ? Number(f.value) : l.unit_price;
      if (v !== null && v > 0) { price = v; currency = (f?.unit ?? l.currency ?? snap.suppliers.get(l.supplier_id ?? "")?.currency ?? null); break; }
    }
    if (price === null && row.supplier_id) {
      const sp = snap.supplierParts.find((x) => x.supplier_id === row.supplier_id && x.part_id === p.part_id);
      if (sp && sp.unit_price !== null && sp.unit_price > 0) { price = sp.unit_price; currency = sp.currency ?? snap.suppliers.get(sp.supplier_id)?.currency ?? null; }
    }
    if (price === null || !currency) return { value: null, value_eur: null };
    priced.push({ amount: p.quantity * price, currency: currency.trim().toUpperCase() });
  }
  if (!priced.length) return { value: null, value_eur: null };
  const currencies = uniq(priced.map((x) => x.currency));
  const rate = (c: string) => config.fxToEur[c];
  const eur = priced.every((x) => rate(x.currency) !== undefined) ? round2(priced.reduce((s, x) => s + x.amount * rate(x.currency), 0)) : null;
  if (currencies.length === 1) return { value: { amount: round2(priced.reduce((s, x) => s + x.amount, 0)), currency: currencies[0] }, value_eur: eur };
  // Several currencies on one shipment: one amount only exists in EUR.
  return eur === null ? { value: null, value_eur: null } : { value: { amount: eur, currency: "EUR" }, value_eur: eur };
}

/** Places of one shipment: pickup, origin, stops, destination and the onward leg to the distribution center. */
function shipmentGeo(row: ShipmentRow, mode: TransportMode, snap: Snapshot): Pick<MapShipment, "pickup" | "origin" | "via" | "destination" | "final"> {
  const { hub } = places(snap);
  const route = row.route_id ? routesOf(snap).find((r) => r.route_id === row.route_id) : undefined;
  const origin = resolvePlace(row.origin ?? route?.origin, mode, snap);
  const destination = resolvePlace(row.destination ?? route?.destination, mode, snap);
  const supplier = supplierPoint(row.supplier_id, snap);
  const pickup = supplier && (!origin || km(supplier, origin) > 30) ? supplier : null;
  const via: GeoPoint[] = [];
  for (const stop of splitVia(row.via ?? route?.via)) {
    const p = resolvePlace(stop, mode, snap);
    if (p && !samePlace(p, origin) && !samePlace(p, destination) && !samePlace(p, via[via.length - 1] ?? null)) via.push(p);
  }
  // The onward leg ends at the shipment's destination site when that is a known site, else at the distribution center.
  const site = row.dest_site ? resolvePlace(row.dest_site, "truck", snap) : null;
  const end = site && (site.kind === "site" || site.kind === "hub") ? site : hub;
  const final = samePlace(destination, end) ? null : end;
  return { pickup, origin, via, destination, final };
}

/** Open risks, with their scenario normalized. */
interface OpenRisk { id: number; part_id: string | null; supplier_id: string | null; changes: ScenarioChange[] }
const openRisks = (snap: Snapshot): OpenRisk[] => memo(snap, "map.risks", () =>
  riskRows("status = 'open'").map((r) => ({ id: r.id, part_id: r.part_id, supplier_id: r.supplier_id, changes: normalizeScenario(json<unknown>(r.scenario, {})).scenario.changes })));

/**
 * What a scenario assumes about a shipment: it does not arrive (removed), arrives too late (a later arrival or one after the deadline),
 * or nothing. A later change on the same shipment wins, as in the what-if.
 */
function disrupts(changes: ScenarioChange[], s: { shipment_id: string; parts: { part_id: string }[]; inbound: InboundState[] }, deadline: number): boolean {
  let ship = false, part = false;
  const onBoard = new Set(s.parts.map((p) => p.part_id));
  for (const c of changes) {
    if (c.shipment_id === s.shipment_id) {
      if (c.type === "remove_shipment" && (!c.part_id || onBoard.has(c.part_id))) ship = true;
      if (c.type === "move_shipment") ship = (c.delay_hours ?? 0) > 0 || (c.arrival !== null && (toTime(c.arrival) ?? 0) > deadline);
    }
    if (c.part_id && onBoard.has(c.part_id)) {
      if (c.type === "part_unavailable") part = true;
      // "the uncertain supply of the part does not arrive": this shipment is part of it while it is uncertain
      if (c.type === "drop_uncertain" && s.inbound.some((i) => i.part_id === c.part_id && i.cls === "uncertain")) part = true;
    }
  }
  return ship || part;
}

function buildShipments(snap: Snapshot): MapShipment[] {
  const world = currentWorld(snap);
  const rows = new Map<string, PartRow>(partRows(snap).map((r) => [r.part_id, r]));
  const byShipment = new Map<string, InboundState[]>();
  for (const part of world.parts.values()) for (const i of part.inbound) byShipment.set(i.shipment_id, [...(byShipment.get(i.shipment_id) ?? []), i]);
  const risks = openRisks(snap);
  const out: MapShipment[] = [];
  for (const [sid, inbound] of byShipment) {
    const row = snap.shipments.find((r) => r.shipment_id === sid);
    if (!row) continue;
    const mode = normMode(inbound[0].mode ?? row.mode);
    const parts = uniq(inbound.map((i) => i.part_id)).map((pid) => {
      const r = rows.get(pid);
      return { part_id: pid, description: r?.description ?? pid, quantity: Math.round(inbound.filter((i) => i.part_id === pid).reduce((s, i) => s + i.qty, 0)), status: r?.status ?? ("uncertain" as PartStatus) };
    });
    // The class of the units on board: the shipment's own class, and the part of it that arrives too late to be packed.
    let cls: MapShipment["status_class"] = "safe";
    for (const i of inbound) {
      cls = worst(cls, i.cls);
      for (const it of world.parts.get(i.part_id)?.items ?? []) if (it.kind === "shipment" && it.object?.id === sid) cls = worst(cls, it.cls);
    }
    const at = inbound.reduce<number | null>((m, i) => (i.at === null ? m : m === null ? i.at : Math.max(m, i.at)), null);
    const pos = snap.fx.latest("shipment", sid, "position");
    const ll = pos?.value.split(",").map((x) => Number(x.trim()));
    const tracked = ll && ll.length === 2 && ll.every(Number.isFinite) ? { lat: ll[0], lon: ll[1] } : row.last_lat !== null && row.last_lon !== null ? { lat: row.last_lat, lon: row.last_lon } : null;
    const trackedAt = snap.fx.val("shipment", sid, "last_update") ?? row.updated_at;
    const supplierName = row.supplier_id ? (snap.suppliers.get(row.supplier_id)?.name ?? row.supplier_id) : null;
    const s = { shipment_id: sid, parts, inbound };
    out.push({
      shipment_id: sid, mode, status: inbound[0].status || "unknown", departed: inbound.some((i) => i.departed),
      supplier: row.supplier_id ? { supplier_id: row.supplier_id, name: supplierName! } : null,
      ...shipmentGeo(row, mode, snap),
      etd: departure(snap.fx.val("shipment", sid, "etd") ?? row.etd), eta: isoOf(inbound[0].eta), at_line: iso(at),
      last_position: tracked ? { ...tracked, at: trackedAt ? (iso(Date.parse(trackedAt)) ?? trackedAt) : null } : null,
      parts, quantity: parts.reduce((a, p) => a + p.quantity, 0),
      ...shipmentValue(row, parts, snap),
      status_class: cls, critical: parts.some((p) => p.status !== "ok"),
      risk_ids: risks.filter((r) => (r.part_id && parts.some((p) => p.part_id === r.part_id)) || r.changes.some((c) => c.shipment_id === sid || (c.part_id && parts.some((p) => p.part_id === c.part_id)))).map((r) => r.id),
      disrupted: risks.some((r) => disrupts(r.changes, s, snap.deadline)),
    });
  }
  return out.sort((a, b) => Number(b.critical) - Number(a.critical) || RANK[b.status_class] - RANK[a.status_class] || (a.at_line ?? "9").localeCompare(b.at_line ?? "9") || a.shipment_id.localeCompare(b.shipment_id));
}

// ---- replacement routes from decision cards ----

interface DecisionGeo { id: number; risk_id: number; status: DecisionCard["status"]; title: string; copies_saved: number; cost_eur: number | null; scenario: string | null; mail_supplier_id: string | null }

/** The action's scenario as stored with the card; cards from before that column fall back to the logged proposal. */
function decisionScenario(d: DecisionGeo): Scenario {
  const stored = normalizeScenario(json<unknown>(d.scenario, {}));
  if (stored.scenario.changes.length) return stored.scenario;
  const ev = all<{ input: string | null }>("SELECT input FROM events WHERE action = 'decision.proposed' AND object_type = 'decision' AND object_id = ? ORDER BY id DESC LIMIT 1", String(d.id))[0];
  return normalizeScenario(json<{ proposal?: { scenario?: unknown } }>(ev?.input, {}).proposal?.scenario ?? {}).scenario;
}

/** Mode of new supply from a supplier: a route on file from its place, else distance and the time left. */
function supplyRoute(from: GeoPoint, supplierId: string, arrival: number | null, snap: Snapshot): { mode: TransportMode; via: GeoPoint[] } {
  const { hub } = places(snap);
  const usedRoutes = new Set(snap.shipments.filter((s) => s.supplier_id === supplierId && s.route_id).map((s) => s.route_id!));
  const usedOrigins = new Set(snap.shipments.filter((s) => s.supplier_id === supplierId && s.origin).map((s) => codeKey(s.origin)));
  const candidates = routesOf(snap).map((r) => {
    const mode = normMode(r.mode);
    return { r, mode, o: resolvePlace(r.origin, mode, snap), d: resolvePlace(r.destination, mode, snap) };
  }).filter((x) => x.o && (usedRoutes.has(x.r.route_id) || usedOrigins.has(codeKey(x.r.origin)) || codeKey(x.r.origin) === codeKey(supplierId) || km(x.o, from) <= 250))
    .filter((x) => !x.d || km(x.d, hub) <= 400);
  const left = arrival === null ? null : (arrival - snap.now) / HOUR;
  const fits = candidates.filter((x) => left === null || x.r.transit_days === null || x.r.transit_days * 24 <= left);
  // The slowest route that is still in time is the one a planner books; with none in time, the fastest.
  const pick = fits.sort((a, b) => (b.r.transit_days ?? 0) - (a.r.transit_days ?? 0))[0]
    ?? candidates.sort((a, b) => (a.r.transit_days ?? Infinity) - (b.r.transit_days ?? Infinity))[0];
  if (pick) {
    const via: GeoPoint[] = [];
    const add = (p: GeoPoint | null) => { if (p && !samePlace(p, from, 30) && !samePlace(p, hub, 30) && !samePlace(p, via[via.length - 1] ?? null)) via.push(p); };
    add(pick.o);
    for (const stop of splitVia(pick.r.via)) add(resolvePlace(stop, pick.mode, snap));
    add(pick.d);
    return { mode: pick.mode, via };
  }
  const dist = km(from, hub);
  if (dist <= 1500 && (left === null || left >= 24)) return { mode: "truck", via: [] };
  if (left === null || left <= 10 * 24) return { mode: "air", via: [] };
  return { mode: "sea", via: [] };
}

function buildReplacements(snap: Snapshot, shipments: MapShipment[]): MapReplacement[] {
  const { hub } = places(snap);
  const rows = all<DecisionGeo>(`SELECT d.id, d.risk_id, d.status, d.title, d.copies_saved, d.cost_eur, d.scenario, m.supplier_id AS mail_supplier_id
    FROM decisions d LEFT JOIN messages m ON m.id = d.mail_message_id WHERE d.status IN ('pending', 'approved') ORDER BY d.id`);
  const out: MapReplacement[] = [];
  for (const d of rows) {
    const changes = decisionScenario(d).changes;
    const risk = riskById(d.risk_id);
    const riskChanges = risk ? normalizeScenario(json<unknown>(risk.scenario, {})).scenario.changes : [];
    const base = { decision_id: d.id, risk_id: d.risk_id, status: d.status, title: d.title, cost_eur: d.cost_eur, copies_saved: d.copies_saved };
    for (const c of changes) {
      if (c.type === "move_shipment" && c.shipment_id) {
        // Expedite: the same goods, sooner. Sea freight that is pulled forward goes by air.
        const ship = shipments.find((s) => s.shipment_id === c.shipment_id);
        const row = snap.shipments.find((s) => s.shipment_id === c.shipment_id);
        const was = ship?.mode ?? normMode(row?.mode);
        const current = ship ? toTime(ship.at_line) : null;
        const arrival = c.arrival ? toTime(c.arrival) : current !== null && c.delay_hours !== null ? current + c.delay_hours * HOUR : null;
        const earlier = (c.delay_hours ?? 0) < 0 || (arrival !== null && current !== null && arrival < current);
        if (!earlier || !row) continue;
        const geo = ship ?? shipmentGeo(row, was, snap);
        const from = geo.origin ?? geo.pickup;
        if (!from) continue;
        const mode: TransportMode = was === "sea" ? "air" : was;
        const via = mode === was ? [...geo.via, ...(geo.destination && !samePlace(geo.destination, hub) ? [geo.destination] : [])] : [];
        const onBoard = ship?.parts ?? [];
        const quantity = c.part_id ? (onBoard.find((p) => p.part_id === c.part_id)?.quantity ?? null) : ship ? ship.quantity : null;
        out.push({ ...base, replaces_shipment_id: c.shipment_id, part_id: c.part_id ?? (onBoard.length === 1 ? onBoard[0].part_id : null),
          mode, from, via, to: hub, quantity, arrival: iso(arrival) });
      }
      if (c.type === "add_supply" && c.part_id) {
        const partId = c.part_id;
        // Who supplies: the supplier the card writes to, else the risk's supplier, else another supplier of the part with a location.
        const others = snap.supplierParts.filter((sp) => sp.part_id === partId).sort((a, b) => (b.is_primary ?? 0) - (a.is_primary ?? 0)).map((sp) => sp.supplier_id);
        const supplierId = [d.mail_supplier_id, risk?.supplier_id ?? null, ...others].find((id): id is string => !!id && !!supplierPoint(id, snap));
        if (!supplierId) continue;
        const from = supplierPoint(supplierId, snap)!;
        const arrival = c.arrival ? toTime(c.arrival) : null;
        const route = supplyRoute(from, supplierId, arrival, snap);
        // The shipment this supply stands in for: the one the risk (or the card) removes or delays for this part.
        const carries = (sid: string) => shipments.find((s) => s.shipment_id === sid)?.parts.some((p) => p.part_id === partId) ?? false;
        const gone = [...riskChanges, ...changes].find((x) => x.shipment_id && (x.type === "remove_shipment" || (x.type === "move_shipment" && (x.delay_hours ?? 0) > 0) || (x.type === "move_shipment" && x.arrival !== null && (toTime(x.arrival) ?? 0) > snap.deadline)) && (x.part_id === partId || carries(x.shipment_id)));
        out.push({ ...base, replaces_shipment_id: gone?.shipment_id ?? null, part_id: partId, mode: route.mode, from, via: route.via, to: hub, quantity: c.quantity, arrival: iso(arrival) });
      }
    }
  }
  return out;
}

// ---- the view ----

function suppliersOf(snap: Snapshot): MapView["suppliers"] {
  const rows = partRows(snap);
  const status = new Map(rows.map((r) => [r.part_id, r.status]));
  const bySupplier = new Map<string, string[]>();
  for (const sp of snap.supplierParts) if (status.has(sp.part_id)) bySupplier.set(sp.supplier_id, uniq([...(bySupplier.get(sp.supplier_id) ?? []), sp.part_id]));
  const out: MapView["suppliers"] = [];
  for (const [id, partIds] of bySupplier) {
    const point = supplierPoint(id, snap);
    if (!point) continue;
    const st = partIds.map((p) => status.get(p)!).reduce<PartStatus>((a, b) => (PART_RANK[b] > PART_RANK[a] ? b : a), "ok");
    out.push({ supplier_id: id, name: snap.suppliers.get(id)?.name ?? id, point, part_ids: partIds.sort(), status: st });
  }
  return out.sort((a, b) => PART_RANK[b.status] - PART_RANK[a.status] || a.supplier_id.localeCompare(b.supplier_id));
}

/** GET /api/map */
export function mapView(snap: Snapshot = loadSnapshot()): MapView {
  return memo(snap, "api.map", () => {
    const shipments = buildShipments(snap);
    return { now: new Date(snap.now).toISOString(), hub: places(snap).hub, suppliers: suppliersOf(snap), shipments, replacements: buildReplacements(snap, shipments) };
  });
}
