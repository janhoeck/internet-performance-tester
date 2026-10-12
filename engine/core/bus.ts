// Typed in-process event bus. Listener errors (sync throws and rejected promises) are caught
// and logged, so one faulty module can never break the emitter or other listeners.
import type { Bus, BusEvents, Logger } from './types';
import { errorMessage } from './util';

type Listener = (payload: unknown) => unknown;

/** Minimum time between two error log lines per event type (listener errors on 'sample' would flood). */
const ERROR_LOG_INTERVAL_MS = 10_000;

export interface EngineBus extends Bus {
  /** number of listeners for a type (diagnostics/tests) */
  listenerCount(type: keyof BusEvents): number;
  removeAll(): void;
}

export function createBus(log: Logger, now: () => number = Date.now): EngineBus {
  const listeners = new Map<keyof BusEvents, Set<Listener>>();
  const errorLog = new Map<keyof BusEvents, { lastTs: number; suppressed: number }>();

  const reportError = (type: keyof BusEvents, err: unknown) => {
    const t = now();
    const state = errorLog.get(type);
    if (state && t - state.lastTs < ERROR_LOG_INTERVAL_MS) {
      state.suppressed++;
      return;
    }
    const suppressed = state?.suppressed ?? 0;
    errorLog.set(type, { lastTs: t, suppressed: 0 });
    const more = suppressed > 0 ? ` (+${suppressed} weitere unterdrückt)` : '';
    log.error(`Fehler in einem Listener für '${type}': ${errorMessage(err)}${more}`, err instanceof Error ? err : undefined);
  };

  return {
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const listener = fn as Listener;
      set.add(listener);
      return () => {
        listeners.get(type)?.delete(listener);
      };
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set || set.size === 0) return;
      // snapshot: listeners may (un)subscribe while we iterate
      for (const fn of [...set]) {
        try {
          const result = fn(payload);
          if (result instanceof Promise) result.catch((err: unknown) => reportError(type, err));
        } catch (err) {
          reportError(type, err);
        }
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    removeAll() {
      listeners.clear();
    },
  };
}
