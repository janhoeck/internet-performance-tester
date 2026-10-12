import { useMemo, type ReactNode } from "react";
import { CloudOff, LoaderCircle, RefreshCw, SearchX, type LucideIcon } from "lucide-react";
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

/* -------------------------------------------------------------------------- */
/* Fehler: Ursache + was tun. onRetry nur aus Client-Komponenten (Funktion).   */
/* -------------------------------------------------------------------------- */
interface ErrorStateProps {
  title?: string;
  /** deutsche Fehlermeldung, z. B. aus useApi().error.message */
  message?: ReactNode;
  onRetry?: () => void;
  icon?: LucideIcon;
  className?: string;
}

export function ErrorState({ title = "Daten konnten nicht geladen werden", message, onRetry, icon: Icon = CloudOff, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)}>
      <span className="grid size-12 place-items-center rounded-full border border-dashed border-crit/50 text-crit">
        <Icon aria-hidden className="size-5" strokeWidth={1.75} />
      </span>
      <div className="max-w-sm">
        <p className="font-display text-lg font-medium text-fg">{title}</p>
        {message && <div className="mt-1 text-sm text-fg-3">{message}</div>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs font-medium text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
        >
          <RefreshCw aria-hidden className="size-3.5" strokeWidth={2} />
          Erneut versuchen
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* DataState: Lade-/Fehler-/Leerzustand für ein useApi()-Ergebnis              */
/* -------------------------------------------------------------------------- */
export interface DataStateResult<T> {
  data: T | null;
  error: { message: string } | null;
  loading: boolean;
  stale?: boolean;
  reload?: () => void;
}

interface DataStateProps<T> {
  /** Ergebnis von useApi<T>() */
  result: DataStateResult<T>;
  /** Daten da, aber nichts darzustellen? -> Leerzustand */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyText?: ReactNode;
  emptyIcon?: LucideIcon;
  /** eigener Leerzustand (ersetzt emptyTitle/emptyText) */
  empty?: ReactNode;
  /** Platzhalter beim ersten Laden (Standard: <ChartSkeleton height={height}/>) */
  skeleton?: ReactNode;
  /** Höhe für Standard-Platzhalter (px) – gleich der Diagrammhöhe wählen: kein Layoutsprung */
  height?: number;
  /**
   * Nur dimmen, wenn sich dieser Schlüssel geändert hat (z. B. `range.rangeKey` aus useTimeRange):
   * Nachladen im Intervall bzw. weiterrückende gleitende Zeiträume dimmen dann nicht.
   * Ohne Angabe wird bei jedem Nachladen gedimmt.
   */
  dimKey?: string | null;
  children: (data: T) => ReactNode;
}

/** Merkt sich den dimKey der zuletzt frisch geladenen Daten (je DataState-Instanz). */
function createDimTracker() {
  let shownKey: string | null | undefined;
  return (stale: boolean, dimKey: string | null | undefined): boolean => {
    if (dimKey === undefined) return stale;
    if (!stale || shownKey === undefined) {
      if (!stale) shownKey = dimKey;
      return false;
    }
    return shownKey !== dimKey;
  };
}

/**
 * Erstes Laden -> Skeleton · Fehler ohne Daten -> ErrorState (mit "Erneut versuchen") ·
 * leer -> EmptyState · sonst Inhalt; beim Nachladen bleibt das alte Bild gedimmt stehen.
 * Nur in Client-Komponenten (children ist eine Funktion).
 */
export function DataState<T>({
  result,
  isEmpty,
  emptyTitle = "Keine Daten im Zeitraum",
  emptyText,
  emptyIcon,
  empty,
  skeleton,
  height = 240,
  dimKey,
  children,
}: DataStateProps<T>) {
  const { data, error, loading, stale } = result;
  const dimTracker = useMemo(() => createDimTracker(), []);
  const dim = dimTracker(Boolean(stale) && data != null, dimKey);
  const box = { minHeight: height };
  if (data == null) {
    if (error) {
      return (
        <div className="grid place-items-center" style={box}>
          <ErrorState message={error.message} onRetry={result.reload} />
        </div>
      );
    }
    if (loading) return <>{skeleton ?? <ChartSkeleton height={height} />}</>;
    return (
      <div className="grid place-items-center" style={box}>
        {empty ?? (
          <EmptyState icon={emptyIcon} title={emptyTitle}>
            {emptyText}
          </EmptyState>
        )}
      </div>
    );
  }
  if (isEmpty?.(data)) {
    return (
      <div className="grid place-items-center" style={box}>
        {empty ?? (
          <EmptyState icon={emptyIcon} title={emptyTitle}>
            {emptyText}
          </EmptyState>
        )}
      </div>
    );
  }
  return (
    <Refetching active={dim}>
      {children(data)}
      {error && <p className="mt-2 text-xs text-warn">Aktualisierung fehlgeschlagen: {error.message} Angezeigt werden die zuletzt geladenen Daten.</p>}
    </Refetching>
  );
}
