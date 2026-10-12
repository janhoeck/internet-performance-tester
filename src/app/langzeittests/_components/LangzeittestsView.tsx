"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChartSpline, FileText, FlaskConical, Search, SearchX, Stethoscope, Trash2, type LucideIcon } from "lucide-react";
import { matchesSessionQuery, type SessionOverview, type SessionOverviewResponse } from "@/lib/shared/sessions";
import { useApi } from "@/lib/client/use-api";
import { secondsBreakdown } from "@/lib/client/charts";
import { SESSION_STATUS_LABEL, sessionHref, sessionName } from "@/lib/client/sessions";
import { DASH, fmtDateTimeShort, fmtDuration, fmtDurationMs, fmtInt, fmtLinkSpeed, fmtPct, fmtTimeRange } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { DataState, EmptyState } from "@/components/ui/States";
import { DeleteSessionDialog } from "./DeleteSessionDialog";

export function LangzeittestsView() {
  const overview = useApi<SessionOverviewResponse>("/api/sessions/overview", { refreshMs: 60_000 });
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<SessionOverview | null>(null);

  const items = useMemo(() => overview.data?.items ?? [], [overview.data]);
  const shown = useMemo(() => items.filter((it) => matchesSessionQuery(it.session, query)), [items, query]);
  const running = items.filter((it) => it.running).length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Langzeittests"
        description="Alle Langzeittests nach Namen. Öffne einen Test als Bericht, Diagnose oder Verlauf – oder lösche Tests, die du nicht mehr brauchst."
        actions={
          <label className="relative block w-72 max-w-full">
            <span className="sr-only">Langzeittest nach Namen suchen</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" strokeWidth={2} />
            <TextInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name suchen …" className="pl-9" />
          </label>
        }
        className="mb-0"
      />

      <DataState
        result={overview}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState icon={FlaskConical} title="Noch kein Langzeittest">
            Starte einen Langzeittest über die Statusleiste – am besten 48 bis 72 Stunden, damit auch die Abende dabei sind. Gib ihm einen Namen, z. B. „Neues
            LAN-Kabel“, dann findest du ihn hier wieder.
          </EmptyState>
        }
        height={320}
      >
        {() => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-3" aria-live="polite">
              {query.trim()
                ? `${fmtInt(shown.length)} von ${fmtInt(items.length)} Langzeittests passen zu „${query.trim()}“.`
                : `${fmtInt(items.length)} ${items.length === 1 ? "Langzeittest" : "Langzeittests"}${running > 0 ? `, davon ${fmtInt(running)} laufend` : ""} – neueste zuerst.`}
            </p>
            {shown.length === 0 ? (
              <EmptyState icon={SearchX} title="Kein Test mit diesem Namen" action={<Button onClick={() => setQuery("")}>Suche zurücksetzen</Button>}>
                Gesucht wird in Name und Notiz der Tests.
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {shown.map((it) => (
                  <li key={it.session.id}>
                    <SessionCard item={it} onDelete={() => setDeleting(it)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DataState>

      {deleting && <DeleteSessionDialog item={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const LINK_BTN =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber";

function ActionLink({ href, icon: Icon, primary, children }: { href: string; icon: LucideIcon; primary?: boolean; children: string }) {
  return (
    <Link
      href={href}
      className={cn(
        LINK_BTN,
        primary
          ? "bg-fiber-strong text-fg-invert hover:bg-fiber"
          : "bg-raised text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay hover:ring-line-control",
      )}
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={2} />
      {children}
    </Link>
  );
}

function StatusChip({ item }: { item: SessionOverview }) {
  const s = item.session;
  if (item.running) {
    return (
      <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-fiber/12 px-2 text-2xs font-medium text-fiber ring-1 ring-inset ring-fiber/40">
        <span aria-hidden className="np-live-dot" />
        läuft
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-2xs font-medium ring-1 ring-inset",
        s.status === "aborted" ? "bg-warn/10 text-warn ring-warn/35" : "bg-raised text-fg-3 ring-line-strong",
      )}
    >
      {SESSION_STATUS_LABEL[s.status]}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium text-fg-3">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

function connectionText(it: SessionOverview): string {
  const c = it.context;
  if (!c) return DASH;
  const kind = c.isWifi ? `WLAN${c.ssid ? ` „${c.ssid}“` : ""}` : (c.primaryAdapter ?? "LAN");
  return c.linkMbps != null ? `${kind}, ${fmtLinkSpeed(c.linkMbps)}` : kind;
}

function SessionCard({ item, onDelete }: { item: SessionOverview; onDelete: () => void }) {
  const s = item.session;
  const name = sessionName(s);
  const span = item.to - item.from;
  const b = secondsBreakdown(item.seconds);
  const coverage = span > 0 && item.seconds ? Math.min(100, ((item.seconds.covered * 1000) / span) * 100) : null;
  const titleId = `np-session-${s.id}`;

  return (
    <article aria-labelledby={titleId} className="np-panel flex flex-col gap-4 px-5 py-4">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className={cn("text-lg font-medium", s.label?.trim() ? "text-fg" : "text-fg-2")}>
              {name}
            </h2>
            <StatusChip item={item} />
          </div>
          <p className="np-num mt-0.5 text-xs text-fg-3">
            {item.running ? `seit ${fmtDateTimeShort(s.startedAt)}` : fmtTimeRange(item.from, item.to)} · {item.running ? "läuft seit " : ""}
            {fmtDurationMs(span)}
            {item.running && s.plannedEndAt != null && ` · geplant bis ${fmtDateTimeShort(s.plannedEndAt)}`}
          </p>
          {s.note && <p className="mt-1 text-sm text-fg-2">{s.note}</p>}
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 xl:grid-cols-7">
        <Fact label="Verbindung beim Start">{connectionText(item)}</Fact>
        <Fact label="Gemessen">
          <span className="np-num">
            {item.seconds ? fmtDuration(item.seconds.covered) : DASH}
            {coverage != null && <span className="text-fg-3"> ({fmtPct(coverage)})</span>}
          </span>
        </Fact>
        <Fact label="Gestörte Sekunden">
          <span className={cn("np-num", b.badPct != null && b.badPct >= 1 && "text-warn")}>{b.badPct != null ? fmtPct(b.badPct) : DASH}</span>
        </Fact>
        <Fact label="Meist gestört in">{b.top ? b.top.label : b.covered > 0 ? "nirgends" : DASH}</Fact>
        <Fact label="Ausfälle">
          <span className="np-num">{fmtInt(item.outages)}</span>
        </Fact>
        <Fact label="Lag-Markierungen">
          <span className="np-num">{fmtInt(item.notes)}</span>
        </Fact>
        <Fact label="Speedtests">
          <span className="np-num">{fmtInt(item.speedtests)}</span>
        </Fact>
      </dl>

      {b.bad > 0 && (
        <div
          className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
          role="img"
          aria-label={`Gestörte Sekunden nach Abschnitt: ${b.items.map((x) => `${x.label} ${fmtPct(x.share)}`).join(", ")}`}
          title={b.items.map((x) => `${x.label}: ${fmtPct(x.share)}`).join(" · ")}
        >
          {b.items.map((x) => (
            <span key={x.id} className="h-full" style={{ width: `${x.share}%`, minWidth: 3, backgroundColor: x.color }} />
          ))}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2">
        <ActionLink href={sessionHref("/bericht", s.id)} icon={FileText} primary>
          Bericht
        </ActionLink>
        <ActionLink href={sessionHref("/diagnose", s.id)} icon={Stethoscope}>
          Diagnose
        </ActionLink>
        <ActionLink href={sessionHref("/verlauf", s.id)} icon={ChartSpline}>
          Verlauf
        </ActionLink>
        <span className="ml-auto">
          {item.running ? (
            <span className="text-xs text-fg-3">Läuft gerade – löschen erst nach dem Ende möglich.</span>
          ) : (
            <Button size="sm" variant="danger" icon={Trash2} onClick={onDelete} aria-label={`${name} löschen`}>
              Löschen
            </Button>
          )}
        </span>
      </footer>
    </article>
  );
}
