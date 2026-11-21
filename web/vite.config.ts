import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The backend listens on 8787. In production it serves dist/ itself, so the app only uses /api/... paths.
const apiProxy = { "/api": "http://localhost:8787" }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "../shared"),
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
})
