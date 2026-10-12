/**
 * Mitschnitt des laufenden Speedtests aus dem Live-Stream (Fortschrittsmeldungen ≤ 4/s):
 * Mbit/s + Latenz je Meldung, für das Live-Minidiagramm. Begrenzt auf MAX_POINTS, beginnt bei
 * jedem neuen Test von vorn. React wird höchstens 1×/s benachrichtigt (Live-Diagramm-Regel).
 */
import { useSyncExternalStore } from "react";
import { getLiveState, subscribeLive } from "@/lib/client/live-store";
import type { SpeedSeriesPoint, SpeedtestProgress } from "@/lib/shared/types";

export interface LiveTrace {
  /** Empfangszeit der ersten Meldung des Tests (epoch ms) */
  startedAt: number | null;
  /** t = ms seit startedAt */
  points: readonly SpeedSeriesPoint[];
  running: boolean;
}

const MAX_POINTS = 600;
const NOTIFY_MS = 1000;
const EMPTY: LiveTrace = Object.freeze({ startedAt: null, points: Object.freeze([]) as readonly SpeedSeriesPoint[], running: false });

let trace: LiveTrace = EMPTY;
let lastProgress: SpeedtestProgress | null = null;
const listeners = new Set<() => void>();
let unsubscribeLive: (() => void) | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifyAt = 0;

function emit(): void {
  lastNotifyAt = Date.now();
  for (const l of [...listeners]) l();
}

function notify(immediate = false): void {
  if (immediate) {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = null;
    emit();
    return;
  }
  if (notifyTimer) return;
  const wait = Math.max(0, NOTIFY_MS - (Date.now() - lastNotifyAt));
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    emit();
  }, wait);
}

function onLive(): void {
  const p = getLiveState().speedtest;
  if (p === lastProgress) return;
  lastProgress = p;
  if (!p) return;
  const now = Date.now();
  if (p.running) {
    const fresh = !trace.running;
    const startedAt = fresh || trace.startedAt === null ? now : trace.startedAt;
    const prev = fresh ? [] : trace.points;
    const kept = prev.length >= MAX_POINTS ? prev.slice(prev.length - MAX_POINTS + 1) : prev;
    const point: SpeedSeriesPoint = { t: now - startedAt, phase: p.phase, mbps: p.currentMbps, rtt: p.currentRtt };
    trace = { startedAt, points: [...kept, point], running: true };
    notify(fresh);
  } else if (trace.running) {
    trace = { ...trace, running: false };
    notify(true);
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!unsubscribeLive) {
    unsubscribeLive = subscribeLive(onLive, "fast");
    onLive();
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && unsubscribeLive) {
      unsubscribeLive();
      unsubscribeLive = null;
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  };
}

const getSnapshot = (): LiveTrace => trace;
const getServerSnapshot = (): LiveTrace => EMPTY;

/** Mitschnitt des aktuellen bzw. zuletzt beobachteten Speedtests (seit dem Öffnen der Seite). */
export function useSpeedtestTrace(): LiveTrace {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
