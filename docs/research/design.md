# Netzpuls – Design System Spec

Visual design system for the German-language local web app that runs a long-term line test and finds the root cause of gaming lag (ping > 200 ms, packet loss) on the user's Vodafone cable line (ARRIS TG6442 "Vodafone Station", DS-Lite).

| | |
|---|---|
| Date | 2026-10-09 |
| Stack (verified versions) | Next.js 16.4.0 (App Router; project currently uses the classic model, code also verified with `cacheComponents: true`), React 19.3, Tailwind CSS 4.3.3 via `@tailwindcss/turbopack`, ECharts 6.1.0 (plain, no echarts-for-react), lucide-react 1.54.0, clsx 2, tailwind-merge 3.7 |
| Deliverables | `theme.css` (tokens + base + utilities + motion), `echarts-theme.ts` (theme + helpers), this file. All component files also exist as real files under `research/design/src/` (same content as below). |
| Verification | **real `next build` + `next start` with Next 16.4 / Turbopack / `@tailwindcss/turbopack`** in an isolated copy (passes with the project's current classic config *and* with `cacheComponents: true`; running app screenshotted) · `tsc --strict` 0 errors (real types of react/next/lucide/echarts) · ESLint with `eslint-config-next` 16.4 (core-web-vitals + typescript, React-Compiler hook rules) 0 findings · Tailwind 4.3.3 compile: every token class used in code is generated · headless Chrome renders: desktop 1440 px, mobile 390 px, light/print theme (screenshots in `research/design/verify/shots/`) · all colours computed and checked (WCAG contrast; dataviz validator for chart palettes) |

---

## 0. Decisions at a glance

1. **Name: Netzpuls** – tagline "Leitungsdiagnose". Mark: a pulse line (cyan) that ends in a packet (violet dot).
2. **Look: "Tiefsee + Glasfaser"** – deep navy layers (hue 258), fibre-cyan as the single interactive accent, laser-violet as secondary, a measurement graticule (24/120 px grid) with a sparse network mesh and 6 travelling "data pulses" in the background. Panels are tinted glass **without** `backdrop-filter` (CPU). Two key panels per page get "Messfenster" corner ticks (`np-frame`).
3. **Signature element: the segment topology "Leitungsweg"** – PC → LAN-Kabel → Router → Kabelnetz (DOCSIS) → Vodafone & AFTR → Internet → Ziele. Links are coloured by health, packets travel along them (CSS `offset-path`), the coax segment is drawn as a wave, the DS-Lite tunnel is bracketed, and on a lossy link one packet visibly **falls out of the line**. Healthy nodes are quiet; only deviations glow.
4. **Tokens: CSS-first, single source of truth.** Every colour is defined once as `light-dark(light, dark)` on `:root`; Tailwind utilities map to them via `@theme inline`. Dark is default; the light "Papier" theme is used for print/report (`data-theme="light"` or automatically in `@media print`). Never use Tailwind `dark:` variants.
5. **Type: Space Grotesk (display) + IBM Plex Sans (UI, variable width axis for long German compounds) + JetBrains Mono (every measured value, IP, MAC, timestamp).** Live values use tabular mono digits so numbers do not jump when they update every second.
6. **Status is reserved and never colour-only:** Gut / Auffällig / Kritisch / Unbekannt (+ Hinweis), always icon + word.
7. **Charts:** 8 validated categorical colours in fixed order + "Sonstige" + "Referenz" (= 10 entries). Colour follows the entity (fixed slot per target), never the rank. No dual y-axes. Heatmaps use a monotone "semantic heat" ramp; segments use an ordinal near→far ramp.
8. **Motion budget:** decorative motion only via `transform`/`opacity`, all tagged `.np-anim`, paused when the tab is hidden or after 90 s without input, off for `prefers-reduced-motion`. The app must never cause the lag it measures.

---

## 1. Product name

| Candidate | Meaning | Pro | Contra |
|---|---|---|---|
| **Netzpuls** ✔ | "pulse of the network" | German, short, says *long-term heartbeat measurement*; obvious mark (pulse → packet); reads well in UI ("Netzpuls läuft") | generic-ish word, but this is a private local tool |
| Paketspur | "packet trail" | evokes hop-by-hop tracing (route/segment diagnosis) | sounds like a one-off trace, not a 24/7 monitor |
| HopScope | hop + oscilloscope | techy, gamer-friendly | anglicism in a German UI; close to existing tool names |

**Chosen: Netzpuls.** Wordmark: "Netzpuls" in Space Grotesk 600, 17 px, tracking −0.01em; sub-line "Leitungsdiagnose" in Plex Sans 11 px `text-fg-3`. Browser title template: `"%s – Netzpuls"`.

---

## 2. Design principles (specific to this product)

1. **Where before how much.** Every screen answers *which segment* and *when*. The Leitungsweg is the anchor on the dashboard and the visual language for segments everywhere else (same order, same icons, same names).
2. **Quiet when healthy, loud on deviation.** The page stays open for hours; green must not shout. Good = muted ring, 40 % light strip; Auffällig/Kritisch = full colour, glow, falling packets.
3. **Numbers are instruments.** All measurements in JetBrains Mono with tabular figures, unit in a smaller, muted weight (`19 ms`). Labels stay in Plex Sans, sentence case, never all-caps.
4. **Evidence over verdict.** A finding always lists measured evidence and its source ("e2fexpress, ID 27"), then one concrete recommendation.
5. **Cheap motion.** Static layers are painted once; only 6 background pulses + packets on 3 links move, compositor-friendly and pausable.
6. **German first.** Decimal comma, NBSP before units and `%`, 24 h clock, Europe/Berlin, „deutsche Anführungszeichen“, en dash for ranges (`18:29–18:43`).

---

## 3. Colour system

All values were computed in OKLCH and checked: WCAG contrast for text/UI, and the dataviz palette validator (Machado 2009 CVD simulation, OKLab ΔE) for chart colours. Dark values are the second argument of `light-dark()`.

### 3.1 Surfaces and lines

| Token (raw) | Tailwind | Dark | Light | Use |
|---|---|---|---|---|
| `--np-void` | `bg-void` | `#02060F` | `#E9EEF4` | outermost edge, drawer backdrop |
| `--np-canvas` | `bg-canvas` | `#040B18` | `#F6F8FB` | app background (on `html`) |
| `--np-sunken` | `bg-sunken` | `#06101F` | `#EEF2F7` | wells, evidence boxes, code |
| `--np-panel` | `bg-panel` | `#0A1627` | `#FFFFFF` | cards, **chart surface** |
| `--np-raised` | `bg-raised` | `#121E31` | `#F0F4F9` | hover, inputs, table header |
| `--np-overlay` | `bg-overlay` | `#19263A` | `#FFFFFF` | tooltip, popover, menu |
| `--np-glass` | via `np-panel` | `rgb(10 22 39/.74)` | `rgb(255 255 255/.86)` | panel tint (no blur) |
| `--np-glass-strong` | `bg-(--np-glass-strong)` | `rgb(6 16 31/.9)` | `rgb(248 250 253/.94)` | sidebar, status bar |
| `--np-line` | `border-line` | `#243144` | `#DCE2E9` | hairlines, panel borders (decorative) |
| `--np-line-strong` | `border-line-strong` | `#404E63` | `#C0C8D3` | table header rule, emphasised dividers |
| `--np-line-control` | `border-line-control` | `#607086` (3.6:1 on panel) | `#828D9C` (3.4:1) | input/checkbox borders (WCAG 1.4.11 ≥ 3:1) |
| `--np-chart-grid` | – | `#182334` | `#E6EBF1` | chart split lines (solid hairline) |
| `--np-chart-axis` | – | `#323E50` | `#C0C8D3` | chart axis line |

### 3.2 Text (contrast on canvas / panel / raised / overlay)

| Token | Tailwind | Dark | Contrast dark | Light | Contrast light | Use |
|---|---|---|---|---|---|---|
| `--np-fg` | `text-fg` | `#EAF1F8` | 17.3 / 15.9 / 14.7 / 13.4 | `#0E1624` | 17.0 / 18.1 / 16.4 / 18.1 | primary text, values |
| `--np-fg-2` | `text-fg-2` | `#BDCADA` | 11.8 / 10.9 / 10.1 / 9.2 | `#394353` | 9.4 / 10.0 / 9.0 / 10.0 | secondary text |
| `--np-fg-3` | `text-fg-3` | `#97A4B6` | 7.8 / 7.2 / 6.6 / 6.0 | `#586475` | 5.6 / 6.0 / 5.4 / 6.0 | muted, axis labels, captions |
| `--np-fg-4` | `text-fg-4` | `#6E7A8B` | 4.5 / 4.2 / 3.8 / 3.5 | `#828D9C` | 3.2 / 3.4 / 3.0 / 3.4 | **decorative/disabled only** (group labels, tick marks) |
| `--np-fg-invert` | `text-fg-invert` | `#00141E` | 10.5 on `fiber-strong` | `#FFFFFF` | 5.8 on `fiber-strong` | text on primary buttons |

### 3.3 Accents

| Token | Tailwind | Dark | Light | Use |
|---|---|---|---|---|
| `--np-fiber` | `text-fiber`, `ring-fiber`, `outline-fiber` | `#2EEBFC` (12.5:1) | `#00758D` (5.3:1) | **the** interactive accent: focus ring, active nav, links, live indicators, single-series charts |
| `--np-fiber-strong` | `bg-fiber-strong` | `#00D5EF` | `#006F87` | primary button fill |
| `--np-fiber-deep` | `bg-fiber-deep` | `#0096AF` | `#005A6E` | pressed state, selection |
| `--np-laser` | `text-laser` | `#B09CFF` (7.8:1) | `#653CBD` | secondary accent: recommendation icon, DS-Lite/tunnel hints, brand dot |
| `--np-laser-strong` | `bg-laser-strong` | `#9874FF` | `#5530A8` | rare fills |
| `--np-aqua` | `text-aqua` | `#50E3C7` | `#00806F` | **only** as gradient stop (`np-gradient-text`: aqua → fiber → laser) – too close to "good" for anything else |

Rule: one accent does the interactive job (fiber). Violet never marks interactivity.

### 3.4 Status (reserved)

| Status | Word (UI) | Icon (lucide) | Token | Dark | Light | Badge text on its 12 % tint |
|---|---|---|---|---|---|---|
| good | **Gut** | `CircleCheck` | `--np-good` / `text-good` | `#54DD7D` | `#087736` | 8.2 / 4.8 |
| warn | **Auffällig** | `TriangleAlert` | `--np-warn` | `#FFBD4A` | `#965800` | 8.7 / 4.8 |
| crit | **Kritisch** | `OctagonAlert` | `--np-crit` | `#FF6367` | `#C2272D` | 5.3 / 4.6 |
| unknown | **Unbekannt** | `CircleQuestionMark` | `--np-unknown` | `#8E99A8` | `#5F6A77` | 5.3 / 4.7 |
| info | **Hinweis** | `Info` | `--np-info` | `#63B9FE` | `#1F68BC` | 6.9 / 4.7 |

- Always icon + word (`<HealthBadge/>`); colour alone never carries meaning.
- Soft fill = `bg-{status}/12` (`/14` for crit), ring = `ring-{status}/30`. Use the prepared maps in `lib/health.ts` (`HEALTH_SOFT`, `HEALTH_TEXT`) so Tailwind sees complete class strings.
- Status colours are never used as chart series colours; when a series *means* good/bad it uses status colours and no categorical colours in the same chart.
- Default thresholds (proposal, editable in Einstellungen): RTT warn 60 / crit 150 ms · Jitter 10 / 30 ms · Loss 0.5 / 2 %.

### 3.5 Segment colours – ordinal ramp "Nah → Fern"

The seven segments are an ordered sequence (distance from the PC), so per dataviz rules they get **one hue with monotone lightness**, not seven unrelated hues. Use them for legends, stacked "where is the time spent" bars, lane markers and chips. **Health is never shown with segment colours** (links/nodes in the topology use status colours).

| # | Segment | Token / class | Dark | Light | Icon |
|---|---|---|---|---|---|
| 1 | PC & Adapter | `--np-seg-pc` / `bg-seg-pc` | `#C2F2F8` | `#45C1D4` | `Monitor` |
| 2 | LAN-Kabel | `--np-seg-lan` | `#86E2F2` | `#03ACC7` | `Cable` |
| 3 | Router | `--np-seg-router` | `#48CEEA` | `#0096B3` | `Router` |
| 4 | Kabelnetz (DOCSIS) | `--np-seg-docsis` | `#09B7DC` | `#007FA0` | `AudioWaveform` |
| 5 | Vodafone & AFTR | `--np-seg-provider` | `#009EC9` | `#006A8D` | `Server` |
| 6 | Internet | `--np-seg-internet` | `#0085B4` | `#005579` | `Globe` |
| 7 | Ziele | `--np-seg-targets` | `#006E9F` | `#004166` | `Target` |

Validator (`--ordinal`): dark PASS (monotone, ΔL ≥ 0.06, darkest step 3.2:1 on panel, hue spread 32°); light PASS (lightest step 2.1:1 on white).

### 3.6 Chart palette (10 entries = 8 categorical + 2 neutral)

| Slot | Name | Dark | Light | Typical use |
|---|---|---|---|---|
| 1 | Cyan | `#00A5C4` | `#0095B5` | first target (e.g. Gateway), Download |
| 2 | Violett | `#9264EF` | `#7544CD` | 1.1.1.1, Upload |
| 3 | Magenta | `#CA358B` | `#9E0067` | 8.8.8.8 |
| 4 | Blau | `#217BF4` | `#0062D4` | 4th target |
| 5 | Orange | `#D16100` | `#CB5A00` | 5th |
| 6 | Petrol | `#008777` | `#008779` | 6th |
| 7 | Gold | `#AE9200` | `#9E8400` | 7th |
| 8 | Orchidee | `#BF64E4` | `#9C40BF` | 8th |
| 9 | Sonstige | `#6E7A8B` | `#9AA4B2` | "Other" fold – never a 9th hue |
| 10 | Referenz | `#BDCADA` | `#394353` | median/baseline, dashed |
| – | Solo | `--np-fiber` | `--np-fiber` | charts that by design have one series (sparklines, single metric trends) |

Validator results (surface = panel):

- Dark, 8 slots, adjacent: lightness band PASS (all L 0.56–0.67) · chroma PASS · CVD worst adjacent ΔE 11.1 (target ≥ 8) PASS · normal-vision worst adjacent 18.8 (≥ 15) PASS · contrast all ≥ 3:1 (3.8–6.2) PASS.
- Dark, first 3 slots, all pairs (scatter-safe): CVD 9.4, normal 18.8 PASS.
- Light, 8 slots: CVD worst 11.7, normal 16.9, contrast all ≥ 3.5:1 PASS; first 3 all-pairs CVD 14.5 PASS.

Rules:
- **Order is fixed; colour follows the entity.** Assign a slot when a target is created (store it), never re-colour on filter (`seriesColor(slot)`).
- Scatter/bubble/small multiples: max 3 series (slots 1–3). More than 8 series → fold into "Sonstige" or use small multiples.
- Lines 2 px, markers ≥ 8 px with 2 px surface ring, area wash 10 %, bars ≤ 24 px with 4 px rounded data end, gridlines solid hairlines; dashed **only** for thresholds/reference.
- Text never wears a series colour (legend, labels, tooltip text stay in ink tokens; the colour sits in the line key).
- Known near-collisions (normal ΔE < 15): dark slot 1 ↔ info (11.2), slot 5 ↔ crit (12.0); in light several warm/blue slots sit near status hues. Mitigation: status always comes with icon/label, info events in charts are drawn neutral (`eventLine` uses `fg3` for info).
- One y-axis per chart. Latency and loss are two charts, not one dual-axis chart.

### 3.7 Heatmap ramp (semantic heat, monotone lightness)

| Step | Dark | L | Light | L | Meaning (loss example, max 5 %) |
|---|---|---|---|---|---|
| 0 | `#1C263A` | 0.27 | `#F0F4F9` | 0.97 | exactly 0 |
| 1 | `#3F316C` | 0.36 | `#F5DFAC` | 0.91 | over 0 |
| 2 | `#76338A` | 0.45 | `#F9B96C` | 0.83 | from 1 |
| 3 | `#BC3181` | 0.55 | `#F47F46` | 0.72 | from 2 |
| 4 | `#EC5258` | 0.65 | `#DB4241` | 0.60 | from 3 |
| 5 | `#FD923E` | 0.76 | `#A02262` | 0.48 | from 4 |
| 6 | `#FFDB68` | 0.90 | `#591E66` | 0.36 | from max |
| – | 135° hatch (`np-hatch`) | | | | no measurement |

Multi-hue is the allowed "semantic heat" exception (monotone L, always with a scale legend). "No data" is a texture, never a colour.

---

## 4. Typography

### 4.1 Families and roles

| Role | Family (next/font/google) | CSS var → Tailwind | Weights | Used for |
|---|---|---|---|---|
| Display | **Space Grotesk** (variable 300–700) | `--font-space-grotesk` → `font-display` | 500, 600 | wordmark, page title, panel titles, node labels in the topology |
| UI | **IBM Plex Sans** (variable wght 100–700 + **wdth 75–100**) | `--font-plex-sans` → `font-sans` (default) | 400, 500, 600 | all UI text, labels, tables, body |
| Data | **JetBrains Mono** (variable 100–800) | `--font-jetbrains-mono` → `font-mono` / `np-num` | 400, 500, 600 | every measured value, unit, IP, MAC, timestamp, log line |

Why Plex instead of Inter: German compounds ("Paketverlustrate", "Link-Abbrüche Ethernet", "Neuverbindungen mit 100 Mbit/s") overflow narrow KPI tiles and table headers. Plex's width axis gives semi-condensed cuts from the same family (`font-stretch-semi-condensed`, `np-label` uses 92 %). Inter is a drop-in fallback if preferred (swap the import; nothing else changes).

Why mono for live values (deviation from the generic dataviz rule "proportional figures for big numbers"): values update every second; tabular mono digits keep width constant (no jitter), and JetBrains Mono separates `0/O`, `1/l` in IPs and MACs. Ligatures are disabled in data (`np-num` sets `calt`/`liga` off) so `->` or `>=` never merge.

### 4.2 Scale (Tailwind T-shirt names, overridden in `@theme` – tailwind-merge compatible)

| Class | Size / line height | Tracking | Use |
|---|---|---|---|
| `text-2xs` | 11 / 16 px | +0.01em | axis ticks, micro captions, group labels |
| `text-xs` | 12 / 16 | +0.005em | chips, badges, captions, KPI labels |
| `text-sm` | 13 / 20 | – | tables, nav, descriptions |
| `text-base` | 14 / 22 | – | default UI text (body) |
| `text-md` | 16 / 24 | – | long text (Bericht), lead paragraphs |
| `text-lg` | 18 / 26 | −0.005em | panel titles, finding titles |
| `text-xl` | 21 / 28 | −0.01em | section titles |
| `text-2xl` | 24 / 32 | −0.015em | page title (h1) |
| `text-3xl` | 32 / 38 | −0.02em | KPI values (mono, semibold) |
| `text-4xl` | 48 / 52 | −0.025em | one hero number per page (e.g. Bericht summary) |
| `text-5xl` | 60 / 64 | −0.03em | wall display only |

Recipes: page title `text-2xl font-semibold` (display via h1 base style) · panel title `text-lg font-medium` · KPI value `np-num text-3xl font-semibold` + unit `np-num text-sm text-fg-3` · table header `text-xs font-medium text-fg-3 font-stretch-semi-condensed` · numeric cell `np-num text-right text-fg`.

### 4.3 Glyph subset caveat

Only the `latin` subset is loaded (contains ä ö ü ß „ “ – — … € − NBSP). **Not** included: `→ ≥ ≤ ≈ Δ ▲ ▼ ✓`. Use lucide icons or words instead ("ab 5 %", "max.", "ca."). Use the true minus `−` (U+2212) for negative dB values (`fmtDb` does this).

### 4.4 Font loading

**`src/app/fonts.ts`**

```ts
import { IBM_Plex_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";

/* Variable Fonts, nur "latin" (enthält ä ö ü ß – € – − …). Next lädt sie beim Build
   und hostet sie selbst: im Browser gehen keine Anfragen an Google.
   Achtung Glyphen: → ≥ ≤ ≈ Δ ▲ liegen NICHT im latin-Subset – im UI Icons/Wörter nutzen. */

export const fontDisplay = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const fontSans = IBM_Plex_Sans({
  subsets: ["latin"],
  axes: ["wdth"], // schmale Schnitte für lange Komposita (font-stretch 75–100 %)
  variable: "--font-plex-sans",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const fontVariables = `${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`;
```

Fonts are downloaded at build/dev time and self-hosted; the browser never contacts Google. (Uncertain: if Google Fonts is unreachable during `next build`, the build may fail – alternative is `next/font/local` with the woff2 files committed to the repo.)

---

## 5. Layout

### 5.1 App shell

```
┌──────────────┬───────────────────────────────────────────────────────────────────┐
│ [≈] Netzpuls │ ● Mess-Engine läuft │ Langzeittest 3 T 04:12:55 │ Nächster Speedtest in 12 min │   Gesamtzustand [⬣ Kritisch] [Pausieren] │
│  Leitungs-   ├───────────────────────────────────────────────────────────────────┤  ← status bar 56 px, sticky, glass-strong
│  diagnose    │ Live-Dashboard                          [Letzte 24 Stunden][Speedtest starten]
│              │ Zustand der Leitung jetzt und in den letzten 24 Stunden …        │
│ Überblick    │ ┌ Leitungsweg (frame) ─────────────────────────────────────────┐ │
│ ▸ Live-Dash. │ │ [PC]──LAN──[Router]∿∿DOCSIS∿∿[Vodafone & AFTR]──Internet──[Ziele] │
│   Verlauf    │ └───────────────────────────────────────────────────────────────┘ │
│   Diagnose   │ ┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐   1 / 2 / 3 / 6 columns                 │
│ Messungen    │ ┌ Latenz je Ziel (2/3) ───────────────┐┌ Ereignisse (1/3) ─────┐   │
│   Speedtest  │ │ ECharts                              ││ 24-h strip + timeline │   │
│   Route      │ └──────────────────────────────────────┘└───────────────────────┘   │
│   Router     │ Befunde: [FindingCard][FindingCard][FindingCard]                   │
│   PC&Adapter │ ┌ Paketverlust nach Tageszeit ┐┌ Ziele (table) ┐                  │
│ Auswertung   │                                                                      │
│   Ereignisse │                                                                      │
│   Bericht    │                                                                      │
│ System       │                                                                      │
│   Messplan   │                                                                      │
│   Einstell.  │                                                                      │
│ Engine …3901 │                                                                      │
└──────────────┴───────────────────────────────────────────────────────────────────┘
```

| Viewport | Sidebar | Status bar | Main padding |
|---|---|---|---|
| < 768 px | off-canvas drawer 288 px (menu button in status bar, Esc/backdrop closes) | menu + mark + engine + health badge | 16 px |
| 768–1279 px | icon rail 72 px (labels `sr-only`, hint in `title`) | + Langzeittest timer (≥ 640) | 24 px |
| ≥ 1280 px | full 256 px with group labels | + next scheduled test | 32 px |
| ≥ 1920 px (`3xl`) | same | same | main max-width 1680 px, centered |

- Main column: `max-w-[1680px]`, vertical rhythm `gap-4` (16 px) between panels, 32 px before a new section heading.
- Panel padding 20 px (`px-5`), header-to-body 16 px. KPI tile padding 16 px.
- Radii (hierarchy, not one radius for everything): panel/tile 16 px · inner surfaces (evidence box, table frame, chart frame) 10 px · controls 8 px (sm buttons 6 px) · chips/badges full.
- Elevation: `shadow-panel` (inner top highlight + soft drop) for panels; `shadow-overlay` for popovers; `shadow-glow` only on hover of the primary button and the active nav marker.
- Filters live in **one row in the page header** (time range first) and scope everything below.

### 5.2 Page recipes (all 11 nav items)

| Route | Page | Content (top → bottom) |
|---|---|---|
| `/` | Live-Dashboard | Leitungsweg (frame) · 6 KPI tiles (Latenz, Jitter, Paketverlust, Ping-Spitzen > 150 ms, Link-Abbrüche, Linkgeschwindigkeit) · Latenz je Ziel (live, 6 h) + Ereignisse (strip + timeline) · top 3 Befunde · Paketverlust nach Tageszeit + Ziele-Tabelle |
| `/verlauf` | Verlauf | header filters: Zeitraum (24 h / 7 T / 30 T / eigener), Ziele · Tabs (Latenz, Jitter, Paketverlust, Durchsatz) with ECharts + `dataZoom` (inside + slider) · outage `markArea`s · table view toggle |
| `/diagnose` | Diagnose | verdict panel "Wahrscheinlichste Ursache" (segment + Sicherheit) · Leitungsweg with attribution · FindingCards sorted by severity · "So wurde geprüft" (checks list with HealthDots) |
| `/speedtest` | Speedtest | start button + InlineProgress · last result KPIs (Download, Upload, Latenz idle vs. unter Last = Bufferbloat) · history chart with 100 Mbit/s link-limit line · table |
| `/route` | Route | traceroute table per hop (Hop, Adresse, Name, RTT min/median/p95, Verlust, Zustand) · hop chain mini-topology · note for non-responding hops ("antwortet nicht auf Ping – normal bei Vodafone-CMTS/AFTR") |
| `/router` | Router | connection card (Vodafone Station 192.168.0.1, Modell, Firmware, DOCSIS-Status, DS-Lite) · DOCSIS channel tables (Pegel dBmV, SNR/MER dB, Codeword-Fehler) + small multiples · login state; never auto-login |
| `/pc-adapter` | PC & Adapter | adapter card (Intel I225-V, Treiber 1.1.4.43, Link 100 Mbit/s vs. 1 Gbit/s) · link-drop timeline from Windows event log · settings table (Energiesparen, Flow Control, Interrupt Moderation) with recommendations · WLAN/WARP route notes |
| `/ereignisse` | Ereignisse | EventStrip (24 h / 7 T) · filter by segment/severity · EventTimeline full height (`stickyOffset={56}`) |
| `/bericht` | Bericht | light "Papier" layout (print-first): summary sentence + hero number, evidence charts (light theme), findings, measurement period, export (PDF via print, CSV) |
| `/messplan` | Messplan | table of probes (Ziel, Intervall, Methode, nächste Ausführung, aktiv) · timeline of scheduled speedtests |
| `/einstellungen` | Einstellungen | Ziele (with fixed colour slot), Schwellen, Router-Zugang (IP 192.168.0.1, Passwort lokal), Hintergrundanimation (Automatisch/An/Aus), Datenhaltung |

---

## 6. Tokens file (`theme.css`)

Place at `src/styles/theme.css`; `src/app/globals.css` becomes:

**`src/app/globals.css`**

```css
@import "tailwindcss";
@import "../styles/theme.css";
```

**`src/styles/theme.css`**

```css
/* ==========================================================================
   NETZPULS – Design-Tokens & Basis-Styles
   Tailwind CSS v4.3 (CSS-first) · Next.js 16 · React 19

   Einbindung (src/app/globals.css):
     @import "tailwindcss";
     @import "../styles/theme.css";

   Themes
   - Dunkel ("Tiefsee") ist Standard.
   - Hell ("Papier") für Bericht/Druck: <html data-theme="light"> oder automatisch
     in @media print. Jeder Farb-Token ist EINMAL definiert: light-dark(hell, dunkel).
     Umschalten passiert nur über color-scheme.
   - Nie Tailwind-`dark:`-Varianten benutzen: die Tokens schalten selbst um.

   Theme nur auf <html> umschalten (data-theme / color-scheme), nie auf Teilbäumen:
   In Produktion ersetzt Lightning CSS light-dark() durch --lightningcss-light/-dark,
   die bereits auf :root aufgelöst werden (geprüft mit next build 16.4).

   JS (ECharts, Canvas): Farben über readChartTokensFromCss() in echarts-theme.ts lesen
   (Probe-Element, liefert rgb(); getPropertyValue() gäbe nur Rohtext).

   Alle Werte sind berechnet und geprüft (WCAG-Kontrast, dataviz-Validator):
   Tabellen und Messwerte stehen in DESIGN.md.
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. Roh-Tokens (Single Source of Truth)
   -------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  /* Schriften – next/font setzt --font-space-grotesk / --font-plex-sans /
     --font-jetbrains-mono auf <html>. Fallback-Namen greifen ohne next/font. */
  --np-font-display: var(--font-space-grotesk, "Space Grotesk"), ui-sans-serif, system-ui, sans-serif;
  --np-font-sans: var(--font-plex-sans, "IBM Plex Sans"), ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  --np-font-mono: var(--font-jetbrains-mono, "JetBrains Mono"), ui-monospace, "Cascadia Mono", Consolas, monospace;

  /* Flächen – Navy, OKLCH-Hue 258. Reihenfolge = Ebenen von hinten nach vorn. */
  --np-void: light-dark(#E9EEF4, #02060F);      /* Seitenrand, hinter allem          */
  --np-canvas: light-dark(#F6F8FB, #040B18);    /* App-Hintergrund (body)            */
  --np-sunken: light-dark(#EEF2F7, #06101F);    /* Sidebar, Mulden, Code             */
  --np-panel: light-dark(#FFFFFF, #0A1627);     /* Karten / Chart-Fläche             */
  --np-raised: light-dark(#F0F4F9, #121E31);    /* Hover, Inputs, Tabellenkopf       */
  --np-overlay: light-dark(#FFFFFF, #19263A);   /* Tooltip, Popover, Menü            */
  --np-glass: light-dark(rgb(255 255 255 / 0.86), rgb(10 22 39 / 0.74));
  --np-glass-strong: light-dark(rgb(248 250 253 / 0.94), rgb(6 16 31 / 0.9));

  /* Linien */
  --np-line: light-dark(#DCE2E9, #243144);         /* Haarlinien, Panel-Rahmen           */
  --np-line-strong: light-dark(#C0C8D3, #404E63);  /* betonte Trenner, Tabellenkopf      */
  --np-line-control: light-dark(#828D9C, #607086); /* Input-/Checkbox-Rand (>= 3:1)      */

  /* Text */
  --np-fg: light-dark(#0E1624, #EAF1F8);     /* primär            15.9:1 auf panel  */
  --np-fg-2: light-dark(#394353, #BDCADA);   /* sekundär          10.9:1            */
  --np-fg-3: light-dark(#586475, #97A4B6);   /* gedämpft, Achsen   7.2:1            */
  --np-fg-4: light-dark(#828D9C, #6E7A8B);   /* nur deko/disabled  4.2:1            */
  --np-fg-invert: light-dark(#FFFFFF, #00141E); /* Text auf fiber-strong            */

  /* Akzente */
  --np-fiber: light-dark(#00758D, #2EEBFC);        /* Glasfaser: Fokus, aktiv, live, Links */
  --np-fiber-strong: light-dark(#006F87, #00D5EF); /* Primär-Button-Fläche                 */
  --np-fiber-deep: light-dark(#005A6E, #0096AF);   /* pressed, Auswahl                     */
  --np-laser: light-dark(#653CBD, #B09CFF);        /* Laser-Violett: Sekundärakzent        */
  --np-laser-strong: light-dark(#5530A8, #9874FF);
  --np-aqua: light-dark(#00806F, #50E3C7);         /* nur Verlaufs-Stopp (Marke)           */

  /* Status – reserviert, immer mit Icon + Text */
  --np-good: light-dark(#087736, #54DD7D);
  --np-warn: light-dark(#965800, #FFBD4A);
  --np-crit: light-dark(#C2272D, #FF6367);
  --np-unknown: light-dark(#5F6A77, #8E99A8);
  --np-info: light-dark(#1F68BC, #63B9FE);

  /* Segmente – ordinale Rampe "Nah -> Fern" (ein Farbton, monotone Helligkeit) */
  --np-seg-pc: light-dark(#45C1D4, #C2F2F8);
  --np-seg-lan: light-dark(#03ACC7, #86E2F2);
  --np-seg-router: light-dark(#0096B3, #48CEEA);
  --np-seg-docsis: light-dark(#007FA0, #09B7DC);
  --np-seg-provider: light-dark(#006A8D, #009EC9);
  --np-seg-internet: light-dark(#005579, #0085B4);
  --np-seg-targets: light-dark(#004166, #006E9F);

  /* Diagramme – kategorial (feste Reihenfolge, nie zyklisch), validiert */
  --np-chart-1: light-dark(#0095B5, #00A5C4);  /* Cyan     */
  --np-chart-2: light-dark(#7544CD, #9264EF);  /* Violett  */
  --np-chart-3: light-dark(#9E0067, #CA358B);  /* Magenta  */
  --np-chart-4: light-dark(#0062D4, #217BF4);  /* Blau     */
  --np-chart-5: light-dark(#CB5A00, #D16100);  /* Orange   */
  --np-chart-6: light-dark(#008779, #008777);  /* Petrol   */
  --np-chart-7: light-dark(#9E8400, #AE9200);  /* Gold     */
  --np-chart-8: light-dark(#9C40BF, #BF64E4);  /* Orchidee */
  --np-chart-other: light-dark(#9AA4B2, #6E7A8B); /* "Sonstige" (ab Serie 9)        */
  --np-chart-ref: light-dark(#394353, #BDCADA);   /* Referenz/Median, gestrichelt     */
  --np-chart-solo: var(--np-fiber);               /* Einzelserie, Sparklines          */
  --np-chart-grid: light-dark(#E6EBF1, #182334);
  --np-chart-axis: light-dark(#C0C8D3, #323E50);

  /* Heatmap – semantische Hitze, Helligkeit monoton (0 = ruhig) */
  --np-heat-0: light-dark(#F0F4F9, #1C263A);
  --np-heat-1: light-dark(#F5DFAC, #3F316C);
  --np-heat-2: light-dark(#F9B96C, #76338A);
  --np-heat-3: light-dark(#F47F46, #BC3181);
  --np-heat-4: light-dark(#DB4241, #EC5258);
  --np-heat-5: light-dark(#A02262, #FD923E);
  --np-heat-6: light-dark(#591E66, #FFDB68);

  /* Hintergrund-Effekt */
  --np-bg-grid-minor: light-dark(rgb(14 22 36 / 0.035), rgb(150 180 230 / 0.05));
  --np-bg-grid-major: light-dark(rgb(14 22 36 / 0.06), rgb(150 180 230 / 0.1));
  --np-bg-glow-a: light-dark(rgb(0 117 141 / 0.05), rgb(46 235 252 / 0.07));
  --np-bg-glow-b: light-dark(rgb(101 60 189 / 0.04), rgb(176 156 255 / 0.06));

  /* Elevation & Glow */
  --np-shadow-panel:
    inset 0 1px 0 0 light-dark(rgb(255 255 255 / 0), rgb(255 255 255 / 0.04)),
    0 16px 40px -24px light-dark(rgb(14 22 36 / 0.18), rgb(0 0 0 / 0.7));
  --np-shadow-overlay:
    0 0 0 1px var(--np-line-strong),
    0 18px 48px -12px light-dark(rgb(14 22 36 / 0.22), rgb(0 0 0 / 0.75));
  --np-glow-fiber:
    0 0 0 1px light-dark(rgb(0 117 141 / 0.4), rgb(46 235 252 / 0.45)),
    0 0 24px -6px light-dark(rgb(0 117 141 / 0.3), rgb(46 235 252 / 0.55));
  --np-glow-crit:
    0 0 0 1px light-dark(rgb(194 39 45 / 0.45), rgb(255 99 103 / 0.5)),
    0 0 24px -6px light-dark(rgb(194 39 45 / 0.3), rgb(255 99 103 / 0.5));
  --np-frame-color: color-mix(in oklab, var(--np-fiber) 55%, transparent);

  /* Bewegung */
  --np-ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --np-dur-fast: 120ms;
  --np-dur: 200ms;
  --np-dur-slow: 320ms;
}

:root[data-theme="light"] {
  color-scheme: light;
}

@media print {
  :root {
    color-scheme: light;
  }
}

/* --------------------------------------------------------------------------
   2. Tailwind-Namespaces (Utilities: bg-panel, text-fg-3, border-line, ...)
   inline = Utilities referenzieren die Roh-Tokens direkt -> Theme-Wechsel zur Laufzeit.
   -------------------------------------------------------------------------- */
@theme inline {
  --font-display: var(--np-font-display);
  --font-sans: var(--np-font-sans);
  --font-mono: var(--np-font-mono);

  --color-void: var(--np-void);
  --color-canvas: var(--np-canvas);
  --color-sunken: var(--np-sunken);
  --color-panel: var(--np-panel);
  --color-raised: var(--np-raised);
  --color-overlay: var(--np-overlay);

  --color-line: var(--np-line);
  --color-line-strong: var(--np-line-strong);
  --color-line-control: var(--np-line-control);

  --color-fg: var(--np-fg);
  --color-fg-2: var(--np-fg-2);
  --color-fg-3: var(--np-fg-3);
  --color-fg-4: var(--np-fg-4);
  --color-fg-invert: var(--np-fg-invert);

  --color-fiber: var(--np-fiber);
  --color-fiber-strong: var(--np-fiber-strong);
  --color-fiber-deep: var(--np-fiber-deep);
  --color-laser: var(--np-laser);
  --color-laser-strong: var(--np-laser-strong);
  --color-aqua: var(--np-aqua);

  --color-good: var(--np-good);
  --color-warn: var(--np-warn);
  --color-crit: var(--np-crit);
  --color-unknown: var(--np-unknown);
  --color-info: var(--np-info);

  --color-seg-pc: var(--np-seg-pc);
  --color-seg-lan: var(--np-seg-lan);
  --color-seg-router: var(--np-seg-router);
  --color-seg-docsis: var(--np-seg-docsis);
  --color-seg-provider: var(--np-seg-provider);
  --color-seg-internet: var(--np-seg-internet);
  --color-seg-targets: var(--np-seg-targets);

  --color-chart-1: var(--np-chart-1);
  --color-chart-2: var(--np-chart-2);
  --color-chart-3: var(--np-chart-3);
  --color-chart-4: var(--np-chart-4);
  --color-chart-5: var(--np-chart-5);
  --color-chart-6: var(--np-chart-6);
  --color-chart-7: var(--np-chart-7);
  --color-chart-8: var(--np-chart-8);
  --color-chart-other: var(--np-chart-other);
  --color-chart-ref: var(--np-chart-ref);
  --color-chart-solo: var(--np-chart-solo);

  --color-heat-0: var(--np-heat-0);
  --color-heat-1: var(--np-heat-1);
  --color-heat-2: var(--np-heat-2);
  --color-heat-3: var(--np-heat-3);
  --color-heat-4: var(--np-heat-4);
  --color-heat-5: var(--np-heat-5);
  --color-heat-6: var(--np-heat-6);

  --shadow-panel: var(--np-shadow-panel);
  --shadow-overlay: var(--np-shadow-overlay);
  --shadow-glow: var(--np-glow-fiber);
  --shadow-glow-crit: var(--np-glow-crit);
}

/* Typo-Skala: Tailwind-T-Shirt-Namen behalten (tailwind-merge-kompatibel),
   Werte auf dichte Dashboards angepasst. 4px-Raster bei den Zeilenhöhen. */
@theme {
  --text-2xs: 0.6875rem;              /* 11 – Achsen, Mikro-Labels   */
  --text-2xs--line-height: 1rem;
  --text-2xs--letter-spacing: 0.01em;
  --text-xs: 0.75rem;                 /* 12 – Chips, Captions        */
  --text-xs--line-height: 1rem;
  --text-xs--letter-spacing: 0.005em;
  --text-sm: 0.8125rem;               /* 13 – Tabellen, Labels, Nav  */
  --text-sm--line-height: 1.25rem;
  --text-base: 0.875rem;              /* 14 – UI-Standard            */
  --text-base--line-height: 1.375rem;
  --text-md: 1rem;                    /* 16 – Fließtext (Bericht)    */
  --text-md--line-height: 1.5rem;
  --text-lg: 1.125rem;                /* 18 – Panel-Titel            */
  --text-lg--line-height: 1.625rem;
  --text-lg--letter-spacing: -0.005em;
  --text-xl: 1.3125rem;               /* 21 – Abschnittstitel        */
  --text-xl--line-height: 1.75rem;
  --text-xl--letter-spacing: -0.01em;
  --text-2xl: 1.5rem;                 /* 24 – Seitentitel            */
  --text-2xl--line-height: 2rem;
  --text-2xl--letter-spacing: -0.015em;
  --text-3xl: 2rem;                   /* 32 – KPI-Werte              */
  --text-3xl--line-height: 2.375rem;
  --text-3xl--letter-spacing: -0.02em;
  --text-4xl: 3rem;                   /* 48 – Hero-Zahl (1x je Seite)*/
  --text-4xl--line-height: 3.25rem;
  --text-4xl--letter-spacing: -0.025em;
  --text-5xl: 3.75rem;                /* 60 – Wandmonitor            */
  --text-5xl--line-height: 4rem;
  --text-5xl--letter-spacing: -0.03em;

  --breakpoint-3xl: 120rem;           /* 1920px – NOC-/Wandmonitor   */
  --ease-np: cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* --------------------------------------------------------------------------
   3. Basis
   -------------------------------------------------------------------------- */
@layer base {
  /* html trägt die Grundfarbe; body bleibt transparent, sonst verdeckt seine Fläche
     den Hintergrund-Effekt (.np-bg liegt mit z-index -1 zwischen html und body). */
  html {
    background-color: var(--np-canvas);
    color: var(--np-fg);
    font-family: var(--np-font-sans);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    scrollbar-color: var(--np-line-strong) transparent;
    scrollbar-width: thin;
  }
  body {
    min-height: 100dvh;
    font-size: 0.875rem;
    line-height: 1.375rem;
  }
  h1,
  h2,
  h3 {
    font-family: var(--np-font-display);
    text-wrap: balance;
  }
  p {
    text-wrap: pretty;
  }
  code,
  kbd,
  samp,
  pre {
    font-family: var(--np-font-mono);
    font-variant-ligatures: none;
  }
  ::selection {
    background-color: color-mix(in oklab, var(--np-fiber) 32%, transparent);
    color: var(--np-fg);
  }
  :focus-visible {
    outline: 2px solid var(--np-fiber);
    outline-offset: 2px;
  }
  [hidden] {
    display: none !important;
  }
}

/* --------------------------------------------------------------------------
   4. Eigene Utilities
   -------------------------------------------------------------------------- */

/* Messwerte, IPs, MACs, Zeiten: Mono, feste Ziffernbreite (kein Springen bei Live-Werten),
   Ligaturen aus (JetBrains Mono würde sonst "->", ">=" usw. zusammenziehen). */
@utility np-num {
  font-family: var(--np-font-mono);
  font-variant-numeric: tabular-nums;
  font-variant-ligatures: none;
  font-feature-settings: "calt" 0, "liga" 0;
}

/* Kompakte Labels für lange deutsche Komposita (IBM Plex Sans, wdth-Achse) */
@utility np-label {
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 500;
  font-stretch: 92%;
  color: var(--np-fg-3);
}

/* Glas-Panel: Tönung + obere Lichtkante statt backdrop-filter (CPU-schonend) */
@utility np-panel {
  position: relative;
  isolation: isolate;
  border-radius: 1rem;
  border: 1px solid var(--np-line);
  background:
    linear-gradient(180deg, light-dark(rgb(255 255 255 / 0), rgb(255 255 255 / 0.03)), transparent 38%),
    var(--np-glass);
  box-shadow: var(--np-shadow-panel);
}

/* Messfenster-Ecken (Signatur-Detail, nur an Schlüssel-Panels) */
@utility np-frame {
  &::before,
  &::after {
    content: "";
    position: absolute;
    width: 18px;
    height: 18px;
    pointer-events: none;
  }
  &::before {
    top: -1px;
    left: -1px;
    border-top: 1px solid var(--np-frame-color);
    border-left: 1px solid var(--np-frame-color);
    border-top-left-radius: 1rem;
  }
  &::after {
    right: -1px;
    bottom: -1px;
    border-right: 1px solid var(--np-frame-color);
    border-bottom: 1px solid var(--np-frame-color);
    border-bottom-right-radius: 1rem;
  }
}

/* "Keine Messung": 135°-Schraffur (Texturkanal, nie Deko) */
@utility np-hatch {
  background-color: transparent;
  background-image: repeating-linear-gradient(135deg, var(--np-line-strong) 0 1px, transparent 1px 5px);
}

/* Markenverlauf "Lichtleiter": aqua -> fiber -> laser (Hue-monoton) */
@utility np-gradient-text {
  background-image: linear-gradient(90deg, var(--np-aqua), var(--np-fiber) 45%, var(--np-laser));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

/* --------------------------------------------------------------------------
   5. Bewegung: eine Steuerung für alles Dekorative
   <html data-motion="on|paused|off"> wird vom MotionGovernor gesetzt:
   - off:    prefers-reduced-motion oder Nutzer-Einstellung
   - paused: Tab verborgen ODER 90 s keine Eingabe (Seite steht stundenlang offen)
   Jede dekorative Animation trägt .np-anim.
   -------------------------------------------------------------------------- */
@layer components {
  :root[data-motion="paused"] .np-anim,
  :root[data-motion="paused"] .np-anim::before,
  :root[data-motion="paused"] .np-anim::after {
    animation-play-state: paused !important;
  }
  :root[data-motion="off"] .np-anim,
  :root[data-motion="off"] .np-anim::before,
  :root[data-motion="off"] .np-anim::after {
    animation: none !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .np-anim,
    .np-anim::before,
    .np-anim::after {
      animation: none !important;
    }
  }

  /* ---------- 5a. Netzwerk-Hintergrund (statisch + 6 Datenpulse) ---------- */
  .np-bg {
    position: fixed;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    pointer-events: none;
    contain: strict;
    background:
      radial-gradient(1100px 620px at 12% -12%, var(--np-bg-glow-a), transparent 62%),
      radial-gradient(900px 560px at 105% -8%, var(--np-bg-glow-b), transparent 60%),
      var(--np-canvas);
  }
  .np-bg__grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, var(--np-bg-grid-major) 1px, transparent 1px),
      linear-gradient(to bottom, var(--np-bg-grid-major) 1px, transparent 1px),
      linear-gradient(to right, var(--np-bg-grid-minor) 1px, transparent 1px),
      linear-gradient(to bottom, var(--np-bg-grid-minor) 1px, transparent 1px);
    background-size: 120px 120px, 120px 120px, 24px 24px, 24px 24px;
    -webkit-mask-image: radial-gradient(ellipse 85% 75% at 50% 20%, #000 35%, transparent 100%);
    mask-image: radial-gradient(ellipse 85% 75% at 50% 20%, #000 35%, transparent 100%);
  }
  .np-bg__mesh {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    color: var(--np-fiber);
    opacity: 0.7;
  }
  .np-pulse {
    position: absolute;
    display: block;
    opacity: 0;
    will-change: transform, opacity;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
    animation-duration: var(--dur, 16s);
    animation-delay: var(--delay, 0s);
  }
  .np-pulse--x {
    top: calc(var(--row, 2) * 120px);
    left: 0;
    width: 180px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--np-fiber) 75%, color-mix(in oklab, var(--np-fiber) 55%, white));
    animation-name: np-pulse-x;
  }
  .np-pulse--y {
    top: 0;
    left: calc(var(--col, 2) * 120px);
    width: 1px;
    height: 180px;
    background: linear-gradient(180deg, transparent, var(--np-laser) 75%, color-mix(in oklab, var(--np-laser) 55%, white));
    animation-name: np-pulse-y;
  }
  @keyframes np-pulse-x {
    0% { transform: translate3d(-200px, 0, 0); opacity: 0; }
    3% { opacity: 0.9; }
    28% { transform: translate3d(calc(100vw + 40px), 0, 0); opacity: 0.9; }
    29%, 100% { transform: translate3d(calc(100vw + 40px), 0, 0); opacity: 0; }
  }
  @keyframes np-pulse-y {
    0% { transform: translate3d(0, -200px, 0); opacity: 0; }
    3% { opacity: 0.8; }
    28% { transform: translate3d(0, calc(100vh + 40px), 0); opacity: 0.8; }
    29%, 100% { transform: translate3d(0, calc(100vh + 40px), 0); opacity: 0; }
  }
  :root[data-motion="off"] .np-pulse {
    display: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .np-pulse {
      display: none;
    }
  }

  /* ---------- 5b. Topologie: Pakete laufen über die Links ---------- */
  .np-packet {
    offset-rotate: 0deg;
    animation: np-travel var(--travel, 2.8s) linear infinite;
    animation-delay: var(--delay, 0s);
  }
  .np-packet--drop {
    animation-name: np-travel-drop;
  }
  @keyframes np-travel {
    from { offset-distance: 0%; }
    to { offset-distance: 100%; }
  }
  /* Paketverlust sichtbar: Paket fällt in der Linkmitte heraus und verlischt */
  @keyframes np-travel-drop {
    0% { offset-distance: 0%; opacity: 1; translate: 0 0; }
    46% { offset-distance: 46%; opacity: 1; translate: 0 0; }
    62% { offset-distance: 52%; opacity: 0; translate: 0 16px; }
    100% { offset-distance: 52%; opacity: 0; translate: 0 16px; }
  }
  :root[data-motion="paused"] .np-packet,
  :root[data-motion="off"] .np-packet {
    visibility: hidden;
  }
  @media (prefers-reduced-motion: reduce) {
    .np-packet {
      visibility: hidden;
    }
  }

  /* ---------- 5c. Live-Punkt (Engine läuft) ---------- */
  .np-live-dot {
    position: relative;
    display: inline-block;
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 9999px;
    background-color: currentColor;
  }
  .np-live-dot::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: inherit;
    border: 1px solid currentColor;
    opacity: 0;
    animation: np-ping 2.4s var(--np-ease-out) infinite;
  }
  @keyframes np-ping {
    0% { transform: scale(0.5); opacity: 0.9; }
    70%, 100% { transform: scale(1.6); opacity: 0; }
  }

  /* ---------- 5d. Skeleton (nur beim ersten Laden; Refetch hält altes Bild) ---------- */
  .np-skeleton {
    position: relative;
    overflow: hidden;
    border-radius: 0.375rem;
    background-color: var(--np-raised);
  }
  .np-skeleton::after {
    content: "";
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, light-dark(rgb(14 22 36 / 0.05), rgb(255 255 255 / 0.05)), transparent);
    animation: np-shimmer 1.8s ease-in-out infinite;
  }
  @keyframes np-shimmer {
    to { transform: translateX(100%); }
  }
}

/* --------------------------------------------------------------------------
   6. Druck (Bericht): helles Theme, ohne Chrome und Effekte
   -------------------------------------------------------------------------- */
@media print {
  html,
  body {
    background: #FFFFFF !important;
  }
  .np-bg,
  .np-no-print,
  [data-slot="sidebar"],
  [data-slot="statusbar"] {
    display: none !important;
  }
  .np-panel {
    box-shadow: none !important;
    background: #FFFFFF !important;
    break-inside: avoid;
  }
}
```

Notes:
- Tailwind emits theme variables only when used; the raw `--np-*` variables live in plain `:root`, so JS (ECharts) can always read them.
- `html` carries the canvas colour, `body` stays transparent – otherwise the body background covers the background effect (`.np-bg` sits at `z-index:-1` between them).
- `light-dark()`: in production Lightning CSS rewrites it to `var(--lightningcss-light,…)var(--lightningcss-dark,…)` and sets those variables wherever `color-scheme` is declared (verified in the built CSS). **Switch themes only on `<html>`** (`data-theme`, print) – a `color-scheme` on a subtree would re-theme in dev but not in production. Native `light-dark()` (dev) needs Chrome 123+/Firefox 120+.

---

## 7. Shared helpers

**`src/lib/cn.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Klassen zusammenführen. tailwind-merge kennt eigene Theme-Namen nicht von selbst:
 * Ohne diese Erweiterung würde z. B. `shadow-panel` als Schattenfarbe gelten.
 * Schriftgrößen nutzen bewusst die T-Shirt-Namen (2xs … 5xl), die tailwind-merge
 * bereits als Größen erkennt – daher keine eigenen Namen wie `text-kpi`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ["panel", "overlay", "glow", "glow-crit"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

**`src/lib/format.ts`**

```ts
/**
 * Deutsche Zahlen- und Zeitformate. Zeitzone fest auf Europe/Berlin, damit Server-
 * und Client-Render identisch sind (keine Hydration-Abweichung).
 * Einheiten werden mit geschütztem Leerzeichen (U+00A0) angehängt: "18,4 ms", "0,8 %".
 */
const NBSP = " ";
export const DASH = "–"; // "–" für fehlende Werte

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}-${max}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("de-DE", { minimumFractionDigits: min, maximumFractionDigits: max });
    nfCache.set(key, f);
  }
  return f;
}

