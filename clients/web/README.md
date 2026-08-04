# clients/web — web / PWA entry point

Build: `npm run build:web` (esbuild) → `web/dist` by default, `$GC_WEB_OUT_DIR` when set. On a host that
runs green-chat, `web/dist` is the LIVE served bundle: the build deletes its target first, so
`clients/live_tree_guard.mjs` refuses it there — build to a scratch dir, or deploy via `scripts/deploy.sh`.
Served by the server on `GET /` (T-401):
`index.html` no-store, hashed `/assets/*` immutable 1 year, SPA-fallback, strict CSP
(`default-src 'self'`, connect-src self+wss). Service Worker + manifest land in later tasks
(T-407/T-408). See `docs/CLIENTS.md` §7.1. Perf budget: web MVP ≤ 300 KB gzip.
