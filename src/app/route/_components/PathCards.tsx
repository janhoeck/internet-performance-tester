"use client";

import { Gamepad2, Ruler, Shuffle } from "lucide-react";
import { HealthBadge } from "@/components/ui/HealthBadge";
import { Panel } from "@/components/ui/Panel";
import { DataState } from "@/components/ui/States";
import type { UseApiResult } from "@/lib/client/use-api";
import { fmtDateTimeShort, fmtInt, fmtMs, NBSP } from "@/lib/format";
import type { Severity } from "@/lib/health";
import type { PathResponse } from "@/lib/shared/api-types";
import type { MtuResult, NatMapping, NatResult } from "@/lib/shared/types";

function mtuView(m: MtuResult | undefined, family: 4 | 6): { status: Severity; label: string; text: string } {
  if (!m || m.mtu === null) {
    return { status: "unknown", label: "Unbekannt", text: m?.note ?? "Noch nicht gemessen – die Mess-Engine prüft die Pfad-MTU einmal täglich." };
  }
  if (family === 4) {
    if (m.mtu >= 1460) {
      return {
        status: "good",
        label: m.mtu === 1460 ? "DS-Lite normal" : "Gut",
        text:
          m.mtu === 1460
            ? `1460${NBSP}Byte sind bei DS-Lite normal: 40${NBSP}Byte gehen für den IPv6-Tunnel zum AFTR drauf. Spiele kommen damit problemlos zurecht.`
            : "Volle Paketgröße – keine Fragmentierung.",
      };
    }
    return {
      status: "warn",
      label: "Kleiner als üblich",
      text: `Kleiner als die bei DS-Lite üblichen 1460${NBSP}Byte. Große Pakete müssen zerlegt werden oder gehen verloren – das kann Verbindungsabbrüche verursachen.`,
    };
  }
  if (m.mtu >= 1500) return { status: "good", label: "Gut", text: `Volle Paketgröße (1500${NBSP}Byte) – IPv6 läuft bei Vodafone ohne Tunnel.` };
  if (m.mtu >= 1280) {
    return { status: "info", label: "Reduziert", text: `Kleiner als 1500${NBSP}Byte, aber über dem IPv6-Minimum (1280${NBSP}Byte). Meist unkritisch.` };
  }
  return { status: "warn", label: "Zu klein", text: `Unter dem IPv6-Minimum von 1280${NBSP}Byte – das deutet auf ein Problem auf dem Pfad hin.` };
}

const MAPPING: Record<NatMapping, { status: Severity; label: string; text: string }> = {
  "endpoint-independent": {
    status: "good",
    label: "Endpunktunabhängig",
    text: "Dein Port bleibt für alle Gegenstellen gleich – der NAT-Typ gilt in Spielen meist als „offen“ bzw. „moderat“.",
  },
  "endpoint-dependent": {
    status: "warn",
    label: "Endpunktabhängig (strikt)",
    text: "Für jede Gegenstelle gibt es einen anderen Port – Spiele melden „strikter“ NAT, Peer-to-Peer-Verbindungen können scheitern.",
  },
  blocked: { status: "crit", label: "Blockiert", text: "Keine STUN-Antwort – UDP nach außen ist gestört oder gefiltert." },
  unknown: { status: "unknown", label: "Unbekannt", text: "Das NAT-Verhalten konnte nicht bestimmt werden." },
};