export function fmtNumber(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return DASH;
  return nf(0, digits).format(v);
}

/** Latenz: unter 10 ms eine Nachkommastelle (LAN: 0,3 vs. 0,9 ms zählt), sonst ganze ms. */
export function fmtMsValue(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return DASH;
  if (v < 0.1) return "<0,1";
  return nf(v < 10 ? 1 : 0, v < 10 ? 1 : 0).format(v);
}
export const fmtMs = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? DASH : `${fmtMsValue(v)}${NBSP}ms`;

/** Prozent immer mit einer Nachkommastelle: "0,0 %", "2,4 %". */
export function fmtPctValue(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return DASH;
  return nf(1, 1).format(v);
}
export const fmtPct = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? DASH : `${fmtPctValue(v)}${NBSP}%`;

export const fmtMbit = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? DASH : `${nf(0, v < 100 ? 1 : 0).format(v)}${NBSP}Mbit/s`;

export const fmtDb = (v: number | null | undefined, unit: "dB" | "dBmV" = "dB"): string =>
  v == null || Number.isNaN(v) ? DASH : `${nf(1, 1).format(v).replace("-", "−")}${NBSP}${unit}`;

const TZ = "Europe/Berlin";
const dfTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });
const dfShortTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dfDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dfDayLong = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const dfDayShort = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const dfDayKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });

