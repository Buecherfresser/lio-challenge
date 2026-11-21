// Screenshots of the supply map against the dev fixtures, without a backend.
// Run from web/: node dev/screenshot.mjs [outDir]   (default: <tmp>/lineguard-screenshots)
// Starts the Vite dev server, opens dev/harness.html in Chromium (Playwright), answers /api/** from dev/fixtures.
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const { chromium } = require("playwright")

const web = path.resolve(import.meta.dirname, "..")
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "lineguard-screenshots"))
const port = 5199
const base = `http://localhost:${port}`
const fixture = (name) => JSON.parse(readFileSync(path.join(web, "dev/fixtures", name), "utf8"))

const ROUTES = {
  "/api/map": () => fixture("map.json"),
  "/api/parts": () => fixture("parts.json"),
  "/api/overview": () => fixture("overview.json"),
  "/api/status": () => fixture("status.json"),
  "/api/decisions": () => fixture("decisions.json"),
}

// ?all=1 draws every shipment (marks them all critical) to check the routes; ?empty=1 has nothing critical.
function answer(url, variantUrl) {
  const handler = ROUTES[url.pathname]
  if (!handler) return null
  const data = handler()
  const page = new URL(variantUrl)
  if (url.pathname === "/api/map" && page.searchParams.has("all")) for (const s of data.shipments) s.critical = true
  if (url.pathname === "/api/map" && page.searchParams.has("empty")) {
    for (const s of data.shipments) s.critical = false
    data.replacements = []
  }
  return data
}

mkdirSync(out, { recursive: true })
const vite = spawn(path.join(web, "node_modules/.bin/vite"), ["--port", String(port), "--strictPort"], { cwd: web, stdio: ["ignore", "pipe", "pipe"] })
await new Promise((resolve, reject) => {
  vite.stdout.on("data", (b) => String(b).includes("Local:") && resolve())
  vite.stderr.on("data", (b) => process.stderr.write(b))
  vite.on("exit", (code) => reject(new Error(`vite exited with ${code}`)))
})

const browser = await chromium.launch()
try {
  async function open(viewport, query) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    page.on("pageerror", (e) => console.error("page error:", e.message))
    page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()))
    const url = `${base}/dev/harness.html${query}`
    await page.route("**/api/**", (route) => {
      const data = answer(new URL(route.request().url()), url)
      return data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, json: { error: "no fixture" } })
    })
    await page.goto(url)
    await page.waitForSelector("svg[role=img] path[fill]", { timeout: 15000 })
    await page.waitForTimeout(300)
    return page
  }
  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(out, name), fullPage: true })
    console.log("saved", path.join(out, name))
  }

  const desktop = { width: 1440, height: 900 }
  const mobile = { width: 390, height: 844 }

  let page = await open(desktop, "?variant=buyer")
  await shot(page, "map-desktop.png")
  await page.getByRole("button", { name: /Air shipment SHP-4101/ }).click()
  await page.waitForTimeout(250)
  await shot(page, "map-desktop-card.png")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: /Proposed replacement/ }).click()
  await page.waitForTimeout(250)
  await shot(page, "map-desktop-replacement.png")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Collector statue Lost" }).click()
  await page.waitForTimeout(250)
  await shot(page, "map-desktop-focus.png")
  await page.close()

  page = await open(mobile, "?variant=management")
  await shot(page, "map-mobile.png")
  await page.getByRole("button", { name: /Sea shipment SHP-4104/ }).click()
  await page.waitForTimeout(250)
  await shot(page, "map-mobile-card.png")
  await page.close()

  // The real pages of both views, at 2x for the pull request.
  for (const [name, route] of [["management", "/"], ["buyer", "/buyer"]]) {
    for (const [size, viewport] of [["desktop", desktop], ["mobile", mobile]]) {
      page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
      page.on("pageerror", (e) => console.error("page error:", e.message))
      await page.route("**/api/**", (r) => {
        const data = answer(new URL(r.request().url()), `${base}${route}`)
        return data ? r.fulfill({ json: data }) : r.fulfill({ status: 404, json: { error: "no fixture" } })
      })
      await page.goto(`${base}${route}`)
      await page.waitForSelector("svg[role=img] path[fill]", { timeout: 15000 })
      await page.waitForTimeout(400)
      await shot(page, `page-${name}-${size}.png`)
      await page.close()
    }
  }

  page = await open(desktop, "?variant=management&all=1")
  await shot(page, "map-desktop-all-routes.png")
  await page.close()

  page = await open(desktop, "?variant=management&empty=1")
  await shot(page, "map-desktop-empty.png")
  await page.close()
} finally {
  await browser.close()
  vite.kill()
}
