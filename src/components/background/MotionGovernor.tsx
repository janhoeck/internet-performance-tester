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
