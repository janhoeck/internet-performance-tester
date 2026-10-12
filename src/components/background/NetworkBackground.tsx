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
