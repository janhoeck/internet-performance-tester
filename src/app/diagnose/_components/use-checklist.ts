"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Abgehakte Empfehlungen – nur eine Bequemlichkeit pro Browser (localStorage, kann fehlen).
 * Schlüssel je Eintrag: "<befund-id>::<empfehlungstext>".
 */
const KEY = "np:diagnose:erledigt";
const EVENT = "np:checklist";
const MAX_ITEMS = 300;

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onChange);
  };
}

function parse(raw: string): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function checklistKey(findingId: string, text: string): string {
  return `${findingId}::${text}`;
}

export function useChecklist(): { done: ReadonlySet<string>; toggle: (key: string) => void } {
  const raw = useSyncExternalStore(subscribe, read, () => "");
  const done = useMemo(() => new Set(parse(raw)), [raw]);
  const toggle = useCallback((key: string) => {
    const list = parse(read());
    const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key].slice(-MAX_ITEMS);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Speicher gesperrt (privates Fenster): Haken lassen sich dann nicht merken
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { done, toggle };
}
