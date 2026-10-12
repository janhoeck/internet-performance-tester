"use client";

import { useLive, type LiveState } from "@/lib/client/live-store";

/**
 * connecting – erster Verbindungsaufbau (auch Server-Render)
 * offline    – Mess-Engine bzw. Live-Stream nicht erreichbar
 * idle       – Engine erreichbar, aber kein Langzeittest
 * running    – Langzeittest läuft
 */
export type LiveMode = "connecting" | "offline" | "idle" | "running";

const selectMode = (s: LiveState): LiveMode => {
  if (!s.conn.online) return s.conn.status === "idle" || s.conn.status === "connecting" ? "connecting" : "offline";
  const sess = s.session;
  return sess && sess.status === "running" && sess.endedAt == null ? "running" : "idle";
};

export function useLiveMode(): LiveMode {
  return useLive(selectMode);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Standard-Internetziele (ICMP) für die Live-Kennzahlen */
export const INTERNET_IDS = ["cf4", "cf6", "g4", "g6"] as const;
/** Ziele im Diagramm „Latenz je Ziel“ (nah -> fern) */
export const CHART_IDS = ["gw", "isp6", "aftr", "cf4", "cf6"] as const;

/** Text für Live-Kacheln ohne Werte */
export const LIVE_HINT: Record<Exclude<LiveMode, "running">, string> = {
  connecting: "Verbindung wird aufgebaut …",
  offline: "Mess-Engine nicht erreichbar",
  idle: "Kein Langzeittest aktiv",
};