type DateInput = string | number | Date;
const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));

export const fmtTime = (d: DateInput): string => dfTime.format(toDate(d));           // 18:43:12
export const fmtShortTime = (d: DateInput): string => dfShortTime.format(toDate(d)); // 18:43
export const fmtDate = (d: DateInput): string => dfDate.format(toDate(d));           // 08.10.2026
export const fmtDateTime = (d: DateInput): string => `${fmtDate(d)}, ${fmtTime(d)}`; // 08.10.2026, 18:43:12
export const fmtDayLong = (d: DateInput): string => dfDayLong.format(toDate(d));     // Donnerstag, 8. Oktober 2026
export const fmtDayShort = (d: DateInput): string => dfDayShort.format(toDate(d));   // Do., 8.10.
/** Kalendertag in Europe/Berlin als "YYYY-MM-DD" (für Gruppierung). */
export const dayKey = (d: DateInput): string => dfDayKey.format(toDate(d));

/** Laufzeit: "3 T 04:12:55" ab einem Tag, sonst "04:12:55". */
export function fmtRuntime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return days > 0 ? `${days}${NBSP}T ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** Dauer kurz: "22 s", "3 min 05 s", "2 h 14 min". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}${NBSP}s`;
  if (s < 3600) return `${Math.floor(s / 60)}${NBSP}min ${String(s % 60).padStart(2, "0")}${NBSP}s`;
  return `${Math.floor(s / 3600)}${NBSP}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}${NBSP}min`;
}
```

**`src/lib/health.ts`**

```ts
import { CircleCheck, CircleQuestionMark, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";

/** Zustand eines Segments/Werts. Reihenfolge = Schwere. */
export type Health = "good" | "warn" | "crit" | "unknown";
/** Für Befunde und Ereignisse zusätzlich "info". */
export type Severity = Health | "info";

export const HEALTH_LABEL: Record<Severity, string> = {
  good: "Gut",
  warn: "Auffällig",
  crit: "Kritisch",
  unknown: "Unbekannt",
  info: "Hinweis",
};

export const HEALTH_ICON: Record<Severity, LucideIcon> = {
  good: CircleCheck,
  warn: TriangleAlert,
  crit: OctagonAlert,
  unknown: CircleQuestionMark,
  info: Info,
};

/** CSS-Farbe (für SVG-style, Canvas über readChartTokensFromCss). */
export const HEALTH_COLOR: Record<Severity, string> = {
  good: "var(--np-good)",
  warn: "var(--np-warn)",
  crit: "var(--np-crit)",
  unknown: "var(--np-unknown)",
  info: "var(--np-info)",
};

/** Vollständige Klassen-Strings (Tailwind findet nur statische Klassen). */
export const HEALTH_TEXT: Record<Severity, string> = {
  good: "text-good",
  warn: "text-warn",
  crit: "text-crit",
  unknown: "text-unknown",
  info: "text-info",
};

export const HEALTH_SOFT: Record<Severity, string> = {
  good: "bg-good/12 ring-good/30",
  warn: "bg-warn/12 ring-warn/30",
  crit: "bg-crit/14 ring-crit/40",
  unknown: "bg-unknown/12 ring-unknown/25",
  info: "bg-info/12 ring-info/30",
};

const RANK: Record<Health, number> = { good: 0, unknown: 1, warn: 2, crit: 3 };

/** Schlechtester Zustand gewinnt (für Gesamtzustand). */
export function worstHealth(...states: Health[]): Health {
  return states.reduce<Health>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "good");
}

/** Schwellen für Gaming (anpassbar in Einstellungen). */
export const THRESHOLDS = {
  rttMs: { warn: 60, crit: 150 },
  jitterMs: { warn: 10, crit: 30 },
  lossPct: { warn: 0.5, crit: 2 },
} as const;

export function rate(value: number | null | undefined, t: { warn: number; crit: number }): Health {
  if (value == null || Number.isNaN(value)) return "unknown";
  if (value >= t.crit) return "crit";
  if (value >= t.warn) return "warn";
  return "good";
}
```

**`src/lib/segments.ts`**

```ts
import { AudioWaveform, Cable, Globe, Monitor, Router, Server, Target, type LucideIcon } from "lucide-react";

/**
 * Der Leitungsweg in fester Reihenfolge (Nah -> Fern). Knoten und Links wechseln sich ab:
 * PC (Knoten) – LAN (Link) – Router (Knoten) – DOCSIS (Link) – Provider (Knoten) – Internet (Link) – Ziele (Knoten)
 */
export type SegmentId = "pc" | "lan" | "router" | "docsis" | "provider" | "internet" | "targets";

export interface SegmentDef {
  id: SegmentId;
  kind: "node" | "link";
  label: string;
  short: string;
  /** Was hier typischerweise geprüft wird – für Tooltips/Diagnose. */
  scope: string;
  icon: LucideIcon;
  /** Ordinale Rampe (CSS-Variable), nur für Legenden/Charts – Zustand kommt aus Health. */
  color: string;
  colorClass: string;
}

export const SEGMENTS: readonly SegmentDef[] = [
  { id: "pc", kind: "node", label: "PC & Adapter", short: "PC", scope: "Intel I225-V, Treiber, Energiesparen, Linkgeschwindigkeit", icon: Monitor, color: "var(--np-seg-pc)", colorClass: "bg-seg-pc" },
  { id: "lan", kind: "link", label: "LAN-Kabel", short: "LAN", scope: "Kabel, Stecker, Router-Port", icon: Cable, color: "var(--np-seg-lan)", colorClass: "bg-seg-lan" },
  { id: "router", kind: "node", label: "Router", short: "Router", scope: "Vodafone Station (ARRIS TG6442)", icon: Router, color: "var(--np-seg-router)", colorClass: "bg-seg-router" },
  { id: "docsis", kind: "link", label: "Kabelnetz (DOCSIS)", short: "DOCSIS", scope: "Koax-Hausverteilung, Pegel, SNR, Codeword-Fehler", icon: AudioWaveform, color: "var(--np-seg-docsis)", colorClass: "bg-seg-docsis" },
  { id: "provider", kind: "node", label: "Vodafone & AFTR", short: "Provider", scope: "CMTS, DS-Lite-Gateway (CGNAT), Backbone-Einstieg", icon: Server, color: "var(--np-seg-provider)", colorClass: "bg-seg-provider" },
  { id: "internet", kind: "link", label: "Internet", short: "Internet", scope: "Backbone, Peering, Transit", icon: Globe, color: "var(--np-seg-internet)", colorClass: "bg-seg-internet" },
  { id: "targets", kind: "node", label: "Ziele", short: "Ziele", scope: "1.1.1.1, 8.8.8.8, Spielserver", icon: Target, color: "var(--np-seg-targets)", colorClass: "bg-seg-targets" },
] as const;

export const SEGMENT_BY_ID: Record<SegmentId, SegmentDef> = Object.fromEntries(
  SEGMENTS.map((s) => [s.id, s]),
) as Record<SegmentId, SegmentDef>;
```

**`src/lib/use-now.ts`**

```ts
"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Aktuelle Zeit, auf intervalMs gerundet. Server-Snapshot = null (Platzhalter rendern,
 * keine Hydration-Abweichung). Läuft nicht, solange der Tab verborgen ist.
 */
export function useNow(intervalMs = 1000): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let id: number | undefined;
      const start = () => {
        window.clearInterval(id);
        id = window.setInterval(onChange, intervalMs);
        onChange();
      };
      const onVisibility = () => (document.hidden ? window.clearInterval(id) : start());
      if (!document.hidden) start();
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.clearInterval(id);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    [intervalMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => null,
  );
}
```

---

## 8. App shell

Root layout (replaces the scaffold's Geist setup):

**`src/app/layout.tsx`**

```tsx
import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/shell/AppShell";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Netzpuls", template: "%s – Netzpuls" },
  description: "Langzeit-Leitungstest und Ursachenanalyse für Ping-Spitzen und Paketverlust",
};

export const viewport: Viewport = {
  themeColor: "#040B18",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de" data-motion="on" className={fontVariables} suppressHydrationWarning>
      <body>
        <AppShell sidebarFooter={<span className="np-num">Engine 127.0.0.1:3901</span>}>{children}</AppShell>
      </body>
    </html>
  );
}
```

**`src/components/shell/AppShell.tsx`**

```tsx
import type { ReactNode } from "react";
import { MotionGovernor } from "@/components/background/MotionGovernor";
import { NetworkBackground } from "@/components/background/NetworkBackground";
import { ShellProvider } from "./ShellProvider";
import { Sidebar } from "./Sidebar";
import { LiveStatusBar } from "./StatusBar";

/**
 * App-Rahmen: Hintergrund, Sidebar, Statusleiste, Inhalt.
 * Server-Komponente; interaktive Teile sind eigene Client-Komponenten.
 */
export function AppShell({ children, sidebarFooter }: { children: ReactNode; sidebarFooter?: ReactNode }) {
  return (
    <ShellProvider>
      <a
        href="#inhalt"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-fiber-strong focus:px-3 focus:py-2 focus:text-sm focus:text-fg-invert"
      >
        Zum Inhalt springen
      </a>
      <NetworkBackground />
      <MotionGovernor />
      <div className="flex min-h-dvh">
        <Sidebar footer={sidebarFooter} />
        <div className="flex min-w-0 flex-1 flex-col">
          <LiveStatusBar />
          <main id="inhalt" tabIndex={-1} className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-12 pt-6 outline-none sm:px-6 xl:px-8">
            {children}
          </main>
        </div>
      </div>
    </ShellProvider>
  );
}
```

**`src/components/shell/ShellProvider.tsx`**

```tsx
"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface ShellState {
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

