import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Build stamp — so "which build is this?" is answerable from the browser.
// Vercel exposes the commit SHA; locally we ask git. Never fails the build.
const commit = (() => {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return 'dev' }
})()

export default defineConfig({
  // `vite dev` serves the SPA only; the API lives in server/ on 8080. Proxying
  // keeps them same-origin in development, which is what the session cookie
  // needs (it is httpOnly and SameSite=lax, so a cross-origin XHR would not
  // send it). Run both: `npm run dev:server` alongside `npm run dev`.
  server: {
    proxy: {
      '/api': { target: process.env.VITE_DEV_API || 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT) || 5173,
  },
})
