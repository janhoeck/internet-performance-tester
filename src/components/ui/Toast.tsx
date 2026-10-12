"use client";

import { useSyncExternalStore } from "react";
import { CircleCheck, Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Kurze Bestätigungen ("Lag markiert – 18:42:13", "Speedtest gestartet"). Überall aufrufbar:
 *
 *   import { toast } from "@/components/ui/Toast";
 *   toast({ title: "Speedtest gestartet" });
 *   toast({ title: "Speichern fehlgeschlagen", description: err, tone: "error" });
 *
 * <Toaster/> steckt einmal im AppShell (höfliche Live-Region, keine Unterbrechung des Screenreaders).
 */
export type ToastTone = "success" | "info" | "warn" | "error";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Anzeigedauer in ms (Standard 5 s, Fehler 8 s); 0 = bis zum Schließen */
  durationMs?: number;
}

interface ToastItem extends Required<Omit<ToastInput, "description">> {
  id: number;
  description?: string;
}

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const MAX_VISIBLE = 4;

function emit(): void {
  for (const l of [...listeners]) l();
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  const next = items.filter((x) => x.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

/** Zeigt eine Meldung unten rechts; gibt die ID zurück (für dismissToast). */
export function toast(input: ToastInput): number {
  const tone = input.tone ?? "success";
  const item: ToastItem = {
    id: nextId++,
    title: input.title,
    description: input.description,
    tone,
    durationMs: input.durationMs ?? (tone === "error" ? 8000 : 5000),
  };
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  if (item.durationMs > 0 && typeof window !== "undefined") {
    timers.set(
      item.id,
      setTimeout(() => dismissToast(item.id), item.durationMs),
    );
  }
  return item.id;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const getItems = () => items;
const EMPTY: readonly ToastItem[] = [];
const getServerItems = () => EMPTY;

const TONE: Record<ToastTone, { icon: LucideIcon; text: string; rail: string }> = {
  success: { icon: CircleCheck, text: "text-good", rail: "bg-good" },
  info: { icon: Info, text: "text-info", rail: "bg-info" },
  warn: { icon: TriangleAlert, text: "text-warn", rail: "bg-warn" },
  error: { icon: OctagonAlert, text: "text-crit", rail: "bg-crit" },
};

/** Ausgabe-Bereich für toast(); einmal im Layout einhängen. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, getItems, getServerItems);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 print:hidden"
    >
      {list.map((t) => {
        const tone = TONE[t.tone];
        const Icon = tone.icon;
        return (
          <div key={t.id} className="np-toast pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border border-line-strong bg-overlay py-3 pl-4 pr-2 shadow-overlay">
            <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", tone.rail)} />
            <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone.text)} strokeWidth={2.25} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium tabular-nums text-fg">{t.title}</p>
              {t.description && <p className="mt-0.5 text-xs text-fg-3">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="Meldung schließen"
              className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-fiber"
            >
              <X aria-hidden className="size-3.5" strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