/** Hält nur den Zustand der mobilen Navigation (Drawer). */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const value = useMemo(() => ({ navOpen, setNavOpen }), [navOpen]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell() außerhalb von <ShellProvider> verwendet");
  return ctx;
}
```

**`src/components/shell/nav.ts`**

```ts
import {
  Activity,
  CalendarClock,
  ChartSpline,
  EthernetPort,
  FileText,
  Gauge,
  ListClock,
  Route,
  Router,
  Settings,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Kurzbeschreibung für Tooltip in der eingeklappten Leiste */
  hint: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Routen deutsch, kleingeschrieben, ohne Umlaute. Reihenfolge = Arbeitsablauf. */
export const NAV: NavGroup[] = [
  {
    label: "Überblick",
    items: [
      { href: "/", label: "Live-Dashboard", icon: Activity, hint: "Aktueller Zustand der Leitung" },
      { href: "/verlauf", label: "Verlauf", icon: ChartSpline, hint: "Messwerte über Stunden und Tage" },
      { href: "/diagnose", label: "Diagnose", icon: Stethoscope, hint: "Befunde und wahrscheinliche Ursache" },
    ],
  },
  {
    label: "Messungen",
    items: [
      { href: "/speedtest", label: "Speedtest", icon: Gauge, hint: "Durchsatz und Latenz unter Last" },
      { href: "/route", label: "Route", icon: Route, hint: "Traceroute Hop für Hop" },
      { href: "/router", label: "Router", icon: Router, hint: "Vodafone Station und DOCSIS-Werte" },
      { href: "/pc-adapter", label: "PC & Adapter", icon: EthernetPort, hint: "Netzwerkkarte, Link, Treiber" },
    ],
  },
  {
    label: "Auswertung",
    items: [
      { href: "/ereignisse", label: "Ereignisse", icon: ListClock, hint: "Abbrüche, Ausfälle, Neustarts" },
      { href: "/bericht", label: "Bericht", icon: FileText, hint: "Zusammenfassung zum Teilen oder Drucken" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/messplan", label: "Messplan", icon: CalendarClock, hint: "Was wann gemessen wird" },
      { href: "/einstellungen", label: "Einstellungen", icon: Settings, hint: "Ziele, Schwellen, Router-Zugang" },
    ],
  },
];

export function isActive(href: string, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
```

**`src/components/shell/Brand.tsx`**

```tsx
import { cn } from "@/lib/cn";

/** Bildmarke: Pulslinie (Glasfaser-Cyan), die in ein Paket (Laser-Violett) mündet. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8 shrink-0", className)}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" style={{ fill: "var(--np-sunken)", stroke: "var(--np-line-strong)" }} />
      <path
        d="M4 17h6l2.5-7 4 13 2.5-6H24"
        fill="none"
        style={{ stroke: "var(--np-fiber)" }}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="27" cy="17" r="2.25" style={{ fill: "var(--np-laser)" }} />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark />
      {!compact && (
        <span className="leading-tight">
          <span className="block font-display text-[17px] font-semibold tracking-tight text-fg">Netzpuls</span>
          <span className="block text-2xs text-fg-3">Leitungsdiagnose</span>
        </span>
      )}
    </span>
  );
}
```

`usePathname()` with `cacheComponents: true` may suspend on routes with unknown dynamic params, so the nav list is wrapped in `<Suspense>` with a non-active fallback (see Next 16 docs `use-pathname.md`).

**`src/components/shell/Sidebar.tsx`**

```tsx
"use client";

import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { BrandMark } from "./Brand";
import { NAV, isActive } from "./nav";
import { useShell } from "./ShellProvider";

/** Reine Darstellung – ohne usePathname, dient auch als Suspense-Fallback. */
function NavList({ pathname, onNavigate }: { pathname?: string | null; onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {NAV.map((group, gi) => (
        <div key={group.label} className={cn(gi > 0 && "md:max-xl:border-t md:max-xl:border-line md:max-xl:pt-4")}>
          <p className="px-2.5 pb-1.5 text-2xs font-medium text-fg-4 md:max-xl:sr-only">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(item.href, pathname);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={item.hint}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm text-fg-2 transition-colors duration-150",
                      "hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fiber",
                      "md:max-xl:justify-center md:max-xl:px-0",
                      active && "bg-fiber/10 text-fg hover:bg-fiber/14",
                    )}
                  >
                    {active && (
                      <span aria-hidden className="absolute -left-3 bottom-2 top-2 w-0.5 rounded-r-full bg-fiber shadow-glow" />
                    )}
                    <Icon
                      aria-hidden
                      className={cn("size-[18px] shrink-0", active ? "text-fiber" : "text-fg-3 group-hover:text-fg-2")}
                      strokeWidth={1.75}
                    />
                    <span className="truncate md:max-xl:sr-only">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ActiveNavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <NavList pathname={pathname} onNavigate={onNavigate} />;
}

/**
 * < md: Drawer (über Menü-Button in der Statusleiste)
 * md–xl: schmale Leiste nur mit Icons (Tooltip = title)
 * ab xl: volle Sidebar 256 px
 */
export function Sidebar({ footer }: { footer?: ReactNode }) {
  const { navOpen, setNavOpen } = useShell();
  const close = () => setNavOpen(false);
  return (
    <>
      <div
        aria-hidden
        onClick={close}
        className={cn("fixed inset-0 z-40 bg-void/70 transition-opacity md:hidden", navOpen ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <aside
        data-slot="sidebar"
        aria-label="Hauptnavigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line bg-(--np-glass-strong) transition-transform duration-200 ease-np",
          "md:sticky md:top-0 md:z-30 md:h-dvh md:w-[72px] md:translate-x-0 xl:w-64",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4 md:max-xl:justify-center md:max-xl:px-0">
          <BrandMark />
          <span className="leading-tight md:max-xl:hidden">
            <span className="block font-display text-[17px] font-semibold tracking-tight text-fg">Netzpuls</span>
            <span className="block text-2xs text-fg-3">Leitungsdiagnose</span>
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <Suspense fallback={<NavList onNavigate={close} />}>
            <ActiveNavList onNavigate={close} />
          </Suspense>
        </nav>
        {footer && <div className="border-t border-line px-4 py-3 text-2xs text-fg-4 md:max-xl:hidden">{footer}</div>}
      </aside>
    </>
  );
}
```

**`src/components/shell/StatusBar.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { CircleStop, Menu, Pause, Play, PlugZap } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtRuntime } from "@/lib/format";
import type { Health } from "@/lib/health";
import { useNow } from "@/lib/use-now";
import { Button } from "@/components/ui/Button";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { BrandMark } from "./Brand";
import { useShell } from "./ShellProvider";

export interface EngineStatus {
  state: "running" | "paused" | "stopped" | "offline";
  /** Start des Langzeittests (ISO) */
  startedAt?: string;
  /** Gesamtzustand aus der Diagnose */
  health?: Health;
  /** Nächster geplanter Test, z. B. { label: "Speedtest", at: ISO } */
  next?: { label: string; at: string };
}

const ENGINE_TEXT: Record<EngineStatus["state"], string> = {
  running: "Mess-Engine läuft",
  paused: "Mess-Engine pausiert",
  stopped: "Mess-Engine gestoppt",
  offline: "Mess-Engine nicht erreichbar",
};

const rtf = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
function inMinutes(at: string, now: number): string {
  const min = Math.round((new Date(at).getTime() - now) / 60_000);
  return Math.abs(min) < 60 ? rtf.format(min, "minute") : rtf.format(Math.round(min / 60), "hour");
}

interface StatusBarProps {
  engine: EngineStatus | null;
  onPauseToggle?: () => void;
  className?: string;
}

/** Obere Leiste: Engine-Zustand, Laufzeit des Langzeittests, Gesamtzustand, Pause. */
export function StatusBar({ engine, onPauseToggle, className }: StatusBarProps) {
  const { setNavOpen } = useShell();
  const now = useNow(1000);
  const state = engine?.state ?? "offline";
  const runtime = engine?.startedAt && now != null ? fmtRuntime(now - new Date(engine.startedAt).getTime()) : "–";

  return (
    <header
      data-slot="statusbar"
      className={cn(
        "sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-(--np-glass-strong) px-4 sm:gap-5 sm:px-6 xl:px-8",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setNavOpen(true)}
        aria-label="Navigation öffnen"
        className="-ml-1.5 grid size-9 place-items-center rounded-lg text-fg-2 hover:bg-raised hover:text-fg md:hidden"
      >
        <Menu aria-hidden className="size-5" />
      </button>
      <BrandMark className="size-7 md:hidden" />

      {/* Engine */}
      <div className="flex min-w-0 items-center gap-2.5" role="status">
        {state === "running" && <span aria-hidden className="np-live-dot np-anim text-good" />}
        {state === "paused" && <Pause aria-hidden className="size-4 text-warn" strokeWidth={2.25} />}
        {state === "stopped" && <CircleStop aria-hidden className="size-4 text-unknown" strokeWidth={2.25} />}
        {state === "offline" && <PlugZap aria-hidden className="size-4 text-crit" strokeWidth={2.25} />}
        <span className="truncate text-sm text-fg-2">{ENGINE_TEXT[state]}</span>
      </div>

      {/* Laufzeit */}
      <div className="hidden items-baseline gap-2 border-l border-line pl-5 sm:flex">
        <span className="text-xs text-fg-3">Langzeittest</span>
        <span className="np-num text-sm text-fg" suppressHydrationWarning>
          {runtime}
        </span>
      </div>

      {engine?.next && now != null && (
        <div className="hidden items-baseline gap-2 border-l border-line pl-5 xl:flex">
          <span className="text-xs text-fg-3">Nächster {engine.next.label}</span>
          <span className="np-num text-sm text-fg-2">{inMinutes(engine.next.at, now)}</span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-fg-3 lg:inline">Gesamtzustand</span>
        <HealthBadge status={engine?.health ?? "unknown"} />
        {onPauseToggle && (state === "running" || state === "paused") && (
          <Button size="sm" variant="secondary" icon={state === "running" ? Pause : Play} onClick={onPauseToggle} className="hidden sm:inline-flex">
            {state === "running" ? "Pausieren" : "Fortsetzen"}
          </Button>
        )}
      </div>
    </header>
  );
}

/**
 * Platzhalter-Anbindung an die Engine (SSE über Next-Proxy). Endpunkt und Event-Namen
 * an die tatsächliche Engine-API anpassen.
 */
export function useEngineStatus(streamUrl = "/api/engine/stream"): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  useEffect(() => {
    const es = new EventSource(streamUrl);
    const onStatus = (e: MessageEvent<string>) => setStatus(JSON.parse(e.data) as EngineStatus);
    es.addEventListener("status", onStatus);
    es.onerror = () => setStatus((s) => ({ ...(s ?? {}), state: "offline" }));
    return () => {
      es.removeEventListener("status", onStatus);
      es.close();
    };
  }, [streamUrl]);
  return status;
}

export function LiveStatusBar() {
  const engine = useEngineStatus();
  const onPauseToggle = () => {
    void fetch(`/api/engine/${engine?.state === "running" ? "pause" : "resume"}`, { method: "POST" });
  };
  return <StatusBar engine={engine} onPauseToggle={onPauseToggle} />;
}
```

`useEngineStatus()` is a placeholder (EventSource on `/api/engine/stream`, event name `status`). Adapt endpoint/payload to the engine API; the component itself only needs `EngineStatus`.

---

## 9. UI components

**`src/components/ui/Panel.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Rechts im Kopf: Zeitraum-Umschalter, Buttons … */
  actions?: ReactNode;
  /** Messfenster-Ecken – nur für 1–2 Schlüssel-Panels je Seite (z. B. Leitungsweg). */
  frame?: boolean;
  as?: "section" | "article" | "div";
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** Glas-Panel. Radius-Hierarchie: Panel/Kachel 16 px > innere Flächen 10 px > Controls 8 px > Chips rund. */
export function Panel({ title, description, actions, frame = false, as = "section", className, bodyClassName, children }: PanelProps) {
  const Tag = as;
  const hasHeader = title != null || actions != null;
  return (
    <Tag className={cn("np-panel min-w-0", frame && "np-frame", className)}>
      {hasHeader && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4">
          <div className="min-w-0">
            {title != null && <h2 className="text-lg font-medium text-fg">{title}</h2>}
            {description != null && <p className="mt-0.5 text-sm text-fg-3">{description}</p>}
          </div>
          {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("px-5 pb-5", hasHeader ? "pt-4" : "pt-5", bodyClassName)}>{children}</div>
    </Tag>
  );
}
```

**`src/components/ui/PageHeader.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PageHeaderProps {
  title: string;
  /** Ein Satz: was diese Seite beantwortet */
  description?: ReactNode;
  /** Filterzeile rechts: Zeitraum zuerst, dann weitere Filter */
  actions?: ReactNode;
  className?: string;
}

/** Seitenkopf. Filter stehen hier in EINER Zeile und gelten für alles darunter. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
```

**`src/components/ui/HealthBadge.tsx`**

```tsx
import { cn } from "@/lib/cn";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_SOFT, HEALTH_TEXT, type Severity } from "@/lib/health";

interface HealthBadgeProps {
  status: Severity;
  /** Eigener Text, z. B. "Link 100 Mbit/s". Standard: "Gut", "Auffällig", … */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

/** Status nie nur über Farbe: Icon + Text + Farbe. */
export function HealthBadge({ status, label, size = "md", className }: HealthBadgeProps) {
  const Icon = HEALTH_ICON[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "h-5 px-2 text-2xs" : "h-6 px-2.5 text-xs",
        HEALTH_TEXT[status],
        HEALTH_SOFT[status],
        className,
      )}
    >
      <Icon aria-hidden className={size === "sm" ? "size-3" : "size-3.5"} strokeWidth={2.25} />
      {label ?? HEALTH_LABEL[status]}
    </span>
  );
}

/** Kompakter Punkt für Tabellen/Listen – immer mit sichtbarem Text daneben verwenden. */
export function HealthDot({ status, className }: { status: Severity; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full bg-current ring-2 ring-panel", HEALTH_TEXT[status], className)}
    />
  );
}
```

**`src/components/ui/KpiTile.tsx`**

```tsx
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { HEALTH_COLOR, type Health } from "@/lib/health";
import { HealthBadge } from "./HealthBadge";

export interface KpiDelta {
  /** Fertiger Text, z. B. "+42 ms ggü. 7-Tage-Median" */
  text: string;
  trend: "up" | "down" | "flat";
  /** Richtung × "ist das gut?" entscheidet der Aufrufer (Latenz hoch = schlecht). */
  tone: "good" | "warn" | "bad" | "neutral";
}

interface KpiTileProps {
  label: string;
  /** Vorformatiert (deutsch): "18,4" */
  value: string;
  unit?: string;
  status?: Health;
  statusLabel?: string;
  icon?: LucideIcon;
  delta?: KpiDelta;
  /** Bezug des Werts: "Median, letzte 5 min" */
  caption?: string;
  /** Slot für <Sparkline/> oder Mini-Chart */
  children?: ReactNode;
  className?: string;
}

const TREND_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;
const TONE_CLASS = { good: "text-good", warn: "text-warn", bad: "text-crit", neutral: "text-fg-3" } as const;

export function KpiTile({ label, value, unit, status, statusLabel, icon: Icon, delta, caption, children, className }: KpiTileProps) {
  const TrendIcon = delta ? TREND_ICON[delta.trend] : null;
  return (
    <article className={cn("np-panel flex min-w-0 flex-col gap-2.5 overflow-hidden p-4", className)}>
      {status && (
        /* Lichtleiste oben: leise bei "gut", leuchtend bei Abweichung */
        <span
          aria-hidden
          className={cn("absolute inset-x-5 top-0 h-0.5 rounded-b-full", status === "good" ? "opacity-40" : "opacity-90")}
          style={{
            backgroundColor: HEALTH_COLOR[status],
            boxShadow: status === "good" ? undefined : `0 0 12px 0 ${HEALTH_COLOR[status]}`,
          }}
        />
      )}
      <header className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="np-label flex min-w-0 items-center gap-1.5 font-sans">
          {Icon && <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />}
          <span className="truncate">{label}</span>
        </h3>
        {status && <HealthBadge status={status} label={statusLabel} size="sm" />}
      </header>

      <p className="flex items-baseline gap-1.5 text-fg">
        <span className="np-num text-3xl font-semibold">{value}</span>
        {unit && <span className="np-num text-sm text-fg-3">{unit}</span>}
      </p>

      {delta && TrendIcon && (
        <p className={cn("flex items-center gap-1 text-xs", TONE_CLASS[delta.tone])}>
          <TrendIcon aria-hidden className="size-3.5" strokeWidth={2.25} />
          <span className="np-num">{delta.text}</span>
        </p>
      )}

      {children && <div className="mt-auto pt-1">{children}</div>}
      {caption && <p className="text-2xs text-fg-3">{caption}</p>}
    </article>
  );
}
```

**`src/components/ui/Sparkline.tsx`**

```tsx
import { cn } from "@/lib/cn";

interface SparklineProps {
  /** Werte in zeitlicher Reihenfolge; null = keine Messung (Lücke in der Linie). */
  values: ReadonlyArray<number | null>;
  /** Linienfarbe (CSS). Standard: Einzelserien-Farbe (Glasfaser-Cyan). */
  color?: string;
  /** Optionale Schwelle als gestrichelte Linie (z. B. 60 ms). */
  threshold?: number;
  thresholdColor?: string;
  /** Fester Wertebereich, sonst automatisch. */
  min?: number;
  max?: number;
  className?: string;
  /** Kurze Beschreibung für Screenreader, z. B. "Latenz der letzten 60 Minuten". */
  label?: string;
}

const W = 120;
const H = 32;
const PAD = 3;

/**
 * Reines SVG, keine Abhängigkeit, Server-tauglich. Das SVG dehnt sich per
 * preserveAspectRatio="none" auf die Containerbreite, vector-effect hält die Linie
 * 1,5 px dick; der Endpunkt ist ein HTML-Element, damit er rund bleibt.
 */
export function Sparkline({
  values,
  color = "var(--np-chart-solo)",
  threshold,
  thresholdColor = "var(--np-warn)",
  min,
  max,
  className,
  label,
}: SparklineProps) {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) {
    return (
      <div className={cn("np-hatch h-8 w-full rounded opacity-60", className)} role="img" aria-label="Noch zu wenige Messwerte" />
    );
  }
  const lo = min ?? Math.min(...nums, threshold ?? Infinity);
  const hi = max ?? Math.max(...nums, threshold ?? -Infinity);
  const span = hi - lo || 1;
  const step = (W - PAD * 2) / Math.max(1, values.length - 1);
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

  let line = "";
  let area = "";
  let segStart = -1;
  const closeArea = (end: number) => {
    area += `L${x(end).toFixed(1)},${H - PAD}L${x(segStart).toFixed(1)},${H - PAD}Z`;
  };
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (segStart >= 0) closeArea(i - 1);
      segStart = -1;
      return;
    }
    const cmd = segStart < 0 ? "M" : "L";
    if (segStart < 0) segStart = i;
    const pt = `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    line += pt;
    area += pt;
  });
  if (segStart >= 0) closeArea(values.length - 1);

  const lastIndex = values.length - 1;
  const last = values[lastIndex];

  return (
    <div className={cn("relative h-8 w-full", className)} role={label ? "img" : undefined} aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full overflow-visible">
        <path d={area} style={{ fill: color }} fillOpacity={0.1} />
        {threshold != null && (
          <line
            x1={0}
            x2={W}
            y1={y(threshold)}
            y2={y(threshold)}
            style={{ stroke: thresholdColor }}
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            opacity={0.7}
          />
        )}
        <path
          d={line}
          fill="none"
          style={{ stroke: color }}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {last != null && Number.isFinite(last) && (
        <span
          aria-hidden
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel"
          style={{ left: `${(x(lastIndex) / W) * 100}%`, top: `${(y(last) / H) * 100}%`, backgroundColor: color }}
        />
      )}
    </div>
  );
}
```

**`src/components/ui/Button.tsx`**

```tsx
import type { ComponentPropsWithRef } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  /** Zeigt Spinner, setzt aria-busy und sperrt den Button. */
  loading?: boolean;
}

const VARIANT: Record<Variant, string> = {
  // Glasfaser-Fläche mit dunklem Text (10,5:1), Glow nur bei Hover
  primary: "bg-fiber-strong text-fg-invert hover:bg-fiber hover:shadow-glow active:bg-fiber-deep",
  secondary: "bg-raised text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay hover:ring-line-control",
  ghost: "text-fg-2 hover:bg-raised hover:text-fg",
  danger: "text-crit ring-1 ring-inset ring-crit/40 hover:bg-crit/12",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-9 gap-2 rounded-lg px-3.5 text-sm",
  lg: "h-11 gap-2 rounded-lg px-5 text-base",
};

const ICON_SIZE: Record<Size, string> = { sm: "size-3.5", md: "size-4", lg: "size-4.5" };

/** Icon-only-Buttons brauchen aria-label. Beschriftung = Verb + Objekt ("Messung starten"). */
export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,box-shadow,color] duration-150 ease-np",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber",
        "disabled:pointer-events-none disabled:opacity-45",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle aria-hidden className={cn(ICON_SIZE[size], "animate-spin")} />
      ) : (
        Icon && <Icon aria-hidden className={ICON_SIZE[size]} strokeWidth={2} />
      )}
      {children}
      {IconRight && !loading && <IconRight aria-hidden className={ICON_SIZE[size]} strokeWidth={2} />}
    </button>
  );
}
```

**`src/components/ui/Tabs.tsx`**

```tsx
"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: string;
  /** Als Element übergeben (<Gauge className="size-4" />), nicht als Komponente:
      Funktionen dürfen nicht von Server- an Client-Komponenten gereicht werden. */
  icon?: ReactNode;
  /** Zähler, z. B. Anzahl Ereignisse */
  count?: number;
}

interface TabsProps {
  items: readonly TabItem[];
  /** Inhalt je Tab – vom Server gerendert, hier nur ein-/ausgeblendet (Zustand bleibt erhalten). */
  panels: Readonly<Record<string, ReactNode>>;
  defaultValue?: string;
  /** Kontrolliert (nur aus Client-Komponenten, da Funktion) */
  value?: string;
  onValueChange?: (id: string) => void;
  /** Beschriftung der Tab-Leiste für Screenreader, z. B. "Ansicht Verlauf" */
  label: string;
  className?: string;
}

/** WAI-ARIA Tabs: Pfeiltasten, Home/End, automatische Aktivierung. Server-tauglich über `panels`. */
export function Tabs({ items, panels, defaultValue, value, onValueChange, label, className }: TabsProps) {
  const baseId = useId();
  const [inner, setInner] = useState(defaultValue ?? items[0]?.id ?? "");
  const active = value ?? inner;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    onValueChange?.(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.id === active);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    select(items[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        {items.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              type="button"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              className={cn(
                "relative -mb-px inline-flex h-10 shrink-0 items-center gap-2 px-3 text-sm font-medium text-fg-3 transition-colors hover:text-fg",
                "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fiber after:opacity-0 after:transition-opacity",
                "aria-selected:text-fg aria-selected:after:opacity-100",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fiber",
              )}
            >
              {t.icon}
              {t.label}
              {t.count != null && (
                <span className="np-num rounded-full bg-raised px-1.5 text-2xs text-fg-2 ring-1 ring-inset ring-line">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${baseId}-panel-${t.id}`}
          aria-labelledby={`${baseId}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="pt-4 focus-visible:outline-none"
        >
          {panels[t.id]}
        </div>
      ))}
    </div>
  );
}
```

**`src/components/ui/DataTable.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Zahlen rechtsbündig + Mono + feste Ziffernbreite */
  numeric?: boolean;
  align?: "left" | "right" | "center";
  /** CSS-Breite, z. B. "8rem" */
  width?: string;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Sichtbarer oder sr-only Tabellentitel */
  caption: string;
  captionVisible?: boolean;
  /** Inhalt bei 0 Zeilen (z. B. <EmptyState/>) */
  empty?: ReactNode;
  dense?: boolean;
  /** Feste Höhe mit scrollendem Körper, Kopf bleibt stehen */
  maxHeight?: string;
  className?: string;
}

/**
 * Datentabelle: Haarlinien statt Zebra, Kopf in schmaler Plex-Breite (lange Komposita),
 * Zahlen in Mono. Auch die Tabellen-Alternative zu jedem Diagramm nutzt diese Komponente.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  captionVisible = false,
  empty,
  dense = false,
  maxHeight,
  className,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const alignClass = (c: Column<T>) =>
    c.align === "center" ? "text-center" : c.align === "right" || c.numeric ? "text-right" : "text-left";

  return (
    <div
      className={cn("relative overflow-auto rounded-[10px] ring-1 ring-line", className)}
      style={maxHeight ? { maxHeight } : undefined}
      tabIndex={maxHeight ? 0 : undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className={cn(captionVisible ? "px-3 py-2 text-left text-sm text-fg-2" : "sr-only")}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  "sticky top-0 z-10 h-9 border-b border-line-strong bg-raised px-3 text-xs font-medium text-fg-3 font-stretch-semi-condensed",
                  alignClass(c),
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="group transition-colors hover:bg-raised/60">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "border-b border-line px-3 text-fg-2 group-last:border-b-0",
                    dense ? "h-8" : "h-10",
                    c.numeric && "np-num text-fg",
                    alignClass(c),
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**`src/components/ui/States.tsx`**

```tsx
import type { ReactNode } from "react";
import { LoaderCircle, SearchX, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/* -------------------------------------------------------------------------- */
/* Leerzustand: sagt, was fehlt und was man tun kann – keine Entschuldigung.  */
/* -------------------------------------------------------------------------- */
interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = SearchX, title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)}>
      {/* "Kein Signal"-Motiv: gestrichelter Ring */}
      <span className="grid size-12 place-items-center rounded-full border border-dashed border-line-control text-fg-3">
        <Icon aria-hidden className="size-5" strokeWidth={1.75} />
      </span>
      <div className="max-w-sm">
        <p className="font-display text-lg font-medium text-fg">{title}</p>
        {children && <div className="mt-1 text-sm text-fg-3">{children}</div>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton: nur für das ERSTE Laden. Beim Nachladen altes Bild mit 60 %     */
/* Deckkraft halten (siehe <Refetching/>) – kein Flackern, kein Layoutsprung.  */
/* -------------------------------------------------------------------------- */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("np-skeleton np-anim block h-4", className)} />;
}

export function KpiSkeleton() {
  return (
    <div className="np-panel flex flex-col gap-3 p-4" aria-busy="true" aria-label="Kennzahl wird geladen">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="relative overflow-hidden rounded-[10px]" style={{ height }} aria-busy="true" aria-label="Diagramm wird geladen">
      <div className="absolute inset-0 flex flex-col justify-between py-3">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className="block h-px bg-line/70" />
        ))}
      </div>
      <Skeleton className="absolute inset-x-0 bottom-0 h-1/2 rounded-none opacity-60" />
    </div>
  );
}

/** Beim Nachladen: vorhandenen Inhalt gedimmt stehen lassen. */
export function Refetching({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div aria-busy={active || undefined} className={cn("transition-opacity duration-200", active && "opacity-60")}>
      {children}
    </div>
  );
}

/** Laufende Aktion inline: "Speedtest läuft …" */
export function InlineProgress({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-fg-2", className)}>
      <LoaderCircle aria-hidden className="size-4 animate-spin text-fiber" />
      {children}
    </span>
  );
}
```

### Server/Client boundary rules (important with lucide-react 1.x)

- lucide icon *components* (`Activity`, …) are plain functions in server modules (only lucide's inner `Icon` is `"use client"`). **Never pass an icon component or any function from a Server Component to a Client Component.** Pass an element (`icon: <Gauge className="size-4" />`) instead – that is why `Tabs` takes `icon?: ReactNode` and `panels` (pre-rendered content) instead of a render function.
- `Button`, `KpiTile`, `Panel`, `HealthBadge`, `EmptyState`, `DataTable`, `SegmentTopology`, `EventTimeline`, `EventStrip`, `HourHeatmap`, `FindingCard`, `NetworkBackground` have no directive → usable in Server Components (icon props are fine there).
- ECharts options contain functions (formatters) → build them **in a client component** from serialisable data (see `LatencyChart`).

---

## 10. Visualisation components

### 10.1 Segment topology "Leitungsweg"

- Horizontal SVG (viewBox 880 × 204) when its container is ≥ 48rem, vertical SVG (360 × 548) below – via Tailwind container queries (`@container`, `@3xl:`). Max widths keep text between ~11 and ~17 px.
- Links: 10 px translucent glow + 2 px core in the health colour; unknown = dashed, no packets. DOCSIS is a wave (coax/RF), LAN and Internet are straight.
- Packets: 3 per link, `offset-path: path(...)` on SVG groups, 2.8 s per traversal, staggered by negative delays. Loss ≥ 0.5 % or crit → the 2nd packet uses `np-travel-drop` (falls 16 px and fades at mid-link).
- Values: RTT = median from the PC to the end of the segment (traceroute semantics); loss = the share attributed to this segment (increase vs. previous segment). The caption states this.
- Nodes: quiet (line-strong ring) when good, health ring + 10 % halo when warn/crit, dashed when unknown; status dot top-right.
- Accessible: `role="img"` + `<title>` + generated `<desc>` ("PC & Adapter: Auffällig. LAN-Kabel: Kritisch, 0,9 ms, 2,1 % Verlust …"), legend with icons + words below.

**`src/components/viz/SegmentTopology.tsx`**

```tsx
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { fmtMs, fmtPct } from "@/lib/format";
import { HEALTH_COLOR, HEALTH_ICON, HEALTH_LABEL, type Health } from "@/lib/health";
import { SEGMENT_BY_ID } from "@/lib/segments";

type NodeId = "pc" | "router" | "provider" | "targets";
type LinkId = "lan" | "docsis" | "internet";
type CSSVars = CSSProperties & Record<`--${string}`, string>;

export interface TopologyNodeState {
  health: Health;
  /** Zeile 2, kurz halten (max. ca. 22 Zeichen), z. B. "I225-V, 100 Mbit/s" */
  sublabel?: string;
  /** Zeile 3 (Mono), z. B. "77 Link-Abbrüche" */
  detail?: string;
}

export interface TopologyLinkState {
  health: Health;
  /** RTT vom PC bis zum Ende dieses Abschnitts (Median, kumuliert wie bei traceroute) */
  rttMs?: number | null;
  /** Paketverlust, der DIESEM Abschnitt zugeordnet ist (Zuwachs ggü. dem vorherigen) */
  lossPct?: number | null;
}

export interface SegmentTopologyProps {
  nodes: Record<NodeId, TopologyNodeState>;
  links: Record<LinkId, TopologyLinkState>;
  /** DS-Lite-Tunnel (IPv4 in IPv6) zwischen Router und AFTR einzeichnen */
  showTunnel?: boolean;
  /** Eindeutiger Präfix für SVG-IDs, falls mehrere Diagramme auf einer Seite stehen */
  id?: string;
  className?: string;
}

const NODE_ORDER: NodeId[] = ["pc", "router", "provider", "targets"];
const LINK_ORDER: LinkId[] = ["lan", "docsis", "internet"];
const NODE_LABEL: Record<NodeId, string> = { pc: "PC & Adapter", router: "Router", provider: "Vodafone & AFTR", targets: "Ziele" };
const LINK_LABEL: Record<LinkId, string> = { lan: "LAN-Kabel", docsis: "Kabelnetz (DOCSIS)", internet: "Internet" };
const TRAVEL_S = 2.8; // muss zu --travel in theme.css passen

type Orientation = "h" | "v";
interface Geometry {
  w: number;
  h: number;
  tile: number;
  nodes: Array<{ x: number; y: number }>;
  links: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

/* Horizontal ab Containerbreite 48rem, darunter vertikal. Schriftgrößen in viewBox-
   Einheiten so gewählt, dass sie im Zielbereich (768–1120 px bzw. 320–420 px) >= 11 px bleiben. */
function geometry(o: Orientation): Geometry {
  if (o === "h") {
    const xs = [72, 317, 563, 808];
    const y = 100;
    const gap = 40; // halbe Kachel + Luft
    return {
      w: 880,
      h: 204,
      tile: 64,
      nodes: xs.map((x) => ({ x, y })),
      links: [0, 1, 2].map((i) => ({ x1: xs[i] + gap, y1: y, x2: xs[i + 1] - gap, y2: y })),
    };
  }
  const ys = [44, 196, 348, 500];
  const x = 44;
  const gap = 36;
  return {
    w: 360,
    h: 548,
    tile: 56,
    nodes: ys.map((y) => ({ x, y })),
    links: [0, 1, 2].map((i) => ({ x1: x, y1: ys[i] + gap, x2: x, y2: ys[i + 1] - gap })),
  };
}

/** Koax (DOCSIS) = Welle, Ethernet/Backbone = gerade. Pakete folgen exakt diesem Pfad. */
function linkPath(id: LinkId, l: Geometry["links"][number]): string {
  if (id !== "docsis") return `M${l.x1} ${l.y1}L${l.x2} ${l.y2}`;
  const horizontal = l.y1 === l.y2;
  const len = horizontal ? l.x2 - l.x1 : l.y2 - l.y1;
  const n = Math.max(2, Math.round(len / 12));
  const s = +(len / n).toFixed(2);
  const a = 6;
  let d = `M${l.x1} ${l.y1}`;
  d += horizontal ? `q${s / 2} ${-a} ${s} 0` : `q${-a} ${s / 2} 0 ${s}`;
  for (let i = 1; i < n; i++) d += horizontal ? `t${s} 0` : `t0 ${s}`;
  return d;
}

function describe(nodes: SegmentTopologyProps["nodes"], links: SegmentTopologyProps["links"]): string {
  const parts: string[] = [];
  NODE_ORDER.forEach((n, i) => {
    parts.push(`${NODE_LABEL[n]}: ${HEALTH_LABEL[nodes[n].health]}`);
    const l = LINK_ORDER[i];
    if (l) {
      const s = links[l];
      parts.push(`${LINK_LABEL[l]}: ${HEALTH_LABEL[s.health]}, ${fmtMs(s.rttMs)}, ${fmtPct(s.lossPct)} Verlust`);
    }
  });
  return `${parts.join(". ")}.`;
}

interface DiagramProps {
  o: Orientation;
  uid: string;
  desc: string;
  nodes: SegmentTopologyProps["nodes"];
  links: SegmentTopologyProps["links"];
  showTunnel: boolean;
}

function Diagram({ o, uid, desc, nodes, links, showTunnel }: DiagramProps) {
  const g = geometry(o);
  const t = g.tile;
  const r = o === "h" ? 18 : 16;
  const titleId = `${uid}-${o}-title`;
  const descId = `${uid}-${o}-desc`;
  return (
    <svg viewBox={`0 0 ${g.w} ${g.h}`} role="img" aria-labelledby={`${titleId} ${descId}`} className="block h-auto w-full overflow-visible">
      <title id={titleId}>Leitungsweg vom PC zu den Zielen</title>
      <desc id={descId}>{desc}</desc>

      {/* DS-Lite: IPv4 reist in IPv6 verpackt vom Router bis zum AFTR (Vodafone) */}
      {showTunnel &&
        (o === "h" ? (
          <g style={{ color: "var(--np-fg-4)" }}>
            <path d={`M${g.nodes[1].x} 36V26H${g.nodes[2].x}V36`} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 4" />
            <text x={(g.nodes[1].x + g.nodes[2].x) / 2} y={18} textAnchor="middle" className="fill-fg-3 text-[12px]">
              DS-Lite-Tunnel (IPv4 in IPv6)
            </text>
          </g>
        ) : (
          <g style={{ color: "var(--np-fg-4)" }}>
            <path d={`M320 ${g.nodes[1].y}H332V${g.nodes[2].y}H320`} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 4" />
            <text
              transform={`translate(346 ${(g.nodes[1].y + g.nodes[2].y) / 2}) rotate(90)`}
              textAnchor="middle"
              className="fill-fg-3 text-[12px]"
            >
              DS-Lite-Tunnel
            </text>
          </g>
        ))}

      {/* Links: Glow (breit, transparent) + Kern (2 px) + Pakete */}
      {LINK_ORDER.map((id, i) => {
        const s = links[id];
        const l = g.links[i];
        const d = linkPath(id, l);
        const unknown = s.health === "unknown";
        const packets = unknown ? 0 : 3;
        const drop = s.health === "crit" || (s.lossPct ?? 0) >= 0.5;
        const mx = (l.x1 + l.x2) / 2;
        const my = (l.y1 + l.y2) / 2;
        const pos =
          o === "h"
            ? { x: mx, y1: my - 18, y2: my + 28, anchor: "middle" as const }
            : { x: 90, y1: my - 4, y2: my + 16, anchor: "start" as const };
        return (
          <g key={id} style={{ color: HEALTH_COLOR[s.health] }}>
            <path d={d} fill="none" stroke="currentColor" strokeWidth={10} strokeOpacity={s.health === "crit" ? 0.2 : 0.12} strokeLinecap="round" />
            <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={unknown ? "3 5" : undefined} />
            {Array.from({ length: packets }, (_, p) => {
              const style: CSSVars = { offsetPath: `path('${d}')`, "--delay": `${((-p * TRAVEL_S) / packets).toFixed(2)}s` };
              return (
                <g key={p} className={cn("np-anim np-packet", drop && p === 1 && "np-packet--drop")} style={style}>
                  <circle r={6.5} fill="currentColor" fillOpacity={0.22} />
                  <circle r={2.6} style={{ fill: "color-mix(in oklab, currentColor 45%, var(--np-fg))" }} />
                </g>
              );
            })}
            <text x={pos.x} y={pos.y1} textAnchor={pos.anchor} className="fill-fg-3 text-[12.5px]">
              {LINK_LABEL[id]}
            </text>
            <text x={pos.x} y={pos.y2} textAnchor={pos.anchor} className="np-num text-[13.5px]">
              {unknown ? (
                <tspan className="fill-fg-3">keine Daten</tspan>
              ) : (
                <>
                  <tspan className="fill-fg">{fmtMs(s.rttMs)}</tspan>
                  <tspan className="fill-fg-3" dx={10}>
                    {fmtPct(s.lossPct)}
                  </tspan>
                </>
              )}
            </text>
          </g>
        );
      })}

      {/* Knoten: ruhig wenn gut, laut wenn auffällig/kritisch */}
      {NODE_ORDER.map((id, i) => {
        const s = nodes[id];
        const { x, y } = g.nodes[i];
        const Icon = SEGMENT_BY_ID[id].icon;
        const loud = s.health === "warn" || s.health === "crit";
        const color = HEALTH_COLOR[s.health];
        const txt =
          o === "h"
            ? { x, y1: y + t / 2 + 22, y2: y + t / 2 + 40, y3: y + t / 2 + 58, anchor: "middle" as const }
            : { x: 90, y1: y - 8, y2: y + 10, y3: y + 28, anchor: "start" as const };
        return (
          <g key={id}>
            {loud && (
              <rect x={x - t / 2 - 5} y={y - t / 2 - 5} width={t + 10} height={t + 10} rx={r + 5} style={{ fill: color }} fillOpacity={0.1} />
            )}
            <rect
              x={x - t / 2}
              y={y - t / 2}
              width={t}
              height={t}
              rx={r}
              style={{ fill: "var(--np-panel)", stroke: loud ? color : "var(--np-line-strong)" }}
              strokeWidth={loud ? 1.5 : 1}
              strokeDasharray={s.health === "unknown" ? "3 4" : undefined}
            />
            <Icon x={x - 12} y={y - 12} width={24} height={24} strokeWidth={1.75} style={{ color: "var(--np-fg-2)" }} />
            <circle cx={x + t / 2 - 6} cy={y - t / 2 + 6} r={5.5} style={{ fill: color, stroke: "var(--np-panel)" }} strokeWidth={3} />
            <text x={txt.x} y={txt.y1} textAnchor={txt.anchor} className="fill-fg font-display text-[15px] font-medium">
              {NODE_LABEL[id]}
            </text>
            {s.sublabel && (
              <text x={txt.x} y={txt.y2} textAnchor={txt.anchor} className="fill-fg-3 text-[12.5px]">
                {s.sublabel}
              </text>
            )}
            {s.detail && (
              <text x={txt.x} y={txt.y3} textAnchor={txt.anchor} className="np-num text-[12px]" style={{ fill: loud ? color : "var(--np-fg-3)" }}>
                {s.detail}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Leitungsweg PC -> LAN -> Router -> DOCSIS -> Vodafone/AFTR -> Internet -> Ziele.
 * Linkfarbe = Zustand. Pakete laufen per CSS offset-path und pausieren automatisch
 * (Tab verborgen, 90 s Inaktivität, reduzierte Bewegung). Bei Verlust fällt ein Paket
 * sichtbar aus der Leitung. Server-Komponente: keine Hooks, kein eigenes JS.
 */
export function SegmentTopology({ nodes, links, showTunnel = true, id = "np-topo", className }: SegmentTopologyProps) {
  const desc = describe(nodes, links);
  return (
    <figure className={cn("@container", className)}>
      <div className="mx-auto hidden max-w-[1120px] @3xl:block">
        <Diagram o="h" uid={id} desc={desc} nodes={nodes} links={links} showTunnel={showTunnel} />
      </div>
      <div className="mx-auto max-w-[420px] @3xl:hidden">
        <Diagram o="v" uid={id} desc={desc} nodes={nodes} links={links} showTunnel={showTunnel} />
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
        {(["good", "warn", "crit", "unknown"] as const).map((h) => {
          const Icon = HEALTH_ICON[h];
          return (
            <span key={h} className="inline-flex items-center gap-1.5">
              <Icon aria-hidden className="size-3.5" style={{ color: HEALTH_COLOR[h] }} strokeWidth={2.25} />
              {HEALTH_LABEL[h]}
            </span>
          );
        })}
        <span className="text-fg-4">RTT: Median bis Abschnittsende. Verlust: Anteil dieses Abschnitts.</span>
      </figcaption>
    </figure>
  );
}
```

### 10.2 Events

**`src/components/viz/EventTimeline.tsx`**

```tsx
import { cn } from "@/lib/cn";
import { dayKey, fmtDayLong, fmtDuration, fmtTime } from "@/lib/format";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TEXT, type Severity } from "@/lib/health";
import { SEGMENT_BY_ID, type SegmentId } from "@/lib/segments";

export interface TimelineEvent {
  id: string;
  /** ISO-Zeitpunkt */
  at: string;
  severity: Severity;
  segment?: SegmentId;
  /** Was passiert ist, aus Nutzersicht: "Ethernet-Verbindung getrennt" */
  title: string;
  /** Beleg/Kontext: "Neu verbunden mit 100 Mbit/s statt 1 Gbit/s" */
  detail?: string;
  durationS?: number;
  /** Quelle, z. B. "Windows-Ereignisprotokoll (e2fexpress, ID 27)" */
  source?: string;
}

interface EventTimelineProps {
  events: readonly TimelineEvent[];
  /** "Jetzt" als ISO-String vom Server/Client übergeben (kein Date.now() im Render). */
  now?: string;
  /** Abstand der klebenden Tagesüberschrift: 0 in eigenem Scroll-Container,
      56 (Höhe Statusleiste) wenn die ganze Seite scrollt. */
  stickyOffset?: number;
  className?: string;
}

function dayHeading(key: string, now?: string): string {
  if (now) {
    const today = dayKey(now);
    const yesterday = dayKey(new Date(new Date(now).getTime() - 86_400_000));
    if (key === today) return `Heute, ${fmtDayLong(`${key}T12:00:00Z`)}`;
    if (key === yesterday) return `Gestern, ${fmtDayLong(`${key}T12:00:00Z`)}`;
  }
  return fmtDayLong(`${key}T12:00:00Z`);
}

/**
 * Ereignisprotokoll, neueste zuerst, nach Kalendertag gruppiert.
 * Raster: Uhrzeit | Schiene mit Icon | Inhalt. Farbe nur am Icon, Text bleibt neutral.
 */
export function EventTimeline({ events, now, stickyOffset = 0, className }: EventTimelineProps) {
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at));
  const groups = new Map<string, TimelineEvent[]>();
  for (const e of sorted) {
    const k = dayKey(e.at);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {[...groups.entries()].map(([key, list]) => (
        <section key={key} aria-label={dayHeading(key, now)}>
          <h3 className="sticky z-10 mb-1 bg-panel py-1.5 font-sans text-xs font-medium text-fg-3" style={{ top: stickyOffset }}>
            {dayHeading(key, now)}
            <span className="np-num ml-2 text-fg-4">{list.length}</span>
          </h3>
          <ol className="flex flex-col">
            {list.map((e) => {
              const Icon = HEALTH_ICON[e.severity];
              const seg = e.segment ? SEGMENT_BY_ID[e.segment] : undefined;
              return (
                <li key={e.id} className="group grid grid-cols-[4.75rem_1.5rem_minmax(0,1fr)] gap-x-3">
                  <time dateTime={e.at} className="np-num pt-2.5 text-xs text-fg-3">
                    {fmtTime(e.at)}
                  </time>
                  <span className="relative flex justify-center">
                    <span aria-hidden className="absolute bottom-0 top-0 w-px bg-line group-first:top-4 group-last:bottom-auto group-last:h-4" />
                    <span className={cn("relative mt-2 grid size-6 place-items-center rounded-full bg-panel ring-1 ring-line", HEALTH_TEXT[e.severity])}>
                      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
                      <span className="sr-only">{HEALTH_LABEL[e.severity]}</span>
                    </span>
                  </span>
                  <div className="min-w-0 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-sm font-medium text-fg">{e.title}</p>
                      {e.durationS != null && (
                        <span className="np-num rounded-md bg-raised px-1.5 text-2xs leading-5 text-fg-2 ring-1 ring-inset ring-line">
                          {fmtDuration(e.durationS)}
                        </span>
                      )}
                      {seg && (
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2 text-2xs leading-5 text-fg-3 ring-1 ring-inset ring-line">
                          <span aria-hidden className={cn("size-1.5 rounded-full", seg.colorClass)} />
                          {seg.label}
                        </span>
                      )}
                    </div>
                    {e.detail && <p className="mt-0.5 text-xs text-fg-3">{e.detail}</p>}
                    {e.source && <p className="mt-0.5 text-2xs text-fg-4">Quelle: {e.source}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
```

**`src/components/viz/EventStrip.tsx`**

```tsx
import { cn } from "@/lib/cn";
import { fmtDuration, fmtShortTime, fmtTime } from "@/lib/format";
import { HEALTH_LABEL, HEALTH_TEXT } from "@/lib/health";
import { SEGMENTS, type SegmentId } from "@/lib/segments";
import type { TimelineEvent } from "./EventTimeline";

interface EventStripProps {
  events: readonly TimelineEvent[];
  /** Zeitfenster als ISO-Strings, z. B. letzte 24 h */
  from: string;
  to: string;
  /** Welche Spuren gezeigt werden (Standard: alle mit Ereignissen + PC/Router/DOCSIS) */
  lanes?: SegmentId[];
  className?: string;
}

/**
 * 24-h-Streifen: eine Spur je Segment, Striche = Ereignisse, Breite = Dauer (min. 2 px).
 * Macht Muster sichtbar wie "Link-Abbrüche gehäuft 18:29–18:43". Reines HTML/CSS.
 * Schmaler Container (< 28rem): Spurname steht über der Spur, damit die Zeitachse Platz hat.
 */
export function EventStrip({ events, from, to, lanes, className }: EventStripProps) {
  const t0 = new Date(from).getTime();
  const t1 = new Date(to).getTime();
  const span = Math.max(1, t1 - t0);
  const used = new Set(events.map((e) => e.segment).filter(Boolean) as SegmentId[]);
  const laneIds = lanes ?? SEGMENTS.filter((s) => used.has(s.id) || ["pc", "router", "docsis"].includes(s.id)).map((s) => s.id);
  // 5 Marken (bei 24 h alle 6 h) – überlappen auch in schmalen Spalten nicht
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);

  return (
    <div className={cn("@container", className)}>
      <div className="grid grid-cols-1 gap-x-3 text-xs @md:grid-cols-[8.5rem_minmax(0,1fr)]">
        {laneIds.map((id) => {
          const seg = SEGMENTS.find((s) => s.id === id)!;
          const laneEvents = events.filter((e) => e.segment === id);
          return (
            <div key={id} className="contents">
              <div className="flex h-5 items-end gap-2 truncate text-fg-3 @md:h-7 @md:items-center">
                <seg.icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
                <span className="truncate">{seg.label}</span>
              </div>
              <div className="relative h-7 border-b border-line" role="list" aria-label={`Ereignisse ${seg.label}`}>
                {laneEvents.map((e) => {
                  const start = new Date(e.at).getTime();
                  const left = ((start - t0) / span) * 100;
                  const width = (((e.durationS ?? 0) * 1000) / span) * 100;
                  if (left < 0 || left > 100) return null;
                  const label = `${fmtTime(e.at)} ${e.title}${e.durationS != null ? `, ${fmtDuration(e.durationS)}` : ""} (${HEALTH_LABEL[e.severity]})`;
                  return (
                    <span
                      key={e.id}
                      role="listitem"
                      title={label}
                      aria-label={label}
                      className={cn("absolute bottom-1.5 top-1.5 rounded-sm bg-current opacity-90", HEALTH_TEXT[e.severity])}
                      style={{ left: `${left}%`, width: `max(2px, ${width}%)` }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div aria-hidden className="hidden @md:block" />
        <div aria-hidden className="relative mt-1 h-4">
          {ticks.map((t, i) => (
            <span
              key={t}
              className={cn(
                "np-num absolute text-2xs text-fg-4",
                i === 0 ? "translate-x-0" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${(i / (ticks.length - 1)) * 100}%` }}
            >
              {fmtShortTime(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
```

Align `from` to the full hour so ticks read 18:00 / 00:00 / 06:00 …

### 10.3 Hour × day heatmap

**`src/components/viz/HourHeatmap.tsx`**

```tsx
import { cn } from "@/lib/cn";
import { fmtDayShort, fmtNumber } from "@/lib/format";

export interface HeatCell {
  /** Kalendertag "YYYY-MM-DD" (Europe/Berlin) */
  day: string;
  /** Stunde 0–23 */
  hour: number;
  /** null = keine Messung in dieser Stunde */
  value: number | null;
  samples?: number;
}

interface HourHeatmapProps {
  cells: readonly HeatCell[];
  /** Tage in Anzeige-Reihenfolge (oben -> unten), "YYYY-MM-DD" */
  days: readonly string[];
  /** Messgröße für Tooltip/Legende: "Paketverlust", "p95-Latenz" */
  metric: string;
  unit: string;
  /** Oberes Ende der Skala (Werte darüber = Stufe 6), z. B. 5 (%) oder 200 (ms) */
  max: number;
  digits?: number;
  className?: string;
}

const STEPS = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4", "bg-heat-5", "bg-heat-6"] as const;

/** 0 = exakt 0; 1–5 = gleich breite Klassen bis max; 6 = ab max. */
function stepFor(v: number, max: number): number {
  if (v <= 0) return 0;
  if (v >= max) return 6;
  return 1 + Math.floor(v / (max / 5));
}

/**
 * Stunde × Tag – zeigt Tageszeit-Muster (z. B. Abend-Auslastung im Kabelsegment).
 * Reines CSS-Grid: scharf, druckbar, ohne Canvas. Für Zoom/Brush: hourHeatmapOption() (ECharts).
 */
export function HourHeatmap({ cells, days, metric, unit, max, digits = 1, className }: HourHeatmapProps) {
  const map = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c]));
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const legend = STEPS.map((cls, i) => ({
    cls,
    text: i === 0 ? "0" : i === 1 ? `über 0` : `ab ${fmtNumber(((i - 1) * max) / 5, digits)}`,
  }));

  return (
    <figure className={cn("min-w-0", className)}>
      {/* relative: sr-only-Elemente (absolut) bleiben im Scroll-Container und dehnen die Seite nicht */}
      <div className="relative overflow-x-auto pb-1">
        <div
          className="grid min-w-[640px] gap-[3px]"
          style={{ gridTemplateColumns: "5.5rem repeat(24, minmax(0, 1fr))" }}
          role="table"
          aria-label={`${metric} je Stunde und Tag`}
        >
          <div role="row" className="contents">
            <span role="columnheader">
              <span className="sr-only">Tag</span>
            </span>
            {hours.map((h) => (
              <span key={h} role="columnheader" className="np-num text-center text-2xs text-fg-4">
                {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                <span className="sr-only">{`${h} Uhr`}</span>
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div key={day} role="row" className="contents">
              <span role="rowheader" className="truncate pr-2 text-right text-xs leading-5 text-fg-3">
                {fmtDayShort(`${day}T12:00:00Z`)}
              </span>
              {hours.map((h) => {
                const c = map.get(`${day}|${h}`);
                const has = c != null && c.value != null;
                const label = has
                  ? `${fmtDayShort(`${day}T12:00:00Z`)}, ${h}–${h + 1} Uhr: ${fmtNumber(c.value, digits)} ${unit} ${metric}${c.samples ? ` (${c.samples} Messungen)` : ""}`
                  : `${fmtDayShort(`${day}T12:00:00Z`)}, ${h}–${h + 1} Uhr: keine Messung`;
                return (
                  <span
                    key={h}
                    role="cell"
                    title={label}
                    aria-label={label}
                    className={cn(
                      "h-5 rounded-[3px] transition-[outline-color] hover:outline hover:outline-1 hover:outline-fg",
                      has ? STEPS[stepFor(c.value as number, max)] : "np-hatch",
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-fg-3">
        <span className="text-fg-2">
          {metric} ({unit})
        </span>
        {legend.map((l) => (
          <span key={l.cls} className="inline-flex items-center gap-1">
            <span aria-hidden className={cn("h-3 w-4 rounded-[3px]", l.cls)} />
            <span className="np-num">{l.text}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="np-hatch h-3 w-4 rounded-[3px] ring-1 ring-inset ring-line" />
          keine Messung
        </span>
      </figcaption>
    </figure>
  );
}
```

### 10.4 Finding card

**`src/components/viz/FindingCard.tsx`**

```tsx
import type { ReactNode } from "react";
import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/cn";
import { HEALTH_COLOR, type Severity } from "@/lib/health";
import { SEGMENT_BY_ID, type SegmentId } from "@/lib/segments";
import { HealthBadge } from "@/components/ui/HealthBadge";

export interface FindingEvidence {
  /** Beobachtung in Worten */
  label: string;
  /** Messwert, Mono: "77", "3–22 s", "30 von 77" */
  value?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  /** Aussage, nicht Kategorie: "Ethernet-Link bricht wiederholt ab" */
  title: string;
  summary: string;
  segment?: SegmentId;
  confidence?: "niedrig" | "mittel" | "hoch";
  evidence: readonly FindingEvidence[];
  /** Konkreter nächster Schritt */
  recommendation?: string;
}

interface FindingCardProps {
  finding: Finding;
  /** Buttons, z. B. "Im Verlauf zeigen", "Als erledigt markieren" */
  actions?: ReactNode;
  className?: string;
}

/** Befund = Schwere + Segment + Belege + Empfehlung. Die linke Schiene trägt die Schwere. */
export function FindingCard({ finding: f, actions, className }: FindingCardProps) {
  const seg = f.segment ? SEGMENT_BY_ID[f.segment] : undefined;
  return (
    <article className={cn("np-panel overflow-hidden", className)}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: HEALTH_COLOR[f.severity] }} />
      <div className="flex flex-col gap-3 p-5 pl-6">
        <header className="flex flex-wrap items-center gap-2">
          <HealthBadge status={f.severity} />
          {seg && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-2 ring-1 ring-inset ring-line">
              <seg.icon aria-hidden className="size-3.5 text-fg-3" strokeWidth={2} />
              {seg.label}
            </span>
          )}
          {f.confidence && <span className="ml-auto text-xs text-fg-3">Sicherheit: {f.confidence}</span>}
        </header>

        <div>
          <h3 className="text-lg font-medium text-fg">{f.title}</h3>
          <p className="mt-1 max-w-prose text-sm text-fg-2">{f.summary}</p>
        </div>

        {f.evidence.length > 0 && (
          <dl className="divide-y divide-line/70 rounded-[10px] bg-sunken/60 px-4 ring-1 ring-inset ring-line">
            {f.evidence.map((e, i) => (
              <div key={i} className="flex items-baseline justify-between gap-6 py-2">
                <dt className="text-sm text-fg-3">{e.label}</dt>
                <dd className="np-num shrink-0 text-right text-sm text-fg">{e.value ?? ""}</dd>
              </div>
            ))}
          </dl>
        )}

        {f.recommendation && (
          <p className="flex gap-2.5 text-sm text-fg-2">
            <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-laser" strokeWidth={2} />
            <span>
              <span className="font-medium text-fg">Empfehlung: </span>
              {f.recommendation}
            </span>
          </p>
        )}

        {actions && <footer className="flex flex-wrap gap-2 pt-1">{actions}</footer>}
      </div>
    </article>
  );
}
```

### 10.5 ECharts wrapper and a reference chart

**`src/components/viz/EChart.tsx`**

```tsx
"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import langDE from "echarts/i18n/langDE-obj.js";
import { cn } from "@/lib/cn";
import { registerNetzpulsThemes, THEME_DARK, THEME_LIGHT } from "@/lib/echarts-theme";

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  VisualMapComponent,
  TitleComponent,
  DatasetComponent,
  AriaComponent,
  CanvasRenderer,
]);
echarts.registerLocale("DE", langDE as Parameters<typeof echarts.registerLocale>[1]);

let themesReady = false;
function ensureThemes() {
  if (!themesReady) {
    registerNetzpulsThemes(echarts);
    themesReady = true;
  }
}

interface EChartProps {
  option: echarts.EChartsCoreOption;
  /** Pflicht: worum geht es? z. B. "Latenz zu 1.1.1.1, letzte 24 Stunden" */
  ariaLabel: string;
  /** Höhe INKLUSIVE Achsenbeschriftung (kein innerer Scrollbalken) */
  height?: number;
  /** true: Option komplett ersetzen (setzt Zoom/Legende zurück) */
  notMerge?: boolean;
  /** Nur diese Komponenten ersetzen, Rest mergen – z. B. ["series"] bei Serien-Filter;
      Zoom und Legendenauswahl bleiben erhalten. */
  replaceMerge?: string[];
  className?: string;
}

/**
 * Schlanker ECharts-Wrapper:
 * - wartet auf Webfonts (Canvas misst Text nur einmal)
 * - ResizeObserver, Dirty-Rect-Rendering, deutsche Locale
 * - druckt automatisch im hellen Theme (beforeprint/afterprint)
 * Live-Diagramme: option.animation = false und Updates höchstens 1×/s.
 */
export function EChart({ option, ariaLabel, height = 280, notMerge = false, replaceMerge, className }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  const optionRef = useRef(option);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let ro: ResizeObserver | undefined;
    const toLight = () => chartRef.current?.setTheme(THEME_LIGHT);
    const toDark = () => chartRef.current?.setTheme(THEME_DARK);

    const init = async () => {
      await document.fonts?.ready;
      if (disposed) return;
      ensureThemes();
      const chart = echarts.init(el, THEME_DARK, { renderer: "canvas", useDirtyRect: true, locale: "DE" });
      chartRef.current = chart;
      chart.setOption(optionRef.current, { notMerge: true });
      ro = new ResizeObserver(() => chart.resize());
      ro.observe(el);
      window.addEventListener("beforeprint", toLight);
      window.addEventListener("afterprint", toDark);
    };
    void init();

    return () => {
      disposed = true;
      ro?.disconnect();
      window.removeEventListener("beforeprint", toLight);
      window.removeEventListener("afterprint", toDark);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    optionRef.current = option;
    chartRef.current?.setOption(option, { notMerge, replaceMerge, lazyUpdate: true });
  }, [option, notMerge, replaceMerge]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className={cn("w-full", className)} style={{ height }} />;
}
```

**`src/types/echarts-i18n.d.ts`**

```ts
// ECharts liefert für die Sprachdateien keine Typen mit.
declare module "echarts/i18n/langDE-obj.js" {
  const lang: Record<string, unknown>;
  export default lang;
}
```

**`src/components/viz/LatencyChart.tsx`**

```tsx
"use client";

import { useMemo } from "react";
import {
  axisTooltipFormatter,
  chartTokens,
  eventLine,
  markLines,
  outageMarkArea,
  seriesColor,
  thresholdLine,
  type ChartEvent,
  type Outage,
} from "@/lib/echarts-theme";
import { THRESHOLDS } from "@/lib/health";
import { EChart } from "./EChart";

const REPLACE = ["series"]; // stabil (außerhalb der Komponente), sonst läuft setOption bei jedem Render

export interface LatencySeries {
  /** Anzeigename, z. B. "1.1.1.1" */
  name: string;
  /** Fester Farbslot 0–7 des Ziels (in den Einstellungen gespeichert) */
  slot: number;
  /** [Zeitstempel ms, RTT ms | null] – null = keine Antwort/keine Messung */
  points: Array<[number, number | null]>;
}

interface LatencyChartProps {
  series: LatencySeries[];
  outages?: Outage[];
  events?: ChartEvent[];
  /** Zeitfenster (ms) – fest setzen, damit Lücken am Rand sichtbar bleiben */
  from: number;
  to: number;
  height?: number;
  /** true bei Live-Ansicht: keine Animation, Updates max. 1×/s */
  live?: boolean;
}

/**
 * Beispiel für das Muster "Daten vom Server, Option im Client":
 * ECharts-Optionen enthalten Funktionen (Formatter) und sind NICHT serialisierbar –
 * Server-Komponenten übergeben nur Zahlen/Strings, die Option entsteht hier.
 */
export function LatencyChart({ series, outages = [], events = [], from, to, height = 300, live = false }: LatencyChartProps) {
  const option = useMemo(() => {
    const t = chartTokens("dark");
    return {
      animation: !live,
      legend: { data: series.map((s) => s.name) },
      tooltip: { formatter: axisTooltipFormatter({ unit: "ms", t }) },
      xAxis: { type: "time", min: from, max: to },
      yAxis: { type: "value", name: "ms" },
      series: series.map((s, i) => ({
        name: s.name,
        type: "line",
        color: seriesColor(s.slot, t),
        data: s.points,
        // Marker nur an der ersten Serie, sonst doppelt gezeichnet
        ...(i === 0
          ? {
              markArea: outageMarkArea(outages, t),
              markLine: markLines([
                thresholdLine(THRESHOLDS.rttMs.warn, `${THRESHOLDS.rttMs.warn} ms: auffällig`, "warn", t),
                thresholdLine(THRESHOLDS.rttMs.crit, `${THRESHOLDS.rttMs.crit} ms: kritisch`, "crit", t),
                ...events.map((e) => eventLine(e, t)),
              ]),
            }
          : {}),
      })),
    };
  }, [series, outages, events, from, to, live]);

  const label = `Latenz je Ziel (${series.map((s) => s.name).join(", ")})`;
  return <EChart option={option} ariaLabel={label} height={height} replaceMerge={REPLACE} />;
}
```

### 10.6 Example page (Live-Dashboard) and demo data

Shows the Next 16 pattern: header renders immediately, data inside `<Suspense>`, `await connection()` before synchronous SQLite reads (node:sqlite would otherwise run at build time).

**`src/app/page.tsx`**

```tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Activity, Cable, CalendarDays, Gauge, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { KpiTile } from "@/components/ui/KpiTile";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Sparkline } from "@/components/ui/Sparkline";
import { ChartSkeleton, KpiSkeleton } from "@/components/ui/States";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { FindingCard } from "@/components/viz/FindingCard";
import { LatencyChart } from "@/components/viz/LatencyChart";
import { SegmentTopology } from "@/components/viz/SegmentTopology";
import { getDemoDashboard } from "@/lib/demo-data";
import { fmtMsValue, fmtNumber, fmtPctValue } from "@/lib/format";
import { rate, THRESHOLDS } from "@/lib/health";

export const metadata: Metadata = { title: "Live-Dashboard" };

/** Seitenmuster: Kopf + Filter sofort, Daten in Suspense (Cache Components). */
export default function LiveDashboardPage() {
  return (
    <>
      <PageHeader
        title="Live-Dashboard"
        description="Zustand der Leitung jetzt und in den letzten 24 Stunden – aus der laufenden Langzeitmessung."
        actions={
          <>
            <Button size="sm" icon={CalendarDays}>
              Letzte 24 Stunden
            </Button>
            {/* Im Projekt: Client-Komponente mit fetch("/api/engine/speedtest", { method: "POST" }) */}
            <Button size="sm" variant="primary" icon={Gauge}>
              Speedtest starten
            </Button>
          </>
        }
      />
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent />
      </Suspense>
    </>
  );
}

async function DashboardContent() {
  await connection(); // node:sqlite ist synchron: ohne connection() würde beim Build vorgerendert
  const d = await getDemoDashboard();
  const k = d.kpi;
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Leitungsweg" description="Wo entsteht das Problem? Farbe = Zustand des Abschnitts, Punkte = laufende Pakete." frame>
        <SegmentTopology nodes={d.topology.nodes} links={d.topology.links} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <KpiTile label="Latenz zu 1.1.1.1" value={fmtMsValue(k.rttMs)} unit="ms" status={rate(k.rttMs, THRESHOLDS.rttMs)} icon={Activity} caption="Median, letzte 5 min">
          <Sparkline values={k.rttSpark} label="Latenz der letzten 48 Minuten" />
        </KpiTile>
        <KpiTile label="Jitter" value={fmtNumber(k.jitterMs)} unit="ms" status={rate(k.jitterMs, THRESHOLDS.jitterMs)} caption="letzte 5 min" />
        <KpiTile label="Paketverlust" value={fmtPctValue(k.lossPct)} unit="%" status={rate(k.lossPct, THRESHOLDS.lossPct)} caption="letzte 15 min" />
        <KpiTile label="Ping-Spitzen über 150 ms" value={String(k.spikes150)} status={k.spikes150 > 0 ? "warn" : "good"} caption="heute, alle Ziele" />
        <KpiTile label="Link-Abbrüche Ethernet" value={String(k.linkDropsToday)} status={k.linkDropsToday > 0 ? "crit" : "good"} icon={Unplug} caption="heute" />
        <KpiTile
          label="Linkgeschwindigkeit"
          value={String(k.linkMbit)}
          unit="Mbit/s"
          status={k.linkMbit < 1000 ? "warn" : "good"}
          statusLabel={k.linkMbit < 1000 ? "Zu langsam" : undefined}
          icon={Cable}
          caption="erwartet 1 Gbit/s"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2" title="Latenz je Ziel" description="Median je Minute, letzte 6 Stunden. Rot hinterlegt: Ethernet getrennt.">
          <LatencyChart series={d.latency.series} outages={d.latency.outages} events={d.latency.events} from={d.latency.from} to={d.latency.to} height={340} />
        </Panel>
        <Panel title="Ereignisse" description="Letzte 24 Stunden" bodyClassName="max-h-[380px] overflow-y-auto">
          <EventTimeline events={d.events} now={d.now} />
        </Panel>
      </div>

      <section aria-labelledby="befunde">
        <h2 id="befunde" className="mb-3 mt-4 text-xl font-medium text-fg">
          Befunde
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {d.findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      </section>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="np-panel p-5">
        <ChartSkeleton height={204} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
```

**`src/lib/demo-data.ts`**

```ts
/**
 * NUR DEMO: Platzhalter-Daten im Format, das die Komponenten erwarten.
 * Im Projekt durch echte SQLite-Abfragen ersetzen (node:sqlite ist synchron ->
 * vor der Abfrage `await connection()` aus "next/server", sonst wird beim Build vorgerendert).
 */
import type { SegmentTopologyProps } from "@/components/viz/SegmentTopology";
import type { TimelineEvent } from "@/components/viz/EventTimeline";
import type { Finding } from "@/components/viz/FindingCard";
import type { LatencySeries } from "@/components/viz/LatencyChart";
import type { Outage, ChartEvent } from "@/lib/echarts-theme";

export interface DashboardData {
  now: string;
  topology: Pick<SegmentTopologyProps, "nodes" | "links">;
  kpi: {
    rttMs: number;
    rttSpark: Array<number | null>;
    jitterMs: number;
    lossPct: number;
    spikes150: number;
    linkDropsToday: number;
    linkMbit: number;
  };
  latency: { from: number; to: number; series: LatencySeries[]; outages: Outage[]; events: ChartEvent[] };
  events: TimelineEvent[];
  findings: Finding[];
}

export async function getDemoDashboard(): Promise<DashboardData> {
  const to = Date.parse("2026-10-08T17:00:00Z");
  const from = to - 6 * 3600_000;
  const points = (base: number): Array<[number, number | null]> =>
    Array.from({ length: 361 }, (_, i) => {
      const x = from + i * 60_000;
      const v = base + Math.sin(i / 9) * base * 0.15 + ((i * 7919) % 13) / 13;
      return [x, i % 97 === 50 ? null : Math.round(v * 10) / 10];
    });
  return {
    now: "2026-10-09T16:12:00Z",
    topology: {
      nodes: {
        pc: { health: "warn", sublabel: "I225-V, 100 Mbit/s", detail: "1 Abbruch heute" },
        router: { health: "good", sublabel: "Vodafone Station", detail: "DOCSIS online" },
        provider: { health: "unknown", sublabel: "DS-Lite, CGNAT", detail: "Hop 2 antwortet nicht" },
        targets: { health: "good", sublabel: "1.1.1.1, 8.8.8.8", detail: "19 ms Median" },
      },
      links: {
        lan: { health: "crit", rttMs: 0.9, lossPct: 2.1 },
        docsis: { health: "good", rttMs: 14, lossPct: 0.1 },
        internet: { health: "good", rttMs: 19, lossPct: 0.1 },
      },
    },
    kpi: { rttMs: 19, rttSpark: points(19).slice(-48).map((p) => p[1]), jitterMs: 3.1, lossPct: 0.4, spikes150: 37, linkDropsToday: 10, linkMbit: 100 },
    latency: {
      from,
      to,
      series: [
        { name: "Router (Gateway)", slot: 0, points: points(0.9) },
        { name: "1.1.1.1", slot: 1, points: points(19) },
        { name: "8.8.8.8", slot: 2, points: points(18) },
      ],
      outages: [{ from: "2026-10-08T16:29:00Z", to: "2026-10-08T16:43:30Z", label: "8 Link-Abbrüche", severity: "crit" }],
      events: [{ at: "2026-10-08T13:02:00Z", label: "Link weg", severity: "crit" }],
    },
    events: [
      { id: "e2", at: "2026-10-08T16:42:43Z", severity: "crit", segment: "pc", title: "Ethernet-Verbindung getrennt", durationS: 22, detail: "Wieder verbunden mit 100 Mbit/s", source: "e2fexpress, ID 27" },
      { id: "e5", at: "2026-10-08T17:58:00Z", severity: "info", segment: "pc", title: "PC im Standby", detail: "Kein Zusammenhang mit den Abbrüchen erkennbar" },
    ],
    findings: [
      {
        id: "f1",
        severity: "crit",
        title: "Ethernet-Link bricht wiederholt ab",
        summary: "Der Netzwerkadapter verliert mehrmals täglich die Verbindung zum Router. Jeder Abbruch erzeugt Paketverlust und Ping-Spitzen.",
        segment: "pc",
        confidence: "hoch",
        evidence: [
          { label: "Link-Abbrüche seit 24.08.", value: "77" },
          { label: "Dauer je Abbruch", value: "3–22 s" },
        ],
        recommendation: "Kabel und Router-Port tauschen, Energiesparfunktionen des Adapters prüfen.",
      },
    ],
  };
}
```

---

## 11. ECharts theme (`echarts-theme.ts`)

Place at `src/lib/echarts-theme.ts`.

**`src/lib/echarts-theme.ts`**

```ts
/**
 * NETZPULS – ECharts-6-Theme + Options-Helfer
 * ------------------------------------------------------------------
 * Ablage im Projekt: src/lib/echarts-theme.ts
 *
 * Verwendung (nur im Browser, z. B. in components/viz/EChart.tsx):
 *   import * as echarts from "echarts/core";
 *   import { registerNetzpulsThemes, THEME_DARK } from "@/lib/echarts-theme";
 *   registerNetzpulsThemes(echarts);                       // einmalig
 *   echarts.init(el, THEME_DARK, { renderer: "canvas", useDirtyRect: true, locale: "DE" });
 *
 * Farben sind 1:1 aus theme.css gespiegelt (dunkel = zweites Argument von light-dark()).
 * registerNetzpulsThemes() liest im Browser zusätzlich die echten CSS-Variablen
 * (inkl. der von next/font erzeugten Schriftnamen) und überschreibt damit die Fallbacks.
 *
 * Regeln (dataviz):
 * - Linien 2 px, Marker >= 8 px mit 2-px-Ring in Flächenfarbe, Flächen 10 % Deckkraft
 * - Balken max. 24 px, 4 px Rundung am Datenende, eckig an der Basis
 * - Gitter: durchgezogene Haarlinien; gestrichelt NUR für Schwellen/Referenzen
 * - Kategoriale Farben in fester Reihenfolge, nie zyklisch: Serie 9+ -> "Sonstige"
 * - Statusfarben (good/warn/crit) nie als Serienfarbe; Texte nie in Serienfarbe
 * - Keine zweite y-Achse: zwei Größen = zwei Diagramme
 */
import type {
  MarkAreaComponentOption,
  MarkLineComponentOption,
  TooltipComponentFormatterCallbackParams,
  VisualMapComponentOption,
} from "echarts";

export type ChartSeverity = "good" | "warn" | "crit" | "unknown" | "info";

export interface ChartTokens {
  mode: "dark" | "light";
  surface: string; // Chart-Fläche (= Panel)
  raised: string;
  overlay: string;
  fg: string;
  fg2: string;
  fg3: string;
  fg4: string;
  fgInvert: string;
  line: string;
  lineStrong: string;
  grid: string;
  axis: string;
  fiber: string;
  laser: string;
  good: string;
  warn: string;
  crit: string;
  unknown: string;
  info: string;
  /** 8 kategoriale Farben, feste Reihenfolge */
  series: readonly string[];
  other: string;
  ref: string;
  solo: string;
  /** 7 Stufen Heatmap (0 = ruhig) */
  heat: readonly string[];
  /** 7 Segmentfarben (Nah -> Fern) */
  seg: readonly string[];
  fontSans: string;
  fontMono: string;
  fontDisplay: string;
}

const FONT_SANS = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';
const FONT_DISPLAY = '"Space Grotesk", "Segoe UI", system-ui, sans-serif';

export const CHART_TOKENS_DARK: ChartTokens = {
  mode: "dark",
  surface: "#0A1627",
  raised: "#121E31",
  overlay: "#19263A",
  fg: "#EAF1F8",
  fg2: "#BDCADA",
  fg3: "#97A4B6",
  fg4: "#6E7A8B",
  fgInvert: "#00141E",
  line: "#243144",
  lineStrong: "#404E63",
  grid: "#182334",
  axis: "#323E50",
  fiber: "#2EEBFC",
  laser: "#B09CFF",
  good: "#54DD7D",
  warn: "#FFBD4A",
  crit: "#FF6367",
  unknown: "#8E99A8",
  info: "#63B9FE",
  series: ["#00A5C4", "#9264EF", "#CA358B", "#217BF4", "#D16100", "#008777", "#AE9200", "#BF64E4"],
  other: "#6E7A8B",
  ref: "#BDCADA",
  solo: "#2EEBFC",
  heat: ["#1C263A", "#3F316C", "#76338A", "#BC3181", "#EC5258", "#FD923E", "#FFDB68"],
  seg: ["#C2F2F8", "#86E2F2", "#48CEEA", "#09B7DC", "#009EC9", "#0085B4", "#006E9F"],
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  fontDisplay: FONT_DISPLAY,
};

export const CHART_TOKENS_LIGHT: ChartTokens = {
  mode: "light",
  surface: "#FFFFFF",
  raised: "#F0F4F9",
  overlay: "#FFFFFF",
  fg: "#0E1624",
  fg2: "#394353",
  fg3: "#586475",
  fg4: "#828D9C",
  fgInvert: "#FFFFFF",
  line: "#DCE2E9",
  lineStrong: "#C0C8D3",
  grid: "#E6EBF1",
  axis: "#C0C8D3",
  fiber: "#00758D",
  laser: "#653CBD",
  good: "#087736",
  warn: "#965800",
  crit: "#C2272D",
  unknown: "#5F6A77",
  info: "#1F68BC",
  series: ["#0095B5", "#7544CD", "#9E0067", "#0062D4", "#CB5A00", "#008779", "#9E8400", "#9C40BF"],
  other: "#9AA4B2",
  ref: "#394353",
  solo: "#00758D",
  heat: ["#F0F4F9", "#F5DFAC", "#F9B96C", "#F47F46", "#DB4241", "#A02262", "#591E66"],
  seg: ["#45C1D4", "#03ACC7", "#0096B3", "#007FA0", "#006A8D", "#005579", "#004166"],
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  fontDisplay: FONT_DISPLAY,
};

export const THEME_DARK = "netzpuls-dark";
export const THEME_LIGHT = "netzpuls-light";

/* ------------------------------------------------------------------ */
/* Farb-Hilfen                                                         */
/* ------------------------------------------------------------------ */

/** "#RRGGBB" | "rgb(r, g, b)" | "rgba(...)" -> "rgba(r,g,b,a)" */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.startsWith("#") && (c.length === 7 || c.length === 4)) {
    const hex = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (!m) return c;
    r = Number(m[1]);
    g = Number(m[2]);
    b = Number(m[3]);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Serienfarbe für einen festen Slot (0–7). Farbe folgt der ENTITÄT, nicht dem Rang:
 * Slot beim Anlegen eines Ziels vergeben, speichern, nie neu verteilen. Ab Slot 8 -> "Sonstige".
 */
export function seriesColor(slot: number, t: ChartTokens = chartTokens()): string {
  return slot >= 0 && slot < t.series.length ? t.series[slot] : t.other;
}

/** Statusfarbe nach Schwere */
export function severityColor(sev: ChartSeverity, t: ChartTokens = CHART_TOKENS_DARK): string {
  return { good: t.good, warn: t.warn, crit: t.crit, unknown: t.unknown, info: t.info }[sev];
}

/* ------------------------------------------------------------------ */
/* Deutsche Formate                                                    */
/* ------------------------------------------------------------------ */
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const dfTooltip = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Berlin",
});

export function fmtAxisNumber(v: number): string {
  const a = Math.abs(v);
  return (a >= 100 ? nf0 : a >= 1 ? nf1 : nf2).format(v);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export function createNetzpulsTheme(t: ChartTokens): Record<string, unknown> {
  const axisCommon = () => ({
    axisLine: { show: true, lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false, lineStyle: { color: t.axis } },
    axisLabel: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11, margin: 10, hideOverlap: true },
    splitLine: { show: true, lineStyle: { color: t.grid, width: 1, type: "solid" } },
    splitArea: { show: false },
    minorTick: { lineStyle: { color: t.axis } },
    minorSplitLine: { lineStyle: { color: withAlpha(t.grid, 0.5), type: "solid" } },
    nameTextStyle: { color: t.fg3, fontFamily: t.fontSans, fontSize: 11 },
  });

  return {
    darkMode: t.mode === "dark",
    // 8 kategorial + "Sonstige" + "Referenz" (nie eine 11. Farbe erzeugen)
    color: [...t.series, t.other, t.ref],
    backgroundColor: "transparent",
    textStyle: { color: t.fg2, fontFamily: t.fontSans, fontSize: 12 },

    animation: true,
    animationDuration: 400,
    animationDurationUpdate: 250,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    animationThreshold: 2000,

    title: {
      left: 0,
      top: 0,
      padding: [0, 0, 8, 0],
      textStyle: { color: t.fg, fontFamily: t.fontDisplay, fontSize: 14, fontWeight: 500 },
      subtextStyle: { color: t.fg3, fontFamily: t.fontSans, fontSize: 12 },
    },

    // ECharts 6: containLabel ist veraltet -> outerBounds
    grid: {
      left: 4,
      right: 12,
      top: 44, // Platz für Legende (oben) + Achsenname
      bottom: 4,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
      borderColor: t.line,
    },

    legend: {
      type: "scroll",
      top: 0,
      left: 0, // oben links, bündig mit der y-Achse (ECharts-Default wäre zentriert)
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: t.fg2, fontFamily: t.fontSans, fontSize: 12 },
      inactiveColor: t.fg4,
      inactiveBorderColor: t.fg4,
      pageIconColor: t.fg2,
      pageIconInactiveColor: t.fg4,
      pageTextStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
    },

    tooltip: {
      trigger: "axis",
      confine: true,
      transitionDuration: 0,
      backgroundColor: t.overlay,
      borderColor: t.lineStrong,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: t.fg, fontFamily: t.fontSans, fontSize: 12 },
      extraCssText: `border-radius:8px;box-shadow:0 18px 48px -12px ${withAlpha("#000000", t.mode === "dark" ? 0.7 : 0.2)};`,
      axisPointer: {
        type: "line",
        lineStyle: { color: t.fg3, width: 1, type: "solid" },
        crossStyle: { color: t.fg3, width: 1 },
        shadowStyle: { color: withAlpha(t.fiber, 0.06) },
      },
    },

    axisPointer: {
      lineStyle: { color: t.fg3, width: 1 },
      crossStyle: { color: t.fg3, width: 1 },
      label: {
        backgroundColor: t.raised,
        borderColor: t.lineStrong,
        borderWidth: 1,
        color: t.fg,
        fontFamily: t.fontMono,
        fontSize: 11,
        padding: [3, 6],
        borderRadius: 4,
      },
    },

    timeAxis: {
      ...axisCommon(),
      splitLine: { show: false },
      axisLabel: {
        ...axisCommon().axisLabel,
        // Deutsche Stufen-Formate; {MMM} kommt aus Locale "DE"
        formatter: {
          year: "{yyyy}",
          month: "{MMM}",
          day: "{d}. {MMM}",
          hour: "{HH}:{mm}",
          minute: "{HH}:{mm}",
          second: "{HH}:{mm}:{ss}",
          millisecond: "{HH}:{mm}:{ss}",
          none: "{dd}.{MM}.{yyyy} {HH}:{mm}",
        },
      },
    },
    valueAxis: {
      ...axisCommon(),
      axisLine: { show: false },
      axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => fmtAxisNumber(v) },
    },
    logAxis: { ...axisCommon(), axisLine: { show: false } },
    categoryAxis: { ...axisCommon(), splitLine: { show: false }, axisTick: { show: false } },

    // Serien
    line: {
      symbol: "circle",
      symbolSize: 8,
      showSymbol: false,
      smooth: false,
      connectNulls: false, // Lücke = keine Messung, nie überbrücken
      sampling: "lttb",
      lineStyle: { width: 2, cap: "round", join: "round" },
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
      emphasis: { focus: "series", lineStyle: { width: 2 } },
      blur: { lineStyle: { opacity: 0.25 }, itemStyle: { opacity: 0.25 } },
    },
    bar: {
      barMaxWidth: 24,
      barGap: "20%",
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { opacity: 0.9 } },
    },
    scatter: {
      symbolSize: 8,
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
    },
    heatmap: {
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: t.fg, borderWidth: 1 } },
    },

    // Zoom
    dataZoom: {
      backgroundColor: "transparent",
      borderColor: t.line,
      fillerColor: withAlpha(t.fiber, 0.1),
      height: 22,
      bottom: 0,
      dataBackground: {
        lineStyle: { color: t.fg4, width: 1 },
        areaStyle: { color: t.fg4, opacity: 0.12 },
      },
      selectedDataBackground: {
        lineStyle: { color: t.fiber, width: 1 },
        areaStyle: { color: t.fiber, opacity: 0.12 },
      },
      handleStyle: { color: t.raised, borderColor: t.fiber, borderWidth: 1 },
      moveHandleStyle: { color: t.fg4, opacity: 0.4 },
      brushStyle: { color: withAlpha(t.fiber, 0.12) },
      textStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
      emphasis: {
        handleStyle: { borderColor: t.fiber, color: t.overlay },
        moveHandleStyle: { color: t.fiber, opacity: 0.6 },
      },
    },

    visualMap: {
      textStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
      inRange: { color: [...t.heat] },
      itemWidth: 12,
      itemHeight: 140,
    },

    // Marker: Schwellen (gestrichelt), Ereignisse, Ausfälle
    markLine: {
      silent: true,
      animation: false,
      symbol: ["none", "none"],
      lineStyle: { color: t.warn, width: 1, type: [4, 4] },
      label: { color: t.fg2, fontFamily: t.fontMono, fontSize: 11, position: "insideEndTop", distance: 4 },
      emphasis: { disabled: true },
    },
    markArea: {
      silent: true,
      animation: false,
      itemStyle: { color: withAlpha(t.crit, t.mode === "dark" ? 0.12 : 0.1), borderWidth: 0 },
      label: { color: t.crit, fontFamily: t.fontSans, fontSize: 11, position: "insideTop", distance: 6 },
      emphasis: { disabled: true },
    },
    markPoint: {
      label: { color: t.fgInvert, fontFamily: t.fontMono, fontSize: 11 },
    },

    // Screenreader-Beschreibung; Muster (decal) per aria.decal.show = true zuschaltbar
    aria: { enabled: true },
  };
}

/* ------------------------------------------------------------------ */
/* Registrierung + Abgleich mit CSS-Variablen                          */
/* ------------------------------------------------------------------ */

interface EChartsThemeRegistry {
  registerTheme: (name: string, theme: Record<string, unknown>) => void;
}

/** Aktives Farbschema der Seite (data-theme auf <html>, Standard dunkel). */
export function activeMode(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Liest die aufgelösten Farben und Schriftnamen aus dem DOM (CSS bleibt Quelle der Wahrheit).
 * Farben nur für das AKTIVE Schema: In Produktion ersetzt Lightning CSS light-dark() durch
 * Variablen, die schon auf :root aufgelöst werden – das andere Schema ist per Probe nicht
 * lesbar. Für das inaktive Schema gelten die gespiegelten Konstanten oben.
 * Schriftnamen (von next/font erzeugt) werden immer gelesen.
 */
export function readChartTokensFromCss(base: ChartTokens): ChartTokens {
  if (typeof document === "undefined") return base;
  const font = (cssVar: string, fallback: string): string => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    return v || fallback;
  };
  const fonts = {
    fontSans: font("--np-font-sans", base.fontSans),
    fontMono: font("--np-font-mono", base.fontMono),
    fontDisplay: font("--np-font-display", base.fontDisplay),
  };
  if (base.mode !== activeMode()) return { ...base, ...fonts };
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const color = (cssVar: string, fallback: string): string => {
    probe.style.color = "";
    probe.style.color = `var(${cssVar})`;
    const v = getComputedStyle(probe).color;
    return v && v !== "rgba(0, 0, 0, 0)" ? v : fallback;
  };
  const tokens: ChartTokens = {
    ...base,
    surface: color("--np-panel", base.surface),
    raised: color("--np-raised", base.raised),
    overlay: color("--np-overlay", base.overlay),
    fg: color("--np-fg", base.fg),
    fg2: color("--np-fg-2", base.fg2),
    fg3: color("--np-fg-3", base.fg3),
    fg4: color("--np-fg-4", base.fg4),
    fgInvert: color("--np-fg-invert", base.fgInvert),
    line: color("--np-line", base.line),
    lineStrong: color("--np-line-strong", base.lineStrong),
    grid: color("--np-chart-grid", base.grid),
    axis: color("--np-chart-axis", base.axis),
    fiber: color("--np-fiber", base.fiber),
    laser: color("--np-laser", base.laser),
    good: color("--np-good", base.good),
    warn: color("--np-warn", base.warn),
    crit: color("--np-crit", base.crit),
    unknown: color("--np-unknown", base.unknown),
    info: color("--np-info", base.info),
    series: base.series.map((c, i) => color(`--np-chart-${i + 1}`, c)),
    other: color("--np-chart-other", base.other),
    ref: color("--np-chart-ref", base.ref),
    solo: color("--np-chart-solo", base.solo),
    heat: base.heat.map((c, i) => color(`--np-heat-${i}`, c)),
    seg: base.seg,
    ...fonts,
  };
  probe.remove();
  return tokens;
}

let activeTokens: Record<"dark" | "light", ChartTokens> = { dark: CHART_TOKENS_DARK, light: CHART_TOKENS_LIGHT };

/** Tokens, mit denen zuletzt registriert wurde (für Helfer/Tooltip-Formatter). */
export function chartTokens(mode: "dark" | "light" = "dark"): ChartTokens {
  return activeTokens[mode];
}

/**
 * Registriert "netzpuls-dark" und "netzpuls-light". Im Browser vorher mit den echten
 * CSS-Werten abgleichen (Schriftnamen von next/font!). Nach Theme-Änderungen erneut
 * aufrufen und chart.setTheme(...) ausführen.
 */
export function registerNetzpulsThemes(echarts: EChartsThemeRegistry, opts: { syncWithCss?: boolean } = {}): void {
  const sync = opts.syncWithCss ?? typeof document !== "undefined";
  activeTokens = sync
    ? { dark: readChartTokensFromCss(CHART_TOKENS_DARK), light: readChartTokensFromCss(CHART_TOKENS_LIGHT) }
    : { dark: CHART_TOKENS_DARK, light: CHART_TOKENS_LIGHT };
  echarts.registerTheme(THEME_DARK, createNetzpulsTheme(activeTokens.dark));
  echarts.registerTheme(THEME_LIGHT, createNetzpulsTheme(activeTokens.light));
}

/* ------------------------------------------------------------------ */
/* Options-Helfer                                                      */
/* ------------------------------------------------------------------ */

type TimeValue = number | string | Date;
const ts = (v: TimeValue): number => (v instanceof Date ? v.getTime() : typeof v === "string" ? new Date(v).getTime() : v);

export interface Outage {
  from: TimeValue;
  to: TimeValue;
  /** Kurzlabel im Diagramm, z. B. "Link weg" – sparsam, nur breite Bereiche beschriften */
  label?: string;
  severity?: "crit" | "warn" | "unknown";
}

/** Ausfälle/Störungen als getönte Bereiche (in die betroffene Serie hängen: series[i].markArea). */
export function outageMarkArea(outages: readonly Outage[], t: ChartTokens = chartTokens()): MarkAreaComponentOption {
  return {
    silent: true,
    data: outages.map((o) => {
      const c = severityColor(o.severity ?? "crit", t);
      return [
        {
          name: o.label ?? "",
          xAxis: ts(o.from),
          itemStyle: { color: withAlpha(c, t.mode === "dark" ? 0.12 : 0.1) },
          label: { show: Boolean(o.label), color: c },
        },
        { xAxis: ts(o.to) },
      ];
    }),
  } as MarkAreaComponentOption;
}

export interface ChartEvent {
  at: TimeValue;
  /** sehr kurz: "Link 100 Mbit/s", "Router-Neustart" */
  label?: string;
  severity: ChartSeverity;
}

/** Ein Eintrag für markLine.data – mehrere Einträge mit markLines() bündeln. */
export type MarkLineItem = NonNullable<MarkLineComponentOption["data"]>[number];

/** Senkrechte Linie für ein Ereignis (Linkabbruch, Neustart, Standby). "info" bleibt neutral
    (fg3), damit es nicht mit der blauen Serienfarbe verwechselt wird. */
export function eventLine(e: ChartEvent, t: ChartTokens = chartTokens()): MarkLineItem {
  const c = e.severity === "info" ? t.fg3 : severityColor(e.severity, t);
  return {
    xAxis: ts(e.at),
    lineStyle: { color: c, width: 1, type: "solid", opacity: 0.8 },
    label: { show: Boolean(e.label), formatter: e.label ?? "", color: t.fg2, position: "insideEndTop" },
  } as MarkLineItem;
}

/** Waagerechte, gestrichelte Schwelle, z. B. 60 ms "auffällig". */
export function thresholdLine(
  value: number,
  label: string,
  severity: "warn" | "crit" = "warn",
  t: ChartTokens = chartTokens(),
): MarkLineItem {
  const c = severityColor(severity, t);
  return {
    yAxis: value,
    lineStyle: { color: c, width: 1, type: [4, 4] },
    // links oben: kollidiert seltener mit Ausfall-Bereichen und Legende am rechten Rand
    label: { formatter: label, color: t.fg2, position: "insideStartTop" },
  } as MarkLineItem;
}

/** Bündelt Schwellen und Ereignisse für series[i].markLine. */
export function markLines(items: readonly MarkLineItem[]): MarkLineComponentOption {
  return { silent: true, symbol: ["none", "none"], data: [...items] } as MarkLineComponentOption;
}

/** Kurzform: nur Ereignisse */
export function eventMarkLine(events: readonly ChartEvent[], t: ChartTokens = chartTokens()): MarkLineComponentOption {
  return markLines(events.map((e) => eventLine(e, t)));
}

/** Kurzform: eine Schwelle */
export function thresholdMarkLine(
  value: number,
  label: string,
  severity: "warn" | "crit" = "warn",
  t: ChartTokens = chartTokens(),
): MarkLineComponentOption {
  return markLines([thresholdLine(value, label, severity, t)]);
}

/** Kontinuierliche Skala für Heatmaps (immer mit sichtbarer Legende). */
export function heatVisualMap(
  min: number,
  max: number,
  t: ChartTokens = chartTokens(),
  opts: { unit?: string; orient?: "horizontal" | "vertical" } = {},
): VisualMapComponentOption {
  return {
    type: "continuous",
    min,
    max,
    calculable: false,
    orient: opts.orient ?? "horizontal",
    left: 0,
    bottom: 0,
    itemWidth: 10,
    itemHeight: 160,
    inRange: { color: [...t.heat] },
    text: [`${fmtAxisNumber(max)}${opts.unit ? ` ${opts.unit}` : ""}`, fmtAxisNumber(min)],
    textStyle: { color: t.fg3, fontFamily: t.fontMono, fontSize: 11 },
  } as VisualMapComponentOption;
}

/**
 * Achsen-Tooltip "Wert zuerst": Zeitkopf (Mono), dann je Serie: Linien-Schlüssel,
 * Wert (fett, Mono) + Einheit, Serienname (gedämpft). null -> "keine Messung".
 */
export function axisTooltipFormatter(opts: { unit?: string; digits?: number; t?: ChartTokens } = {}) {
  const t = opts.t ?? chartTokens();
  const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: opts.digits ?? 1 });
  const unit = opts.unit ? `&nbsp;${escapeHtml(opts.unit)}` : "";
  return (raw: TooltipComponentFormatterCallbackParams): string => {
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) return "";
    const first = list[0] as { axisValue?: unknown; axisValueLabel?: string };
    const av = first.axisValue;
    const head =
      typeof av === "number" || av instanceof Date ? dfTooltip.format(av) : escapeHtml(String(first.axisValueLabel ?? av ?? ""));
    const rows = list
      .map((p) => {
        const item = p as { seriesName?: string; color?: unknown; value?: unknown };
        const v = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
        const num = typeof v === "number" && Number.isFinite(v) ? `${nf.format(v)}${unit}` : "keine Messung";
        const key = typeof item.color === "string" ? item.color : t.fg3;
        return (
          `<div style="display:flex;align-items:center;gap:8px;line-height:20px">` +
          `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${key}"></span>` +
          `<span style="font-family:${escapeHtml(t.fontMono)};font-weight:600;color:${t.fg};min-width:64px">${num}</span>` +
          `<span style="color:${t.fg3}">${escapeHtml(item.seriesName ?? "")}</span>` +
          `</div>`
        );
      })
      .join("");
    return `<div style="font-family:${escapeHtml(t.fontMono)};font-size:11px;color:${t.fg3};margin-bottom:4px">${head}</div>${rows}`;
  };
}

export interface HourHeatDatum {
  day: string; // "YYYY-MM-DD"
  hour: number; // 0–23
  value: number | null;
}

/** Interaktive Stunde×Tag-Heatmap (Alternative zur CSS-Variante <HourHeatmap/>). */
export function hourHeatmapOption(
  data: readonly HourHeatDatum[],
  days: readonly string[],
  opts: { max: number; unit: string; metric: string; t?: ChartTokens },
): Record<string, unknown> {
  const t = opts.t ?? chartTokens();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const dfDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "Europe/Berlin" });
  return {
    animation: false,
    grid: { left: 4, right: 8, top: 8, bottom: 44, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    tooltip: {
      trigger: "item",
      formatter: (p: { value: [number, number, number | null] }) => {
        const [h, d, v] = p.value;
        const day = dfDay.format(new Date(`${days[d]}T12:00:00Z`));
        const val = v == null ? "keine Messung" : `${fmtAxisNumber(v)} ${escapeHtml(opts.unit)}`;
        return `<div style="font-family:${escapeHtml(t.fontMono)};font-size:11px;color:${t.fg3}">${day}, ${h}–${h + 1} Uhr</div><div><b style="font-family:${escapeHtml(t.fontMono)}">${val}</b> <span style="color:${t.fg3}">${escapeHtml(opts.metric)}</span></div>`;
      },
    },
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
      splitLine: { show: false },
      axisLine: { show: false },
      axisLabel: { interval: 2 },
    },
    yAxis: {
      type: "category",
      data: days.map((d) => dfDay.format(new Date(`${d}T12:00:00Z`))),
      inverse: true,
      splitLine: { show: false },
      axisLine: { show: false },
    },
    visualMap: heatVisualMap(0, opts.max, t, { unit: opts.unit }),
    series: [
      {
        type: "heatmap",
        data: data
          .filter((d) => dayIndex.has(d.day))
          .map((d) => [d.hour, dayIndex.get(d.day) as number, d.value]),
        progressive: 0,
      },
    ],
  };
}
```

Usage notes:
- `registerNetzpulsThemes()` reads colours of the **active** scheme and the next/font family names from CSS (probe element); the inactive scheme (light, for print) uses the mirrored constants – after the Lightning CSS rewrite the other scheme is not readable from the DOM. Keep the constants in sync with `theme.css`.
- Register once on the client (`EChart` does it), init with `THEME_DARK`, `{ renderer: "canvas", useDirtyRect: true, locale: "DE" }`. German month names need `echarts.registerLocale("DE", langDE)` with `import langDE from "echarts/i18n/langDE-obj.js"` (UMD file, works via bundler CJS interop; typed by `src/types/echarts-i18n.d.ts`).
- Wait for `document.fonts.ready` before init – canvas measures text once.
- ECharts 6 deprecates `grid.containLabel`; the theme uses `outerBoundsMode: "same"` + `outerBoundsContain: "axisLabel"` (equivalent). Legend default in v6 is centered/bottom – the theme pins it top-left.
- Live charts: `animation: false`, update ≤ 1×/s, `replaceMerge: ["series"]` keeps zoom/legend state; long ranges use `sampling: "lttb"` (theme default for line).
- Zoom: `dataZoom: [{ type: "inside" }, { type: "slider" }]` and `grid.bottom: 40` when the slider is shown.
- Outages: `series[0].markArea = outageMarkArea([...])`; thresholds and events: `markLine = markLines([thresholdLine(60, "60 ms: auffällig"), eventLine({...})])`.
- Print: `EChart` switches to `THEME_LIGHT` on `beforeprint` (ECharts 6 `setTheme`).
- Texture for colour-vision deficiency: set `aria: { enabled: true, decal: { show: true } }` when the user enables it (optional setting).

---

## 12. Background effect and motion

**`src/components/background/NetworkBackground.tsx`**

```tsx
import type { CSSProperties } from "react";

type CSSVars = CSSProperties & Record<`--${string}`, string | number>;

/* Feste, deterministische Knoten (kein Math.random: hydration- und cache-sicher). */
const NODES: Array<[number, number, 0 | 1]> = [
  [120, 120, 1], [360, 240, 0], [600, 120, 0], [840, 360, 1], [1080, 240, 0], [1320, 120, 0],
  [240, 480, 0], [480, 600, 1], [720, 480, 0], [960, 600, 0], [1200, 480, 1], [360, 840, 0],
  [720, 780, 0], [1080, 840, 0],
];
const EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 7], [7, 8], [8, 3], [8, 9],
  [9, 10], [10, 4], [7, 11], [11, 12], [12, 9], [12, 13], [13, 10],
];
/* Datenpulse laufen auf den 120-px-Hauptlinien des Rasters; nie synchron. */
const PULSES_X = [
  { row: 1, dur: "17s", delay: "-3s" },
  { row: 3, dur: "23s", delay: "-11s" },
  { row: 5, dur: "19s", delay: "-7s" },
];
const PULSES_Y = [
  { col: 3, dur: "21s", delay: "-5s" },
  { col: 8, dur: "27s", delay: "-15s" },
  { col: 11, dur: "24s", delay: "-19s" },
];

/**
 * Hintergrund: statisches Raster + statisches Netz (einmal gemalt) + 6 Pulse,
 * die nur transform/opacity animieren (Compositor, kein Repaint).
 * Pausiert über <MotionGovernor/>; bei prefers-reduced-motion ganz aus.
 * Server-Komponente, einmal im Root-Layout.
 */
export function NetworkBackground() {
  return (
    <div aria-hidden className="np-bg">
      <div className="np-bg__grid" />
      <svg className="np-bg__mesh" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <g stroke="currentColor" strokeOpacity={0.14} strokeWidth={1}>
          {EDGES.map(([a, b]) => (
            <line key={`${a}-${b}`} x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <g fill="currentColor">
          {NODES.map(([x, y, hub]) => (
            <g key={`${x}-${y}`}>
              {hub === 1 && <circle cx={x} cy={y} r={9} fillOpacity={0.06} />}
              <circle cx={x} cy={y} r={hub ? 2.5 : 1.75} fillOpacity={hub ? 0.5 : 0.3} />
            </g>
          ))}
        </g>
      </svg>
      {PULSES_X.map((p) => (
        <span key={`x${p.row}`} className="np-anim np-pulse np-pulse--x" style={{ "--row": p.row, "--dur": p.dur, "--delay": p.delay } as CSSVars} />
      ))}
      {PULSES_Y.map((p) => (
        <span key={`y${p.col}`} className="np-anim np-pulse np-pulse--y" style={{ "--col": p.col, "--dur": p.dur, "--delay": p.delay } as CSSVars} />
      ))}
    </div>
  );
}
```

**`src/components/background/MotionGovernor.tsx`**

```tsx
"use client";

import { useEffect } from "react";

export type MotionPreference = "auto" | "on" | "off";
const STORAGE_KEY = "np-motion";
const CHANGE_EVENT = "np-motion-change";

function readPreference(): MotionPreference {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Für die Einstellungen-Seite: "Hintergrundanimation: Automatisch | An | Aus". */
export function setMotionPreference(pref: MotionPreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* Speicher gesperrt – Einstellung gilt nur bis zum Neuladen */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Setzt <html data-motion="on|paused|off">:
 * - off:    Nutzer wählt "Aus" oder (bei "Automatisch") prefers-reduced-motion
 * - paused: Tab verborgen ODER idleMs ohne Eingabe (Dashboard läuft stundenlang)
 * - on:     sonst
 * Kostet praktisch nichts: passive Listener, ein 5-s-Intervall, keine Re-Renders.
 */
export function MotionGovernor({ idleMs = 90_000 }: { idleMs?: number }) {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let lastInput = performance.now();
    let idle = false;

    const apply = () => {
      const pref = readPreference();
      const off = pref === "off" || (pref === "auto" && reduced.matches);
      const state = off ? "off" : document.hidden || idle ? "paused" : "on";
      if (root.dataset.motion !== state) root.dataset.motion = state;
    };
    const onInput = () => {
      lastInput = performance.now();
      if (idle) {
        idle = false;
        apply();
      }
    };
    const tick = window.setInterval(() => {
      const nowIdle = performance.now() - lastInput > idleMs;
      if (nowIdle !== idle) {
        idle = nowIdle;
        apply();
      }
    }, 5_000);

    const opts: AddEventListenerOptions = { passive: true };
    const inputs = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    inputs.forEach((t) => window.addEventListener(t, onInput, opts));
    document.addEventListener("visibilitychange", apply);
    reduced.addEventListener("change", apply);
    window.addEventListener(CHANGE_EVENT, apply);
    window.addEventListener("storage", apply);
    apply();

    return () => {
      window.clearInterval(tick);
      inputs.forEach((t) => window.removeEventListener(t, onInput));
      document.removeEventListener("visibilitychange", apply);
      reduced.removeEventListener("change", apply);
      window.removeEventListener(CHANGE_EVENT, apply);
      window.removeEventListener("storage", apply);
    };
  }, [idleMs]);

  return null;
}
```

Budget and reasoning:
- Static: CSS grid (4 gradients + radial mask) and an SVG mesh of 14 nodes / 17 edges – painted once.
- Moving: 6 pulses (180 × 1 px), `transform`/`opacity` only (compositor), each visible ~28 % of a 17–27 s cycle; topology packets (≤ 9 groups) and the live dot.
- `html[data-motion]`: `on` → `paused` when the tab is hidden **or** 90 s without pointer/keyboard input (e.g. dashboard on a second monitor while gaming) → `off` for `prefers-reduced-motion` or the user setting. Packets are hidden (not frozen) when paused, so the line never looks "stuck".
- No `backdrop-filter` on large surfaces (would re-blur every frame behind animated content).
- Not measured on the target PC (uncertain): expected well below 1 % CPU when idle-paused; verify with DevTools → Rendering → "Paint flashing" (only packets should flash) and the Performance monitor.

---

## 13. Microcopy (German)

**Tone:** "du", factual, short, active voice, no apologies, no exclamation marks, no marketing. Explain *what happened* and *what to do*. Keep established tech terms (Ping, Jitter, Speedtest, Router, DNS, DOCSIS, Traceroute, Bufferbloat); otherwise German.

| Use | Avoid |
|---|---|
| Latenz (Messgröße), Ping (Messart) | "Lag" in UI text |
| Paketverlust | Packet Loss, Verlustrate |
| Link-Abbruch (Adapter verliert Verbindung) | Disconnect |
| Ausfall (Internet nicht erreichbar) | Downtime |
| Ping-Spitze (über Schwelle) | Spike |
| Durchsatz / Download / Upload in Mbit/s | MBit, Mbps, MB/s |
| Kabelnetz (DOCSIS), Kabelmodem | Coax-Netz |
| Vodafone Station (Router) | EasyBox (falsches Gerät) |
| Mess-Engine | Daemon, Worker |
| Befund, Empfehlung, Beleg | Issue, Insight |
| Gut / Auffällig / Kritisch / Unbekannt / Hinweis | OK / Warning / Error |
| läuft / pausiert / gestoppt / nicht erreichbar | running / idle |

**Patterns**
- Buttons = verb + object, same word in the confirmation: „Speedtest starten“ → „Speedtest gestartet“; „Messung pausieren“ → „Messung pausiert“; „Bericht exportieren“; „Router verbinden“; destructive: „Messdaten löschen“ + dialog „Messdaten älter als 30 Tage löschen? Das lässt sich nicht rückgängig machen.“ [Löschen] [Abbrechen].
- Empty states say what is missing and offer the next step: „Noch keine Speedtests. Der erste geplante Test läuft um 18:24 Uhr.“ [Ersten Speedtest starten] · „Keine Ereignisse in diesem Zeitraum.“ · „Noch zu wenige Messwerte für einen Befund – nach etwa 24 Stunden Messung erscheint hier die erste Auswertung.“
- Errors: cause + fix, no "Fehler!" headline: „Router nicht erreichbar (192.168.0.1). Prüfe das LAN-Kabel und versuche es erneut.“ · „Unter 192.168.0.2 antwortet kein Gerät. Dein Router ist die Vodafone Station unter 192.168.0.1.“ · „Anmeldung am Router gesperrt. Neuer Versuch in 2 Minuten möglich.“ · „Mess-Engine nicht erreichbar. Läuft der Befehl npm run dev noch?“
- Findings: title = statement („Ethernet-Link bricht wiederholt ab“), not category („Netzwerkproblem“). Recommendation starts with a verb.
- Page descriptions = one sentence answering what the page shows.

**Formats** (`lib/format.ts`)
- Numbers: `18,4 ms` (one decimal below 10 ms, LAN sub-ms matters: `0,9 ms`), `19 ms`, `0,8 %`, `1.000 Mbit/s`, `−3,2 dBmV`; missing value `–`.
- NBSP between number and unit, also before `%`.
- Time: `18:43:12`; date `08.10.2026`; combined `08.10.2026, 18:43:12`; day headings `Heute, Freitag, 9. Oktober 2026`; short `Do., 8.10.`.
- Durations: runtime `3 T 04:12:55`, short `22 s`, `3 min 05 s`, `2 h 14 min`; relative `in 12 Minuten`, `vor 3 Minuten` (Intl.RelativeTimeFormat).
- Ranges with en dash, no spaces: `18:29–18:43`, `3–22 s`.
- Quotes „…“, sentence case everywhere, no ALL CAPS, no "→" in buttons, no "A · B · C" meta strings (use separate chips/columns).

---

## 14. Icons (lucide-react 1.54 – names verified against the installed package)

| Purpose | Icon |
|---|---|
| Live-Dashboard / Verlauf / Diagnose | `Activity` / `ChartSpline` / `Stethoscope` |
| Speedtest / Route / Router / PC & Adapter | `Gauge` / `Route` / `Router` / `EthernetPort` |
| Ereignisse / Bericht / Messplan / Einstellungen | `ListClock` / `FileText` / `CalendarClock` / `Settings` |
| Segments | `Monitor`, `Cable`, `Router`, `AudioWaveform`, `Server`, `Globe`, `Target` |
| Status | `CircleCheck`, `TriangleAlert`, `OctagonAlert`, `CircleQuestionMark`, `Info` |
| Engine | running = pulsing dot, `Pause`, `CircleStop`, `PlugZap` (offline) |
| Events | `Unplug` (link down), `Cable` (link speed), `Moon` (standby), `WifiOff`, `Timer` |
| Actions | `Play`, `Pause`, `Download`, `RefreshCw`, `Funnel`, `CalendarDays`, `Printer`, `Waypoints` (im Verlauf zeigen), `Copy` |
| Findings | `Lightbulb` (Empfehlung), `FileSearch` (Belege) |
| Misc | `Menu`, `X`, `ChevronRight`, `ExternalLink`, `LoaderCircle` (spinner), `SearchX`/`Inbox` (empty) |

Old names like `AlertTriangle`, `CheckCircle2`, `HelpCircle`, `LineChart`, `Loader2`, `Filter` still exist only as deprecated aliases – use the canonical names above. Default size 16 px in text, 18 px in nav, stroke 1.75–2.25.

---

## 15. Accessibility checklist

- Text contrast ≥ 4.5:1 (all `fg`, `fg-2`, `fg-3`, status and accent tokens pass on every surface, both themes); `fg-4` only decorative.
- Input borders ≥ 3:1 (`line-control`); focus = 2 px fiber outline with 2 px offset, never removed.
- Status = icon + word; charts have legends for ≥ 2 series and a table alternative (`DataTable`); tooltips never the only way to a value.
- `lang="de"`, skip link „Zum Inhalt springen“, `aria-current="page"` in nav, WAI-ARIA tabs with arrow keys.
- Live values: no `aria-live` on per-second numbers (screen-reader spam); status changes may use a polite live region.
- Motion: reduced-motion honoured; pause/idle policy; no flashing.
- Touch targets ≥ 36 px (buttons md), 40 px tabs.

---

## 16. Implementation notes

1. Dependencies already in the project: `clsx`, `tailwind-merge`, `lucide-react`, `echarts`. No echarts-for-react needed (own 80-line wrapper).
2. Copy files: `theme.css` → `src/styles/theme.css`; `echarts-theme.ts` → `src/lib/echarts-theme.ts`; components/lib as listed (or copy `research/design/src/` directly; `demo-data.ts` and `app/page.tsx` are examples).
3. Replace `src/app/globals.css` and `src/app/layout.tsx` (scaffold Geist fonts removed).
4. Keep `next.config.ts` as it is (`@tailwindcss/turbopack` loader handles the CSS `@import`). The project currently runs the classic model (no `cacheComponents`); all code here builds with and without it. With `cacheComponents: true` the example page becomes a partial prerender (static shell + streamed data) – the intended pattern.
5. Keep the scaffold's AGENTS.md rule: check `node_modules/next/dist/docs/` for API changes.
6. Verification recipe used here (reproducible): real `next build`/`next start` in `research/design/nextcheck/` (project config + a copied node_modules, removed afterwards to save space), `tsc -p tsconfig.verify.json` (strict, noUnused*), ESLint with `eslint-config-next/core-web-vitals` + `/typescript`, Tailwind compile via `@tailwindcss/node` + `@tailwindcss/oxide`, static render via `react-dom/server` + ECharts in headless Chrome. Tools in `research/design/tools/`, preview in `research/design/verify/preview.html`, screenshots in `research/design/verify/shots/` (`real-next.png` = running Next app).

---

## 17. Open points / uncertain

- `next dev` (Turbopack dev server) was not run, only `next build` + `next start`; behaviour should be identical.
- Google Fonts are fetched at build/dev time; offline builds may fail (fallback: `next/font/local` with committed woff2 files).
- CSS `offset-path` on SVG groups was verified visually in Chrome (headless). Firefox should work; Safari irrelevant here.
- CPU cost of the background/packets not measured on the user's PC.
- `useEngineStatus()` endpoint/event names are placeholders for the engine API.
- Thresholds (60/150 ms, 10/30 ms, 0.5/2 %) are proposals.
- Light theme is tuned for print/report, not as a full day mode (works, but not reviewed screen by screen).