function MtuCard({ mtu }: { mtu: readonly MtuResult[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {([4, 6] as const).map((fam) => {
        const m = mtu.find((x) => x.family === fam);
        const v = mtuView(m, fam);
        return (
          <li key={fam}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-fg-2">IPv{fam}</p>
              <HealthBadge size="sm" status={v.status} label={v.label} />
            </div>
            <p className="mt-1 flex items-baseline gap-1.5">
              <span className="np-num text-2xl font-semibold text-fg">{m?.mtu != null ? fmtInt(m.mtu) : "–"}</span>
              <span className="np-num text-sm text-fg-3">Byte</span>
            </p>
            <p className="mt-1 text-xs text-fg-3">{v.text}</p>
            {m && (
              <p className="mt-1 text-2xs text-fg-3">
                Gemessen <span className="np-num">{fmtDateTimeShort(m.ts)}</span> zu <span className="np-num">{m.target}</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NatCard({ nat }: { nat: readonly NatResult[] }) {
  const v4 = nat.find((n) => n.family === 4);
  const v6 = nat.find((n) => n.family === 6);
  const map4 = MAPPING[v4?.mapping ?? "unknown"];
  const v6Open = v6 && v6.publicIp && v6.localAddress ? v6.localAddress.includes(v6.publicIp) : null;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-fg-2">IPv4-Mapping</p>
          <HealthBadge size="sm" status={v4 ? map4.status : "unknown"} label={v4 ? map4.label : "Noch nicht gemessen"} />
        </div>
        <p className="mt-1 text-xs text-fg-3">{v4 ? map4.text : "Die Mess-Engine prüft das NAT-Verhalten alle 30 Minuten während eines Langzeittests."}</p>
        {v4 && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-fg-3">Öffentliche IPv4</dt>
            <dd className="np-num break-all text-fg">{v4.publicIp ?? "–"}</dd>
            <dt className="text-fg-3">Geteilt</dt>
            <dd className="text-fg-2">
              {v4.cgnat === true ? "ja – DS-Lite/CGNAT (mit anderen Vodafone-Kunden geteilt)" : v4.cgnat === false ? "nein – eigene öffentliche IPv4" : "unbekannt"}
            </dd>
            {v4.mappings.map((m) => (
              <div key={m.server} className="contents">
                <dt className="np-num truncate text-fg-3" title={m.server}>
                  {m.server.split(":")[0]}
                </dt>
                <dd className="np-num break-all text-fg-2">
                  {m.mapped ?? (m.error ? `Fehler: ${m.error}` : "keine Antwort")}
                  {m.rttMs !== null && <span className="ml-2 text-fg-3">{fmtMs(m.rttMs)}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-fg-2">IPv6</p>
          <HealthBadge
            size="sm"
            status={v6 ? (v6.mapping === "blocked" ? "crit" : "good") : "unknown"}
            label={v6 ? (v6.mapping === "blocked" ? "Blockiert" : v6Open === false ? MAPPING[v6.mapping].label : "Ohne NAT") : "Noch nicht gemessen"}
          />
        </div>
        {v6 && (
          <>
            <p className="mt-1 text-xs text-fg-3">
              {v6.mapping === "blocked"
                ? "Keine STUN-Antwort über IPv6."
                : v6Open === false
                  ? "Die öffentliche IPv6 weicht von der lokalen ab – ungewöhnlich, aber für Spiele meist unkritisch."
                  : "Dein PC hat eine eigene öffentliche IPv6-Adresse – keine Adressübersetzung. Spiele mit IPv6-Unterstützung erreichen dich direkt, soweit die Firewall der Vodafone Station es erlaubt."}
            </p>
            <p className="np-num mt-1 break-all text-xs text-fg-2">{v6.publicIp ?? "–"}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** Pfad-MTU und NAT-Verhalten aus /api/path. */
export function PathCards({ path }: { path: UseApiResult<PathResponse> }) {
  const at = path.data?.nat[0]?.ts ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Ruler aria-hidden className="size-4.5 text-fiber" strokeWidth={2} />
            Pfad-MTU
          </span>
        }
        description="Größtes Paket, das ohne Zerlegung bis ins Internet kommt."
      >
        <DataState result={path} height={180}>
          {(d) => <MtuCard mtu={d.mtu} />}
        </DataState>
      </Panel>
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Shuffle aria-hidden className="size-4.5 text-fiber" strokeWidth={2} />
            NAT-Verhalten
          </span>
        }
        description={
          at !== null ? (
            <>
              STUN-Test, zuletzt <span className="np-num">{fmtDateTimeShort(at)}</span>
            </>
          ) : (
            "STUN-Test über Google und Cloudflare."
          )
        }
      >
        <DataState result={path} height={180}>
          {(d) => <NatCard nat={d.nat} />}
        </DataState>
        <div className="mt-4 rounded-[10px] bg-raised/60 p-3 ring-1 ring-inset ring-line">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <Gamepad2 aria-hidden className="size-4 text-fiber" strokeWidth={2} />
            Was bedeutet das für Spiele?
          </p>
          <p className="mt-1 text-xs text-fg-3">
            Mit DS-Lite teilst du dir die öffentliche IPv4 mit anderen Vodafone-Kunden. Portfreigaben für IPv4 sind deshalb nicht möglich.
            Für die meisten Spiele reicht das: Sie verbinden sich von dir aus zum Server. Bei Peer-to-Peer (Voice-Chat, manche Lobbys) hilft
            das endpunktunabhängige Mapping. Der NAT-Typ selbst verursacht keine Lags – er entscheidet nur, ob eine Verbindung zustande kommt. Ein überlastetes DS-Lite-Gateway zeigt sich dagegen als höhere IPv4-Latenz im Verlauf. Über
            IPv6 gibt es gar keine Adressübersetzung.
          </p>
        </div>
      </Panel>
    </div>
  );
}
