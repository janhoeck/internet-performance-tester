"use client";

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Inbox, Search, X } from "lucide-react";
import type { EventsResponse } from "@/lib/shared/api-types";
import type { Segment, Severity } from "@/lib/shared/types";
import { useApi } from "@/lib/client/use-api";
import { useTimeRange } from "@/lib/client/use-time-range";
import { useTargets } from "@/lib/client/targets";
import { toTimelineEvent } from "@/lib/client/adapters";
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TEXT, severityToUi } from "@/lib/health";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/cn";
import { fmtInt } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { ChartSkeleton, EmptyState, ErrorState, Refetching, Skeleton } from "@/components/ui/States";
import { TimeRangePicker } from "@/components/ui/TimeRangePicker";
import { EventStrip } from "@/components/viz/EventStrip";
import { Segmented } from "@/app/verlauf/_components/Segmented";
import { EngineHint, NoSessionState, useEngineOffline } from "@/app/verlauf/_components/states";
import { ALL_GROUP_IDS, EVENT_GROUPS, SEGMENT_ORDER, SEVERITY_ORDER, matchesSearch, typesForGroups, type EventGroupId } from "./event-groups";
import { EventList } from "./EventList";
import { NoteForm } from "./NoteForm";

const PAGE_SIZE = 100;
/** Mit Textsuche wird clientseitig gefiltert: höchstens so viele neueste Ereignisse laden (API-Grenze). */
const SEARCH_LIMIT = 5000;
const PRESETS = ["24h", "7d", "30d", "session"] as const;
const STRIP_OPTIONS = [
  { value: "24h", label: "24 h", title: "Letzte 24 Stunden" },
  { value: "7d", label: "7 T", title: "Letzte 7 Tage" },
] as const;
const H = 3_600_000;

interface Filters {
  groups: ReadonlySet<EventGroupId>;
  severities: ReadonlySet<Severity>;
  segment: Segment | "";
}

function filterParams(f: Filters): string {
  const p: string[] = [];
  const types = typesForGroups(f.groups);
  if (types) p.push(`types=${types.join(",")}`);
  if (f.severities.size < SEVERITY_ORDER.length) p.push(`severity=${SEVERITY_ORDER.filter((s) => f.severities.has(s)).join(",")}`);
  if (f.segment) p.push(`segment=${f.segment}`);
  return p.join("&");
}

