# Stack validation – Next.js 16.4 + node:sqlite + SSE + ECharts 6 + tsx engine (Windows 11)

Date: 2026-10-09. Machine: Windows 11 Pro 26200 (de-DE), Node v22.16.0, npm 11.4.1.
Throwaway project: `C:/Users/<user>/AppData/Local/Temp/claude/C--Development-Projects-internet-performance-tester/d8ef4cd1-5a1f-424b-96d0-127363bb3ab2/scratchpad/research/stack/app`
(all code below exists there and was run; nothing was written to the real project dir, no router traffic).

Everything marked **VERIFIED** was executed (dev and/or `next build` + `next start`, plus a real headless Chrome via
CDP). Items marked **UNVERIFIED / UNCERTAIN** are inferred.

---

## 0. TL;DR – decisions for the implementers

| Topic | Decision | Status |
|---|---|---|
| Scaffold | `npx create-next-app@latest <dir> --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes --disable-git --no-agent-feedback` (no `--turbopack` flag any more; Turbopack is default) | VERIFIED |
| Versions | next 16.4.0, react/react-dom 19.3.0, typescript **5.9.3** (template pins `^5`), tailwindcss 4.3.3 + **@tailwindcss/turbopack** 4.3.3 (no PostCSS), eslint 9.39.5 + eslint-config-next 16.4.0, echarts 6.1.0, echarts-for-react 3.0.6, tsx 4.23.15, concurrently 10.0.6, **@types/node ^22.20.5** (must upgrade from template's ^20) | VERIFIED |
| package.json `"type": "module"` | **Add it.** Needed for top-level `await` in the tsx engine; Next dev/build/start all work with it | VERIFIED |
| node:sqlite in Next | Works with Turbopack out of the box. **No** `serverExternalPackages`, **no** `runtime` export (with cacheComponents a `runtime`/`dynamic` export is a build ERROR) | VERIFIED |
| Sync DB reads | Always go through an async helper that calls `await connection()` first (else a GET handler is prerendered at build time and serves stale build-time rows forever) | VERIFIED |
| `cacheComponents` | Template enables `cacheComponents: true` + `partialPrefetching: true`. Both modes work. Recommend **turning it off** for this local live-data tool (see §10) – but write code that is valid in both modes | VERIFIED (both builds) / decision = recommendation |
| ExperimentalWarning | Project `.npmrc`: `node-options=--disable-warning=ExperimentalWarning` (cross-platform; applies to `npm run …` and `npx …`). Inline `NODE_OPTIONS=… cmd` does NOT work in cmd.exe | VERIFIED |
| SSE | `new Response(ReadableStream)` + headers; cleanup via `request.signal` "abort" (fires reliably; `cancel()` never fired) ; proxy with `fetch(..., {signal: request.signal})` – engine sees `close` | VERIFIED dev + prod |
| Engine offline | Proxy must answer **200 text/event-stream** with `retry:` + an `offline` event, NOT 503 – a 503 makes EventSource close permanently (readyState 2) | VERIFIED |
| Charts | Own ~45-line `EChart` wrapper on tree-shaken `echarts/core` (ResizeObserver, dispose). echarts-for-react 3.0.6 also works with React 19.3 but adds double-init + deep-compare of options | VERIFIED |
| Engine | `engine/index.ts`, dev: `tsx watch --clear-screen=false engine/index.ts`, prod: `node --import tsx engine/index.ts`. tsx honours tsconfig `paths` (`@/*`), incl. transitive imports | VERIFIED |
| Lint | `next lint` is REMOVED in v16 → script `"lint": "eslint"` (flat config generated) | VERIFIED |
| TypeScript 7 | `next build` works with TS 7.0.2, but **ESLint crashes** ("typescript-eslint does not support TS 7.0") → stay on 5.9.3 | VERIFIED |
| Fonts | `next/font/google` `Space_Grotesk` + `JetBrains_Mono` (variable fonts, self-hosted) work | VERIFIED |
| Tailwind | v4 CSS-first `@theme` / `@theme inline` / `@utility` (static and functional `glow-*`) work; dark-only via `color-scheme: dark` + tokens | VERIFIED |
| Bind address | `next dev/start -H 127.0.0.1` (default is 0.0.0.0 = whole LAN). Engine on 127.0.0.1:3901, fetch it as `http://127.0.0.1:3901` (not `localhost`) | VERIFIED |

---

## 1. Exact installed versions (npm ls --depth=0 + nested)

```
next 16.4.0 (published 2026-10-06; previous stable 16.3.8 of 2026-09-30 = fallback)
react 19.3.0, react-dom 19.3.0, @types/react 19.3.0, @types/react-dom 19.3.0
typescript 5.9.3              (template: "^5"; latest on npm = 7.0.2)
@types/node 20.19.43 → upgraded to 22.20.5 (needed for node:sqlite types)
tailwindcss 4.3.3, @tailwindcss/turbopack 4.3.3
eslint 9.39.5 (npm prints "deprecated" warning – harmless), eslint-config-next 16.4.0
  └ eslint-plugin-react-hooks 7.1.1 (React-Compiler rules ON as errors), typescript-eslint 8.71.1,
    @next/eslint-plugin-next 16.4.0, eslint-plugin-react 7.37.5
echarts 6.1.0 (zrender 6.1.0, tslib 2.3.0), echarts-for-react 3.0.6 (size-sensor, fast-deep-equal)
tsx 4.23.15 (esbuild ~0.28), concurrently 10.0.6 (engines: node >= 22)
SQLite inside Node 22.16: 3.49.1
```

`npm audit`: 5 "high" (braces → micromatch → fast-glob → @next/eslint-plugin-next). Dev-only. **Do NOT run
`npm audit fix --force`** – it would downgrade eslint-config-next to 14.2.35.

`npx next info` → Platform win32 x64, 28 cores, 32 GB, next 16.4.0 "Latest available version is detected".

---

## 2. Scaffold – command, output, surprises

```bash
npx --yes create-next-app@latest app --ts --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-npm --yes --disable-git --no-agent-feedback
```
Took 23.7 s (incl. npm install of 437 packages). Flags that exist in create-next-app 16.4.0:
`--ts --js --tailwind --react-compiler --cache-components --eslint --biome --app --src-dir --rspack
--import-alias --api --empty --use-npm/pnpm/yarn/bun --reset --skip-install --yes --example --agents-md
(default on) --agent-feedback/--no-agent-feedback --disable-git`. There is **no `--turbopack` flag** (default).

Generated files: `AGENTS.md` (tells agents to read `node_modules/next/dist/docs/` – the full Next docs are
bundled there, 472 md files – very useful, `next dev` re-adds this block), `eslint.config.mjs`, `next.config.ts`,
`tsconfig.json`, `src/app/{layout,page}.tsx`, `globals.css`, `.gitignore` (already ignores `next-env.d.ts`),
**no** `postcss.config.mjs`, **no** `tailwind.config`.

**Surprises in the generated config (16.4 template):**

```ts
// next.config.ts as generated (with --yes)
const nextConfig: NextConfig = {
  cacheComponents: true,        // enabled although --cache-components was not passed
  partialPrefetching: true,     // new in 16.3, requires cacheComponents
  turbopack: {
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } }, // Tailwind via Turbopack loader
  },
};
```
- Tailwind is processed by the `@tailwindcss/turbopack` loader rule, not PostCSS → `next build --webpack` would
  NOT process Tailwind (irrelevant, stay on Turbopack).
- `layout.tsx` uses the global type helper `LayoutProps<"/">` (also `PageProps<"/route">`, `RouteContext<"/api/x/[id]">`).
  These are generated by `next dev` / `next build` / `next typegen` into `.next/types` → a standalone `tsc` needs
  `next typegen` first (else `Cannot find name 'RouteContext'`).
- `package.json` scripts: `dev: next dev`, `build: next build`, `start: next start`, `lint: eslint`.

---

## 3. Item 1 – node:sqlite in a Route Handler

### Results (VERIFIED)
- `import { DatabaseSync } from "node:sqlite"` in route handlers / server components: **no Turbopack error** in dev
  or build; no `serverExternalPackages`, no `runtime` export needed (node runtime is the default).
- With `cacheComponents: true`, `export const runtime = "nodejs"` → **build error**:
  `Route segment config "runtime" is not compatible with nextConfig.cacheComponents. Please remove it.`
  Same for `export const dynamic = "force-dynamic"`. (The docs table claims runtime is allowed – it is not in 16.4.0.)
- **Prerender trap:** a GET handler that only does a synchronous `node:sqlite` query (no `request` access, no
  `connection()`) is shown as `○ /api/db-static (Static)` in `next build`; its build-time result was written to
  `.next/server/app/api/db-static.body` (pid of a build worker) and `next start` served those stale rows.
  The build also opened/created the DB file during "Generating static pages".
  With `cacheComponents: false` the same handler is `ƒ (Dynamic)` (GET handlers dynamic by default).
  Fix that works in both modes: `await connection()` (from `next/server`) before the query → `ƒ`.
  Next 16.3+ also has `io()` from `next/cache` (docs: prefer `io()` in Server Components; `connection()` is the
  documented choice for sync drivers in route handlers / data helpers).
- **Types:** template's `@types/node@^20` has no `sqlite.d.ts` → `TS2307: Cannot find module 'node:sqlite'`.
  `npm i -D @types/node@^22` (22.20.5) fixes it and also types `timeout` and `setReturnArrays`.
- Node 22.16 API available: `new DatabaseSync(path, { timeout })` (busy_timeout), `prepare`, `exec`, `iterate`,
  `columns`, `setReturnArrays`, `setReadBigInts`, `setAllowBareNamedParameters`, `backup`, `createSession`,
  `function`, `aggregate`. Rows are **null-prototype objects**; `run()` returns `{ changes, lastInsertRowid }`
  (number by default; wrap in `Number()` before JSON, can be bigint).
- **Null-prototype rows + RSC:** passing raw rows from a Server Component to a Client Component throws
  `Only plain objects, and a few built-ins, can be passed to Client Components from Server Components. Classes or
  null prototypes are not supported.` → map with `({...r})`. (`Response.json(rows)` is fine.)
- Engine (writer, 2 inserts/s) + Next (reader) on the same WAL file concurrently: no SQLITE_BUSY seen.
- HMR in dev re-evaluates modules → keep the connection on `globalThis` (one per process).
- `"server-only"` works in Next without installing the package and gives a clear build error if a Client
  Component imports the DB module. **But** under tsx the package is missing → `ERR_MODULE_NOT_FOUND`. So: shared
  modules used by the engine must NOT import `server-only`; put it only in the Next-side wrapper.
- `path.join(process.cwd(), "data")`: no tracing warnings in `next build` (with or without
  `/* turbopackIgnore: true */`; comment is harmless). `process.cwd()` = project root in dev, start and engine.

### Code (VERIFIED)

`src/lib/shared/db.ts` (shared by engine + Next, no Next imports):
```ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "data");
export const DB_FILE = path.join(DATA_DIR, "netdiag.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,           -- epoch ms
  target  TEXT    NOT NULL,
  rtt_ms  REAL                        -- NULL = lost
);
CREATE INDEX IF NOT EXISTS idx_samples_target_ts ON samples(target, ts);
`;

export function openDb(file = DB_FILE): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000 }); // busy_timeout 5 s (Node >= 22.16)
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
```

`src/lib/server/db.ts` (Next only):
```ts
import "server-only";
import { connection } from "next/server";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openDb } from "@/lib/shared/db";

