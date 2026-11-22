import { config } from "../config.ts";
import { soony } from "./soony.ts";
import type { PortalAdapter } from "./types.ts";

export type { BaseTable, PortalAdapter } from "./types.ts";

// Every adapter the app knows. Add a new customer's here and set PORTAL_ADAPTER to its id.
const ADAPTERS: Record<string, PortalAdapter> = { [soony.id]: soony };

const chosen = ADAPTERS[config.portalAdapter];
if (!chosen) throw new Error(`PORTAL_ADAPTER=${config.portalAdapter} is unknown. Known adapters: ${Object.keys(ADAPTERS).join(", ")}.`);

/** The layout of the connected customer's portal. */
export const portal: PortalAdapter = chosen;