export function EreignisseView() {
  const range = useTimeRange({ defaultPreset: "7d" });
  const info = useTargets();
  const offline = useEngineOffline();
  const now = useNow(60_000);

  const [groups, setGroups] = useState<ReadonlySet<EventGroupId>>(() => new Set(ALL_GROUP_IDS));
  const [severities, setSeverities] = useState<ReadonlySet<Severity>>(() => new Set(SEVERITY_ORDER));
  const [segment, setSegment] = useState<Segment | "">("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const searching = deferredSearch.length > 0;
  const [strip, setStrip] = useState<"24h" | "7d">("24h");

  const filters = useMemo<Filters>(() => ({ groups, severities, segment }), [groups, severities, segment]);
  const fp = filterParams(filters);
  const nothingSelected = groups.size === 0 || severities.size === 0;

  // Seite zurücksetzen, sobald sich Filter/Zeitraum ändern (Schlüssel statt Effekt)
  const pageKey = `${fp}|${range.preset}|${range.preset === "custom" ? `${range.from}-${range.to}` : ""}|${range.session?.id ?? ""}|${deferredSearch}`;
  const [page, setPage] = useState<{ key: string; offset: number }>({ key: pageKey, offset: 0 });
  const offset = page.key === pageKey ? page.offset : 0;
  const goTo = (o: number) => {
    setPage({ key: pageKey, offset: Math.max(0, o) });
    document.getElementById("np-ev-timeline")?.scrollIntoView({ block: "start" });
  };

  const listUrl =
    range.query && !nothingSelected
      ? `/api/events?${range.query}${fp ? `&${fp}` : ""}&limit=${searching ? SEARCH_LIMIT : PAGE_SIZE}&offset=${searching ? 0 : offset}`
      : null;
  const list = useApi<EventsResponse>(listUrl, { refreshMs: searching ? 120_000 : 30_000 });

  // Überblick rückt bei 24 h jede Minute, bei 7 T alle 5 min weiter (jede neue URL lädt neu)
  const stripNow = useNow(strip === "24h" ? 60_000 : 5 * 60_000);
  const stripFrom = stripNow != null ? stripNow - (strip === "24h" ? 24 * H : 7 * 24 * H) : null;
  const stripUrl =
    stripNow != null && stripFrom != null && !nothingSelected ? `/api/events?from=${stripFrom}&to=${stripNow}${fp ? `&${fp}` : ""}&limit=${SEARCH_LIMIT}` : null;
  const stripRes = useApi<EventsResponse>(stripUrl);

  const view = useMemo(() => {
    const events = list.data?.events ?? [];
    if (!searching) return { events, total: list.data?.total ?? 0, capped: false };
    const hits = events.filter((e) => matchesSearch(e, deferredSearch));
    return { events: hits.slice(offset, offset + PAGE_SIZE), total: hits.length, capped: (list.data?.total ?? 0) > events.length };
  }, [list.data, searching, deferredSearch, offset]);

  const stripEvents = useMemo(() => {
    const ev = stripRes.data?.events ?? [];
    return (searching ? ev.filter((e) => matchesSearch(e, deferredSearch)) : ev).map(toTimelineEvent);
  }, [stripRes.data, searching, deferredSearch]);

  const toggleGroup = (id: EventGroupId) =>
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSeverity = (s: Severity) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const resetFilters = () => {
    setGroups(new Set(ALL_GROUP_IDS));
    setSeverities(new Set(SEVERITY_ORDER));
    setSegment("");
    setSearch("");
  };
  const filtered = groups.size < ALL_GROUP_IDS.length || severities.size < SEVERITY_ORDER.length || segment !== "" || search.trim() !== "";

  const exportHref = range.query ? `/api/export?kind=events&format=csv&${range.query}` : null;

  return (
    <>
      <PageHeader
        title="Ereignisse"
        description="Alles, was auf der Leitung passiert ist: Link-Abbrüche, Ausfälle, Ping-Spitzen, Router-Meldungen, Speedtests und deine Notizen."
        actions={
          <>
            <TimeRangePicker range={range} presets={PRESETS} />
            {exportHref ? (
              <a
                href={exportHref}
                download
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs font-medium text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber"
              >
                <Download aria-hidden className="size-3.5" strokeWidth={2} />
                CSV exportieren
              </a>
            ) : (
              <Button size="sm" icon={Download} disabled>
                CSV exportieren
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Panel
          title="Überblick"
          description="Ein Strich je Ereignis, Breite = Dauer. Häufungen fallen hier sofort auf. Die Filter unten gelten auch hier."
          actions={<Segmented label="Zeitfenster des Überblicks" options={STRIP_OPTIONS} value={strip} onChange={setStrip} />}
        >
          {stripRes.data == null && stripRes.error ? (
            <ErrorState message={stripRes.error.message} onRetry={stripRes.reload} />
          ) : stripRes.data == null || stripNow == null || stripFrom == null ? (
            nothingSelected ? (
              <p className="text-sm text-fg-3">Kein Filter aktiv – wähle mindestens eine Gruppe und einen Schweregrad.</p>
            ) : (
              <ChartSkeleton height={160} />
            )
          ) : (
            <Refetching active={stripRes.stale}>
              <EventStrip events={stripEvents} from={new Date(stripFrom).toISOString()} to={new Date(stripNow).toISOString()} />
              {stripEvents.length === 0 && <p className="mt-2 text-xs text-fg-3">Keine passenden Ereignisse in diesem Zeitfenster.</p>}
            </Refetching>
          )}
        </Panel>

        <Panel title="Filter" bodyClassName="flex flex-col gap-4">
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs font-medium text-fg-2">Typ</legend>
            <div className="flex flex-wrap gap-1.5">
              {EVENT_GROUPS.map((g) => (
                <FilterChip key={g.id} pressed={groups.has(g.id)} onClick={() => toggleGroup(g.id)} title={g.hint}>
                  {g.label}
                </FilterChip>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)] md:items-end">
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-xs font-medium text-fg-2">Schweregrad</legend>
              <div className="flex flex-wrap gap-1.5">
                {SEVERITY_ORDER.map((s) => {
                  const ui = severityToUi(s);
                  const Icon = HEALTH_ICON[ui];
                  return (
                    <FilterChip key={s} pressed={severities.has(s)} onClick={() => toggleSeverity(s)}>
                      <Icon aria-hidden className={cn("size-3.5", HEALTH_TEXT[ui])} strokeWidth={2.25} />
                      {HEALTH_LABEL[ui]}
                    </FilterChip>
                  );
                })}
              </div>
            </fieldset>
            <Field label="Abschnitt" htmlFor="np-ev-segment">
              <Select id="np-ev-segment" value={segment} onChange={(e) => setSegment(e.target.value as Segment | "")}>
                <option value="">Alle Abschnitte</option>
                {SEGMENT_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {SHARED_SEGMENT_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Suche" htmlFor="np-ev-search">
              <span className="relative block">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-4" strokeWidth={2} />
                <TextInput
                  id="np-ev-search"
                  type="search"
                  value={search}
                  placeholder="z. B. 100 Mbit, WLAN, Kopfstation"
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </span>
            </Field>
          </div>
          {filtered && (
            <div>
              <Button size="sm" variant="ghost" icon={X} onClick={resetFilters}>
                Filter zurücksetzen
              </Button>
            </div>
          )}
        </Panel>

        <div id="np-ev-timeline" className="grid scroll-mt-16 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel
            title="Zeitleiste"
            description={
              list.data ? (
                <span className="np-num">
                  {view.total === 0
                    ? "Keine Ereignisse"
                    : `${fmtInt(offset + 1)}–${fmtInt(Math.min(offset + PAGE_SIZE, view.total))} von ${fmtInt(view.total)} Ereignissen`}
                </span>
              ) : (
                range.label
              )
            }
          >
            {range.noSession ? (
              <NoSessionState />
            ) : nothingSelected ? (
              <EmptyState icon={Inbox} title="Kein Filter aktiv">
                Wähle mindestens eine Gruppe und einen Schweregrad aus.
              </EmptyState>
            ) : list.data == null && list.error ? (
              <ErrorState message={list.error.message} onRetry={list.reload} />
            ) : list.data == null ? (
              <TimelineSkeleton />
            ) : view.events.length === 0 ? (
              <EmptyState icon={Inbox} title="Keine Ereignisse in diesem Zeitraum">
                {filtered ? "Passe die Filter an oder wähle einen längeren Zeitraum." : <EngineHint offline={offline} />}
              </EmptyState>
            ) : (
              <Refetching active={list.stale}>
                {searching && view.capped && (
                  <p className="mb-3 text-xs text-fg-3">
                    Die Suche durchsucht die neuesten <span className="np-num">{fmtInt(SEARCH_LIMIT)}</span> Ereignisse im Zeitraum. Grenze den Zeitraum ein, um ältere zu finden.
                  </p>
                )}
                <EventList events={view.events} targets={info.targets} now={now} stickyOffset={56} />
                <Pager offset={offset} total={view.total} onChange={goTo} />
                {list.error && <p className="mt-2 text-xs text-warn">Aktualisierung fehlgeschlagen: {list.error.message}</p>}
              </Refetching>
            )}
          </Panel>
          <div className="xl:sticky xl:top-[72px]">
            <NoteForm />
          </div>
        </div>
      </div>
    </>
  );
}

function FilterChip({ pressed, onClick, title, children }: { pressed: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1 ring-inset transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber",
        pressed ? "bg-fiber/12 text-fg ring-fiber/60" : "text-fg-3 ring-line hover:bg-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Pager({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  const pageNo = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.ceil(total / PAGE_SIZE);
  return (
    <nav aria-label="Seiten der Zeitleiste" className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <Button size="sm" icon={ChevronLeft} disabled={offset === 0} onClick={() => onChange(offset - PAGE_SIZE)}>
        Neuere
      </Button>
      <span className="np-num text-xs text-fg-3">
        Seite {pageNo} von {pages}
      </span>
      <Button size="sm" iconRight={ChevronRight} disabled={offset + PAGE_SIZE >= total} onClick={() => onChange(offset + PAGE_SIZE)}>
        Ältere
      </Button>
    </nav>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Ereignisse werden geladen">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="grid grid-cols-[4.75rem_1.5rem_minmax(0,1fr)] gap-x-3">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="size-6 rounded-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
