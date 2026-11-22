/** Product name shown in the sidebar and the browser tab. Rename it here. */
export const PRODUCT_NAME = "1e16"

/** How often every query asks the backend again, in milliseconds. */
export const POLL_MS = 5000

/**
 * Whom the dashboard works for and in which time zone it shows times. The backend sets both (CUSTOMER_NAME, TIMEZONE)
 * and main.tsx fills this in before the first render. The values here only hold until then.
 */
export const CUSTOMER = { name: "the customer", timezone: "Europe/Berlin" }

/** Events fetched per page in the log. */
export const EVENTS_PAGE_SIZE = 50
