@AGENTS.md

# Netzdiagnose – long-term internet line tester

Local Windows tool that runs a long-term ("Langzeittest") measurement of the user's internet
connection and finds the root cause of gaming lag (ping > 200 ms, packet loss).
UI language: **German**. Code identifiers/comments: English.

Read `docs/ARCHITECTURE.md` before writing code. It is the binding contract (types, DB schema,
module boundaries, API routes, live-stream protocol, file ownership).
`docs/MESSPLAN.md` describes what is measured and why.

## Processes

- `engine/` – separate long-running Node process (TypeScript, run with `tsx`). Runs all probes,
  writes SQLite (`data/netdiag.db`, WAL), serves a control + SSE API on `127.0.0.1:3901`.
  Must keep measuring when no browser is open.
- `src/` – Next.js 16 App Router UI + API route handlers. Reads SQLite directly (read-mostly),
  proxies control commands and the live stream to the engine.
- `npm run dev` starts both via `concurrently`. `npm run engine` starts only the engine.

## Environment facts (user machine)

- Windows 11, **German locale** (localized command output!), Node 22.16, PowerShell 5.1.
- PC on Ethernet (Intel I225-V, frequent link drops logged by provider `e2fexpress`, IDs 27/32/33).
- Router: ARRIS **Vodafone Station Wi-Fi 6 (TG6442)** at `192.168.0.1` (cable/DOCSIS, **DS-Lite**).
  The user calls it "EasyBox"; 192.168.0.2 in the original request was a typo (confirmed by the user).
  Router IP is configurable (default 192.168.0.1). Never use the hostnames `easy.box`/`kabel.box`
  (they resolve to public Internet hosts).
- Cloudflare WARP (split tunnel, include mode) is installed – game traffic is not tunneled.

## Conventions

- TypeScript strict, no `any` (use `unknown` + narrowing). Prefer small pure functions; parsers and
  statistics live in `src/lib/shared/` and get vitest unit tests (`*.test.ts` next to the file).
- `src/lib/shared/**` must not import from `next/*`, `react` or `engine/**`; use **relative imports**
  inside `src/lib/shared` so the engine (tsx) can import it. Node built-ins are allowed only in
  files that are never imported by client components.
- Engine imports shared code via relative paths (`../src/lib/shared/...`).
- All timestamps are epoch **milliseconds** (`number`). RTT/latency in milliseconds (float).
  Throughput in Mbit/s (`Mbps`), byte counters as numbers.
- Child processes: `spawn`/`execFile` **without a shell**, always with timeouts, always killed on
  engine shutdown. Never parse localized words when a number/structure is available; when text
  must be parsed, support German **and** English.
- The engine must never block its event loop (no sync heavy work, no `execSync`, no `DatabaseSync`
  queries over large ranges – batch writes in a transaction every ~1 s).
- UI text is German with correct umlauts (ä ö ü ß). Number formatting with `de-DE` locale.
- No new npm dependencies unless the architecture doc lists them. Available: next, react, echarts,
  lucide-react, clsx, tailwind-merge, zod, tsx, concurrently, vitest.
- Next 16 specifics: every route handler starts with `await connection()` (from `next/server`);
  never `export const dynamic`/`runtime` (cacheComponents is OFF – do not enable); `params`/`searchParams`
  are Promises; `next lint` no longer exists (use `npm run lint`); Tailwind v4 is CSS-first (`@theme`
  in `src/app/globals.css`), no tailwind.config.js. Read `node_modules/next/dist/docs/` when unsure.
- `package.json` is `"type": "module"` (ESM everywhere; tsx runs the engine, top-level await ok).
- `node:sqlite` rows are null-prototype objects (spread them before passing to React), ids/changes
  may be bigint (`Number()`). Never import `server-only` in code the engine can reach.
- React lint rules that FAIL the build (eslint-plugin-react-hooks 7): no `ref.current = …` during
  render, no `Date.now()`/`performance.now()`/`Math.random()` during render, no synchronous
  `setState` directly in an effect body (inside callbacks/async is fine).
- ECharts: own wrapper on tree-shaken `echarts/core`; hex colors only (no oklch); fonts via
  `getComputedStyle` (canvas can't resolve CSS variables).
- Research material: `docs/research/*.md` (verified facts), `docs/research/code/*` (reference code –
  read, don't import), `fixtures/` (real captured tool/router output – use in tests; contains local
  MAC/IP addresses, do not publish).

## Safety rules

- Never change system/network settings, never disable/restart adapters, nothing requiring admin.
- Router: never guess passwords; only log in with the password the user configured; respect lockouts.
- Keep test traffic modest (speed tests are scheduled, not continuous).

## Commands

- `npm run dev` – Next (127.0.0.1:3000) + engine (watch mode)
- `npm run build` / `npm run start:all` – production build / run UI + engine
- `npm run engine` – engine only
- `npm run typecheck` – `tsc --noEmit` over app + engine
- `npm test` – vitest
- `npm run lint` – eslint