type Stmts = { insert: StatementSync; latest: StatementSync; series: StatementSync };
const g = globalThis as unknown as { __netdiagDb?: { db: DatabaseSync; s: Stmts } };

export function getDb() {
  if (!g.__netdiagDb) {
    const db = openDb();
    const s: Stmts = {
      insert: db.prepare("INSERT INTO samples (ts, target, rtt_ms) VALUES (?, ?, ?)"),
      latest: db.prepare("SELECT id, ts, target, rtt_ms FROM samples ORDER BY id DESC LIMIT ?"),
      series: db.prepare("SELECT ts, rtt_ms FROM samples WHERE target = ? AND ts >= ? ORDER BY ts"),
    };
    s.series.setReturnArrays(true); // [[ts, rtt], ...] -> compact for charts
    g.__netdiagDb = { db, s };
  }
  return g.__netdiagDb;
}

/** Use in route handlers / server components: never baked into a build-time prerender. */
export async function dbForRequest() {
  await connection();
  return getDb();
}
```

`src/app/api/db/route.ts`:
```ts
import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";

export async function GET(request: NextRequest) {
  await connection(); // (or: const { s } = await dbForRequest();)
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 20), 1000);
  const { s } = getDb();
  const rows = s.latest.all(limit);
  const series = s.series.all("1.1.1.1", Date.now() - 3600_000);
  return Response.json({ rows, seriesPoints: series.length });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { target?: string; rttMs?: number | null };
  const { s } = getDb();
  const info = s.insert.run(Date.now(), body.target ?? "1.1.1.1", body.rttMs ?? null);
  return Response.json({ id: Number(info.lastInsertRowid), changes: Number(info.changes) });
}
```
Measured in dev: POST 240 ms first call (compile), GET 17 ms; query 0.3 ms.

Server Component variant (needs `<Suspense>` with cacheComponents):
```tsx
async function Rows() {
  const { s } = await dbForRequest();
  const rows = (s.latest.all(10) as Row[]).map((r) => ({ ...r })); // strip null prototype!
  return <HistoryTable rows={rows} />;
}
export default function Page() {
  return <Suspense fallback={<p>lade…</p>}><Rows /></Suspense>;
}
```
→ built as `◐ /history (Partial Prerender)` with cacheComponents, `ƒ` without.

### SQLite performance (node:sqlite, WAL, synchronous=NORMAL) – VERIFIED on this PC
| Operation | Time |
|---|---|
| 1,000,000 inserts in one transaction | 1,225 ms |
| autocommit single insert (engine style) | 0.020 ms each |
| range query 50k rows, `setReturnArrays(true)` | 17.9 ms (objects: 43.7 ms) |
| `JSON.stringify` of those 50k `[ts, rtt]` | 9.8 ms, 1.73 MB |
| per-minute `GROUP BY` over 24 h (86.4k rows → 1,441 buckets) | 25 ms |
| per-minute `GROUP BY` over 7 d (604.8k rows → 10,081 buckets) | 170 ms |
| file size | 58.7 MB per 1M rows (~5 MB/day per target at 1 Hz) |

→ Recommend: integer `target_id` instead of TEXT, engine-maintained rollup tables (per minute / per hour) for long
ranges, retention job for raw samples.

### ExperimentalWarning `SQLite is an experimental feature…`
- Printed by `next dev` (twice per process), by `next build` workers (4×) and by the engine.
- **Fix (VERIFIED):** project-level `.npmrc`
  ```ini
  node-options=--disable-warning=ExperimentalWarning
  ```
  npm sets `NODE_OPTIONS` for every lifecycle script **and for `npx`** → no warnings in `npm run dev/build/start`,
  nor in `npx next build`, nor in Next's worker processes. Works identically in cmd.exe / PowerShell / Git Bash.
- `"x": "NODE_OPTIONS=... node ..."` inside package.json fails on Windows (cmd.exe: `Der Befehl "NODE_OPTIONS" ist
  entweder falsch geschrieben…`) – VERIFIED. (`cross-env` would also work but is unnecessary.)
- Belt and braces for the engine: `node --disable-warning=ExperimentalWarning --import tsx engine/index.ts` or
  `tsx --disable-warning=ExperimentalWarning engine/index.ts` (both VERIFIED). Note `.npmrc node-options` REPLACES a
  user-level NODE_OPTIONS for scripts.

---

## 4. Item 2 – SSE route handler + proxy from 127.0.0.1:3901

### Results (VERIFIED in `next dev` and `next start`, curl + real headless Chrome via CDP)
- Events arrive incrementally (curl: ~1 event/s; Chrome EventSource: `open`, 5 events in 6 s native, 11–12 via
  engine proxy at 2/s).
- Client disconnect → `request.signal` fires `abort` every time (stats: opened == aborted, open == 0).
  `ReadableStream.cancel()` was **never** called in 16.4.0 → do cleanup in the abort listener (keep `cancel` too).
- Proxy: `fetch(ENGINE, { signal: request.signal })` → when the browser leaves, the engine logs
  `SSE client closed` immediately (dev + prod).
- Engine restart while the page is open: stream ends → EventSource reconnects after `retry: 3000` → events resume
  (21 events in 14 s with one restart).
- **Engine offline:** returning `503 JSON` makes Chrome's EventSource go to `readyState 2` and never retry
  (VERIFIED). Returning `200 text/event-stream` with `retry: 3000` + `event: offline` and closing → browser retries
  every 3 s and resumes automatically when the engine comes back (VERIFIED).
- Compression: `next start` gzips HTML pages but did **not** gzip route-handler responses (JSON or SSE), with or
  without `Cache-Control: no-transform` (VERIFIED with `Accept-Encoding: gzip, deflate, br`). Keep `no-transform`
  + `X-Accel-Buffering: no` anyway (harmless, protects behind proxies).
- Headless-Chrome note for testers: `--dump-dom --virtual-time-budget` never finishes on pages with an open SSE
  stream (virtual time waits for network idle) – use a CDP script (see §16).

### Code
`src/lib/shared/sse.ts`:
```ts
export function sseFrame(event: string | null, data: unknown, id?: string | number): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  let out = "";
  if (id !== undefined) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  for (const line of payload.split(/\r?\n/)) out += `data: ${line}\n`;
  return out + "\n";
}
export const sseComment = (text = "hb") => `: ${text}\n\n`;
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
```

`src/app/api/sse/route.ts` (native stream):
```ts
import { connection } from "next/server";
import { SSE_HEADERS, sseComment, sseFrame } from "@/lib/shared/sse";

