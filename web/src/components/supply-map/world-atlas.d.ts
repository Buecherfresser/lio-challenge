// world-atlas ships TopoJSON without types.
declare module "world-atlas/countries-110m.json" {
  import type { GeometryCollection, Topology } from "topojson-specification"
  const topology: Topology<{ countries: GeometryCollection; land: GeometryCollection }>
  export default topology
}
