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