export async function GET(request: Request) {
  await connection();
  const enc = new TextEncoder();
  let tick: ReturnType<typeof setInterval> | undefined;
  let hb: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let n = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    clearInterval(hb);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => { if (!closed) controller.enqueue(enc.encode(s)); };
      send("retry: 3000\n\n");
      tick = setInterval(() => send(sseFrame("tick", { n: ++n, ts: Date.now() }, n)), 1000);
      hb = setInterval(() => send(sseComment()), 15_000);
      request.signal.addEventListener("abort", () => {
        cleanup();
        try { controller.close(); } catch {}
      });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
```

`src/app/api/live/route.ts` (proxy to the engine):
```ts
import { connection } from "next/server";
import { ENGINE_URL } from "@/lib/shared/constants"; // "http://127.0.0.1:3901"
import { SSE_HEADERS, sseFrame } from "@/lib/shared/sse";

function offline(reason: string) { // 200 + retry => EventSource keeps reconnecting
  return new Response(`retry: 3000\n\n${sseFrame("offline", { reason })}`, { headers: SSE_HEADERS });
}

export async function GET(request: Request) {
  await connection();
  let upstream: Response;
  try {
    upstream = await fetch(`${ENGINE_URL}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    return offline("engine offline");
  }
  if (!upstream.ok || !upstream.body) return offline(`engine HTTP ${upstream.status}`);

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        try { controller.close(); } catch {}
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
```

Generic JSON control proxy `src/app/api/engine/[...path]/route.ts` (VERIFIED: status, POST control, 404 passthrough):
```ts
import type { NextRequest } from "next/server";
import { ENGINE_URL } from "@/lib/shared/constants";

async function proxy(request: NextRequest, ctx: RouteContext<"/api/engine/[...path]">) {
  const { path } = await ctx.params;
  const url = `${ENGINE_URL}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  try {
    const res = await fetch(url, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: "engine offline" }, { status: 503 });
  }
}
export { proxy as GET, proxy as POST };
```

Client (`"use client"`):
```tsx
useEffect(() => {
  const es = new EventSource("/api/live");
  es.onopen = () => setState("open");
  es.onerror = () => setState(es.readyState === EventSource.CLOSED ? "dead" : "reconnecting");
  const onSample = (e: MessageEvent<string>) => { /* JSON.parse(e.data) */ };
  const onOffline = () => setState("offline");
  es.addEventListener("sample", onSample);
  es.addEventListener("offline", onOffline);
  return () => es.close(); // server sees abort
}, []);
```
Not tested: streams longer than ~15 s through Next (heartbeat every 15 s is in place) – UNVERIFIED for hours-long
streams, but nothing in Next imposes a route-handler timeout under `next start` (UNCERTAIN). Not tested: Next
`rewrites` as SSE proxy (route handler chosen instead).

---

## 5. Item 3 – ECharts 6.1 in client components

### Results (VERIFIED: dev + prod, real Chrome)
- Direct `echarts/core` tree-shaken setup: renders line (time axis, 50,000 points, `sampling: "lttb"`,
  `dataZoom` inside + slider, markLine, gaps for `null` = loss via `connectNulls: false`) and heatmap (7×24 with
  `visualMap`). setOption→`finished`: 22 ms (dev) / 65 ms (prod) in headless Chrome without GPU; JS heap 22–35 MB.
  No console errors. React StrictMode double-mount handled (init → dispose → init).
- echarts-for-react 3.0.6 (`echarts-for-react/lib/core` + our tree-shaken `echarts`) works with React 19.3 in dev
  (StrictMode) and prod; no console warnings. Code review of 3.0.6: class `PureComponent`; on mount it calls
  `echarts.init`, waits for `finished`, **disposes and re-inits** with fixed pixel width/height (double init);
  every update deep-compares `option` with fast-deep-equal (expensive for 50k-point arrays on each re-render);
  uses `size-sensor` for resize. → Prefer the own wrapper; efr is an acceptable fallback.
- Gotchas found:
  1. `import * as langDE from "echarts/i18n/langDE-obj.js"` → **runtime crash** `source.hasOwnProperty is not a
     function` in `echarts.init(..., {locale:"DE"})` (namespace object has null prototype). Use a **default import**
     (`import langDE from "echarts/i18n/langDE-obj.js"`) + `echarts.registerLocale("DE", langDE)` + a `.d.ts`.
  2. Canvas cannot resolve CSS `var(--font-…)` in theme `fontFamily` → falls back to default font. Read the real
     next/font family names via `getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains-mono")`
     at first init (lazy `ensureTheme()`), then fonts render correctly (VERIFIED by screenshot).
  3. zrender cannot parse `oklch()` for interpolation (visualMap etc.) → keep chart colors as hex constants that
     mirror the Tailwind tokens.
  4. eslint-plugin-react-hooks 7 errors on `ref.current = x` during render (`react-hooks/refs`) and on
     `performance.now()` in render (`react-hooks/purity`) → use `useEffectEvent` (stable in React 19.2+) for
     callbacks.
  5. Theme files `echarts/theme/*.js` are UMD requiring `echarts/lib/echarts` → register a custom theme object instead.
- Bundle impact (prod, Chrome resource timing, encoded = gzip):
  | Chunk set | gzip | raw |
  |---|---|---|
  | Framework baseline (React 19.3 + Next 16.4 runtime, every page) | ≈132 KB | ≈447 KB |
  | ECharts tree-shaken (line, heatmap, scatter, bar; grid, tooltip, dataZoom, visualMap, title, legend, markLine, markArea; canvas; DE locale) | 225–233 KB | 680–696 KB |
  | Full `import * as echarts from "echarts"` | +150 KB on top (≈384 KB) | +460 KB |
  | echarts-for-react wrapper | ≈ +5–7 KB | ≈ +17 KB |
  | Page code (demo) | 1.5–6 KB | |
  Note: `next build` in v16 no longer prints "First Load JS"; use `next analyze` (`-o` writes files without UI) or
  resource timing. With `<Link>` prefetching, chart chunks are prefetched from pages linking to chart routes.

### Code
`src/components/charts/echarts.ts` (registration; import only from client components):
```ts
import * as echarts from "echarts/core";
import { HeatmapChart, LineChart, ScatterChart, BarChart } from "echarts/charts";
import {
  DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent,
  TitleComponent, TooltipComponent, VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ComposeOption } from "echarts/core";
import type { BarSeriesOption, HeatmapSeriesOption, LineSeriesOption, ScatterSeriesOption } from "echarts/charts";
import type {
  DataZoomComponentOption, GridComponentOption, LegendComponentOption, MarkAreaComponentOption,
  MarkLineComponentOption, TitleComponentOption, TooltipComponentOption, VisualMapComponentOption,
} from "echarts/components";
import langDE from "echarts/i18n/langDE-obj.js"; // default import! (namespace import crashes init)

echarts.use([LineChart, HeatmapChart, ScatterChart, BarChart, GridComponent, TooltipComponent,
  DataZoomComponent, VisualMapComponent, TitleComponent, LegendComponent, MarkLineComponent,
  MarkAreaComponent, CanvasRenderer]);

export type ECOption = ComposeOption<
  | LineSeriesOption | HeatmapSeriesOption | ScatterSeriesOption | BarSeriesOption
  | GridComponentOption | TooltipComponentOption | DataZoomComponentOption | VisualMapComponentOption
  | TitleComponentOption | LegendComponentOption | MarkLineComponentOption | MarkAreaComponentOption
>;

export const C = { line: "#2a3342", ink: "#e8ecf3", muted: "#9aa4b5", signal: "#22d3ee",
  ok: "#34d399", warn: "#fbbf24", loss: "#f87171", violet: "#a78bfa" };
export const THEME = "netdiag-dark";
echarts.registerLocale("DE", langDE);

let themed = false;
export function ensureTheme() { // browser only: canvas can't resolve CSS var() fonts
  if (themed) return;
  themed = true;
  const css = getComputedStyle(document.documentElement);
  const mono = css.getPropertyValue("--font-jetbrains-mono").trim() || "monospace";
  const sans = css.getPropertyValue("--font-space-grotesk").trim() || "sans-serif";
  echarts.registerTheme(THEME, {
    darkMode: true,
    backgroundColor: "transparent",
    color: [C.signal, C.violet, C.ok, C.warn, C.loss],
    textStyle: { color: C.ink, fontFamily: mono },
    title: { textStyle: { color: C.ink, fontFamily: sans }, subtextStyle: { color: C.muted } },
    legend: { textStyle: { color: C.muted } },
    tooltip: { backgroundColor: "rgba(17,22,32,0.95)", borderColor: C.line, textStyle: { color: C.ink } },
    categoryAxis: { axisLine: { lineStyle: { color: C.line } }, axisLabel: { color: C.muted }, splitLine: { show: false } },
    valueAxis: { axisLine: { lineStyle: { color: C.line } }, axisLabel: { color: C.muted },
      splitLine: { lineStyle: { color: C.line, type: "dashed" } } },
    timeAxis: { axisLine: { lineStyle: { color: C.line } }, axisLabel: { color: C.muted }, splitLine: { show: false } },
    dataZoom: { borderColor: C.line, textStyle: { color: C.muted }, fillerColor: "rgba(34,211,238,0.12)",
      handleStyle: { color: C.signal, borderColor: C.signal } },
    visualMap: { textStyle: { color: C.muted } },
  });
}
export { echarts };
```
`src/types/echarts-i18n.d.ts`:
```ts
declare module "echarts/i18n/langDE-obj.js" {
  import type { registerLocale } from "echarts/core";
  const locale: Parameters<typeof registerLocale>[1];
  export default locale;
}
```
`src/components/charts/EChart.tsx`:
```tsx
"use client";
import { useEffect, useEffectEvent, useRef } from "react";
import type { EChartsType, SetOptionOpts } from "echarts/core";
import { echarts, ensureTheme, THEME, type ECOption } from "./echarts";

type Props = { option: ECOption; className?: string; setOptionOpts?: SetOptionOpts;
  onReady?: (chart: EChartsType) => void };

export function EChart({ option, className, setOptionOpts, onReady }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const fireReady = useEffectEvent((chart: EChartsType) => onReady?.(chart));

  useEffect(() => {
    const el = elRef.current!;
    ensureTheme();
    const chart = echarts.init(el, THEME, { renderer: "canvas", locale: "DE" });
    chartRef.current = chart;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => chart.resize());
    });
    ro.observe(el);
    fireReady(chart);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); chart.dispose(); chartRef.current = null; };
  }, []);

  useEffect(() => { chartRef.current?.setOption(option, setOptionOpts); }, [option, setOptionOpts]);

  return <div ref={elRef} className={className} />;
}
```
Line option used (excerpt): `animation:false; xAxis:{type:"time"}; yAxis:{type:"value",name:"ms",min:0};
dataZoom:[{type:"inside",throttle:50},{type:"slider",height:28,bottom:16}]; series:[{type:"line",data:[[ts,rtt|null],…],
showSymbol:false, sampling:"lttb", connectNulls:false, markLine:{data:[{yAxis:100}]}}]`.
Heatmap: `xAxis category 00:00–23:00, yAxis category days, visualMap{min:0,max:5,calculable:true,orient:"horizontal",
inRange:{color:["#0e2a33",signal,warn,loss]}}, series:[{type:"heatmap",data:[[h,d,loss%],…]}]`.
echarts-for-react usage (if wanted): `import ReactEChartsCore from "echarts-for-react/lib/core";
<ReactEChartsCore echarts={echarts} option={opt} theme={THEME} opts={{renderer:"canvas",locale:"DE"}} notMerge lazyUpdate />`
(call `ensureTheme()` at module level guarded by `typeof window !== "undefined"`, because efr inits in
componentDidMount before parent effects).
Not measured: live append cost at 1–2 Hz on 50k points (UNVERIFIED; expect ~20–60 ms per full `setOption`;
consider ring buffer + throttled updates; `appendData` not applicable to line series – UNCERTAIN).

---

## 6. Item 4 – Engine process (tsx) + concurrently

### Results (VERIFIED)
- `tsx` 4.23.15 honours tsconfig `paths` (`@/*` → `./src/*`) for direct and **transitive runtime** imports (engine →
  `@/lib/shared/sse` → `@/lib/shared/constants`), in `tsx`, `tsx watch` and `node --import tsx`.
  Relative imports (`../src/lib/shared/sse`) also work. Either is fine; aliases keep Next and engine imports identical.
- Without `"type": "module"`, tsx compiles `.ts` as CJS → top-level await fails:
  `ERROR: Top-level await is currently not supported with the "cjs" output format`. With `"type": "module"` it works;
  Next 16.4 dev/build/start unaffected. (Alternative: no top-level await / `.mts` entry.)
- `tsx watch --clear-screen=false engine/index.ts` restarts on changes of imported files (incl. `src/lib/shared/*`),
  not on SQLite writes in `data/`. Turbopack's watcher was also not disturbed by 2 writes/s into `data/`
  (the only "waiting for the filesystem to settle" messages came from `npm install` during dev).
- On Windows the engine's SIGINT/SIGTERM handler did **not** run on tsx-watch restarts or taskkill (hard kill).
  WAL recovered cleanly every time → make the engine crash-safe (no in-memory-only state that must be flushed;
  idempotent startup).
- concurrently 10.0.6 runs scripts via **cmd.exe** on Windows; the scripts below contain no bash-isms.
  `--kill-others-on-fail` (dev) / `--restart-tries -1 --restart-after 3000` (prod) work. `--restart-after
  exponential` = `2^n * 1000 ms` and never resets (17 min after 10 crashes) → use a fixed delay. Restarts happen only
  on non-zero exit codes.
- Production start: `next start` ready in ~180–200 ms, engine via `node --import tsx` (tsx must then be installed –
  move `tsx` to `dependencies` if you ever install with `--omit=dev`).
- **Windows process tree gotcha (test tooling):** killing the parent shell/npm does not kill the children; orphaned
  `next dev` (730 MB) kept serving. Use `taskkill /PID <npm-pid> /T /F` (concurrently itself uses tree-kill, fine).
  Ctrl+C in a console window reaches all processes of the console group (normal user workflow) – UNVERIFIED here.

### Final scripts (VERIFIED with ports 3123/3124 – use 3000)
```json
{
  "type": "module",
  "scripts": {
    "dev": "concurrently -n web,engine -c cyan,magenta --kill-others-on-fail \"next dev -H 127.0.0.1 -p 3000\" \"tsx watch --clear-screen=false engine/index.ts\"",
    "dev:web": "next dev -H 127.0.0.1 -p 3000",
    "dev:engine": "tsx watch --clear-screen=false engine/index.ts",
    "build": "next build",
    "start": "concurrently -n web,engine -c cyan,magenta --restart-tries -1 --restart-after 3000 \"next start -H 127.0.0.1 -p 3000\" \"node --import tsx engine/index.ts\"",
    "start:engine": "node --import tsx engine/index.ts",
    "lint": "eslint",
    "typecheck": "next typegen && tsc --noEmit"
  }
}
```
(`npm:` shortcuts like `"npm:dev:web"` also work but add 2 extra npm/cmd processes per command.)
`.npmrc`: `node-options=--disable-warning=ExperimentalWarning`.
`.gitignore` additions: `/data/`, `.eslintcache`.

### Engine stub (VERIFIED)
```ts
import http from "node:http";
import { ENGINE_HOST, ENGINE_PORT, type ProbeSample } from "@/lib/shared/constants";
import { openDb } from "@/lib/shared/db";
import { sampleToFrame, sseComment } from "@/lib/shared/sse";

const db = openDb();
const insert = db.prepare("INSERT INTO samples (ts, target, rtt_ms) VALUES (?, ?, ?)");
const clients = new Set<http.ServerResponse>();
let seq = 0, running = true;
const broadcast = (frame: string) => { for (const res of clients) res.write(frame); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running, clients: clients.size, seq, pid: process.pid }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/control") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const cmd = JSON.parse(body || "{}") as { action?: "start" | "stop" };
    if (cmd.action) running = cmd.action === "start";
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
});

setInterval(() => {
  if (!running) return;
  const s: ProbeSample = { ts: Date.now(), target: "1.1.1.1", rttMs: 15 + Math.random() * 10 };
  insert.run(s.ts, s.target, s.rttMs);
  broadcast(sampleToFrame(s, ++seq));
}, 500);
setInterval(() => broadcast(sseComment()), 15_000);
server.listen(ENGINE_PORT, ENGINE_HOST); // 127.0.0.1:3901 only
```

---

## 7. Item 5 – TypeScript & ESLint

- create-next-app installs **typescript 5.9.3** (`^5`). `next build` type-check passes ("Finished TypeScript in
  ~1.4 s"); `tsconfig.json` includes `**/*.ts` → `engine/` is type-checked too.
- Next 16.4 runs the project-local `tsc` CLI for build type-checking by default (`experimental.useTypeScriptCli`,
  docs). With **TS 7.0.2**: `tsc --noEmit` 1.4 s and `next build` OK (TS step 273 ms) **but ESLint fails**:
  `typescript-eslint does not support TS 7.0`. → keep `typescript@^5` (VERIFIED, reverted).
- Standalone `tsc --noEmit` needs `next typegen` first (global `RouteContext`/`PageProps`/`LayoutProps` types).
- ESLint 9 flat config generated:
  ```js
  import { defineConfig, globalIgnores } from "eslint/config";
  import nextVitals from "eslint-config-next/core-web-vitals";
  import nextTs from "eslint-config-next/typescript";
  export default defineConfig([...nextVitals, ...nextTs,
    globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"])]);
  ```
- `next lint` **removed**: `npx next lint` → `Invalid project directory provided, no such directory: …\lint`.
  Use `"lint": "eslint"` (optionally `eslint --cache`). `next build` no longer lints.
- Timings: eslint cold 8.3 s (a very first run took 38 s – cold disk/AV), warm 2.0–2.7 s; `npm run typecheck` 1.9 s.
- eslint-plugin-react-hooks 7.1.1 rules active as **errors**: `refs`, `purity`, `set-state-in-effect`,
  `set-state-in-render`, `immutability`, `globals`, `static-components`, `use-memo`, `preserve-manual-memoization`,
  `error-boundaries`, `config`, `gating` (+ `exhaustive-deps`, `incompatible-library` as warnings).
  Practical rules: no `ref.current = …` in render (use `useEffectEvent`), no `Date.now()/performance.now()/Math.random()`
  in render, no synchronous `setState` directly in an effect body (in event/async callbacks is fine).

---

## 8. Item 6 – next/font/google

```tsx
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin", "latin-ext"], display: "swap" });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin", "latin-ext"], display: "swap" });
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg font-sans text-ink">{children}</body>
    </html>
  );
}
```
VERIFIED: builds; self-hosted variable woff2 (Space Grotesk `font-weight: 300 700`, JetBrains Mono `100 800`,
9 files incl. latin-ext); computed `body` font = `"Space Grotesk", "Space Grotesk Fallback", …`. Fonts are fetched
from Google at first dev/build (worked here; an offline build would fail – UNVERIFIED).

---

## 9. Item 7 – Tailwind v4 CSS-first (dark-only)

`src/app/globals.css` (VERIFIED – utilities generated, CSS 13.9 KB raw / 4.2 KB gzip):
```css
@import "tailwindcss";

/* inline: utilities reference the next/font vars directly */
@theme inline {
  --font-sans: var(--font-space-grotesk), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, monospace;
}

@theme {
  --color-bg: oklch(0.16 0.02 255);
  --color-surface: oklch(0.205 0.025 255);
  --color-surface-2: oklch(0.25 0.03 255);
  --color-line: oklch(0.32 0.03 255);
  --color-ink: oklch(0.95 0.01 255);
  --color-muted: oklch(0.70 0.02 255);
  --color-signal: oklch(0.82 0.15 195);
  --color-ok: oklch(0.78 0.17 150);
  --color-warn: oklch(0.83 0.16 85);
  --color-loss: oklch(0.68 0.21 25);
  --color-violet: oklch(0.72 0.17 295);
  --radius-card: 0.875rem;
  --shadow-glow: 0 0 0 1px oklch(0.82 0.15 195 / 0.25), 0 0 24px -4px oklch(0.82 0.15 195 / 0.35);
  --animate-pulse-dot: pulse-dot 1.6s ease-in-out infinite;
  @keyframes pulse-dot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.8); } }
}

@utility card { border-radius: var(--radius-card); background-color: var(--color-surface); border: 1px solid var(--color-line); }
@utility card-glow { box-shadow: var(--shadow-glow); }
@utility grid-bg {
  background-image: linear-gradient(to right, oklch(0.32 0.03 255 / .35) 1px, transparent 1px),
                    linear-gradient(to bottom, oklch(0.32 0.03 255 / .35) 1px, transparent 1px);
  background-size: 32px 32px;
}
@utility glow-* { box-shadow: 0 0 18px -2px --value(--color-*); }   /* functional: glow-signal, hover:glow-loss … */

@layer base {
  :root { color-scheme: dark; }
  html, body { background-color: var(--color-bg); color: var(--color-ink); }
  body { font-family: var(--font-sans); }
}
```
Observed output: `bg-bg text-ink text-signal bg-ok animate-pulse-dot font-mono card card-glow grid-bg` generated;
`hover:glow-signal` → `@media (hover:hover){.hover\:glow-signal:hover{box-shadow:0 0 18px -2px var(--color-signal)}}`;
oklch tokens are emitted with hex fallback + `lab()` (Lightning CSS). Dark-only = no `dark:` variants needed, the
template's `prefers-color-scheme` block was removed. Unused tokens produce no utilities (on demand).

---

## 10. cacheComponents: on or off? (both VERIFIED)

| | `cacheComponents: true` (template) | `false` (remove both flags) |
|---|---|---|
| GET handler with sync sqlite, no request access | **○ Static – stale build-time data**, DB opened at build | ƒ Dynamic |
| `export const dynamic` / `runtime` | build error | allowed |
| Async server component reading data | must be inside `<Suspense>` (◐ PPR) | free |
| Navigation | React `<Activity>` keeps hidden routes mounted; effects cleaned up/re-run (EventSource closes/reopens, charts dispose/re-init) | classic unmount |
| Future | "enabled everywhere in the next major" | option disappears in Next 17 |

Recommendation: **set `cacheComponents: false` and drop `partialPrefetching`** for this single-user, live-data local
tool (no benefit from static shells; GET handlers dynamic by default = no silent stale-data trap). Regardless of the
flag: every Next-side DB access via `await dbForRequest()` (connection()), no `export const dynamic/runtime`,
Suspense around async server components → code stays valid if the flag is flipped. (If the lead prefers keeping the
template default: also fully verified, just follow the same rules.)

---

## 11. Timings (this PC: 28 cores, 32 GB)

| Step | Time |
|---|---|
| create-next-app incl. npm install (437 pkgs) | 23.7 s |
| `npm i` echarts + efr / tsx + concurrently | ~2.4 s each |
| `next dev` ready (cold / warm FS cache) | 3.1 s / 0.44 s |
| first `GET /` in dev | 428 ms |
| `next build` clean | 7.1–8.1 s (compile 2.7–3.2 s, TypeScript 1.4 s, static pages 0.8 s) |
| `next build` incremental | 5.7–6.7 s |
| `next start` ready | 176–196 ms |
| eslint cold / warm | 8.3 s / 2.0–2.7 s |
| `tsc --noEmit` (TS 5.9.3 / TS 7.0.2) | 2.4 s / 1.4 s |
| 50k-point line render (setOption→finished, headless Chrome, no GPU) | 22–65 ms |

---

## 12. Gotcha checklist (all VERIFIED unless noted)

1. `@types/node@^20` (template) lacks `node:sqlite` → upgrade to `^22`.
2. Sync sqlite GET handler without `connection()` is prerendered at build (cacheComponents on) → stale data.
3. With cacheComponents: `export const runtime` and `export const dynamic` are build errors.
4. node:sqlite rows have null prototype → spread before passing Server→Client props.
5. `lastInsertRowid`/`changes` may be bigint → `Number()` before JSON.
6. `server-only` must not be imported by modules the engine uses (tsx: ERR_MODULE_NOT_FOUND).
7. Top-level await in the engine needs `"type": "module"`.
8. ExperimentalWarning: `.npmrc node-options=…`; inline env syntax fails in cmd.exe.
9. EventSource + non-200 response = permanent close → offline handling with 200 + `retry`.
10. SSE cleanup: rely on `request.signal` abort (`cancel()` never fired).
11. ECharts locale: default import, not namespace import (crash).
12. ECharts canvas fonts: pass resolved font family names, not `var(--…)`.
13. echarts-for-react: double init + deep compare of big options.
14. `next lint` gone; TS 7 breaks typescript-eslint.
15. `npm audit fix --force` would downgrade eslint-config-next.
16. Windows: orphaned node children after killing a parent shell; use `taskkill /T /F`.
17. `next dev/start` bind 0.0.0.0 by default → pass `-H 127.0.0.1`.
18. Global `RouteContext`/`PageProps` types require `next typegen` before standalone `tsc`.
19. React-Compiler lint rules (refs/purity/set-state-in-effect) are errors.
20. concurrently `--restart-after exponential` grows unbounded → use fixed ms.
21. Git Bash converts leading-slash args (e.g. `/charts`) to `C:/Program Files/Git/charts` – only a shell-testing nuisance.

---

## 13. Test methodology

- curl (`-N --max-time`) for SSE byte counts / headers, `?stats=1` counters in the SSE route for open/abort/cancel.
- Real browser: headless Chrome 154 with a throwaway profile driven over CDP by
  `scratchpad/research/stack/cdp-check.mjs` (Node 22 global WebSocket; collects console errors/exceptions, evaluates
  DOM state, resource timing for bundle sizes). Screenshots: `scratchpad/research/stack/shots/*.png`.
- Build logs: `scratchpad/research/stack/build1.log` (with negative test), `build2.log`.
- SQLite micro-benchmark: `scratchpad/research/sqlite-probe/perf.mjs`.

## 14. Open / uncertain

- Hours-long SSE stability through Next route handlers (tested ≤ 15 s per stream; heartbeat in place).
- Live update cost of 50k-point charts at 1–2 Hz; `appendData` suitability.
- Graceful Ctrl+C shutdown under concurrently in an interactive Windows console (not tested; design crash-safe).
- Offline `next build` with next/font/google (expected to fail; use `next/font/local` if needed).
- `rewrites`-based SSE proxy (not tested; route-handler proxy is verified).
