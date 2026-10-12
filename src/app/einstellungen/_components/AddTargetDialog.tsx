"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ChoiceGroup, Field, Select, TextInput } from "@/components/ui/Field";
import { SHARED_SEGMENT_LABEL } from "@/lib/segments";
import { targetSchema } from "@/lib/shared/config";
import { ipFamily } from "@/lib/shared/net";
import type { IpFamily, ProbeKind, Segment, TargetConfig } from "@/lib/shared/types";
import { NumField } from "./controls";
import { KIND_DEFAULT_PORT, SEGMENT_ORDER, issueFromZod, makeTargetId, type Issue } from "./draft";

interface AddTargetDialogProps {
  existingIds: readonly string[];
  onAdd: (t: TargetConfig) => void;
  onClose: () => void;
}

const KINDS = [
  { value: "icmp", label: "Ping (ICMP)", hint: "wie ping.exe" },
  { value: "tcp", label: "TCP", hint: "Verbindungsaufbau" },
  { value: "udp-dns", label: "UDP (DNS)", hint: "nur DNS-Server" },
  { value: "http", label: "HTTP", hint: "Antwortzeit" },
] as const;

const FAMILIES = [
  { value: "4", label: "IPv4", hint: "über DS-Lite (AFTR)" },
  { value: "6", label: "IPv6", hint: "nativ" },
] as const;

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/** Neues eigenes Messziel (wird erst mit „Speichern“ der Seite übernommen). */
export function AddTargetDialog({ existingIds, onAdd, onClose }: AddTargetDialogProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<ProbeKind>("icmp");
  const [port, setPort] = useState<number | null>(null);
  const [family, setFamily] = useState<IpFamily>(4);
  const [segment, setSegment] = useState<Segment>("game");
  const [intervalMs, setIntervalMs] = useState<number | null>(1000);
  const [submitted, setSubmitted] = useState(false);

  const effectivePort = kind === "icmp" ? undefined : (port ?? KIND_DEFAULT_PORT[kind]);

  const candidate: TargetConfig = useMemo(
    () => ({
      id: makeTargetId(name.trim(), existingIds),
      name: name.trim(),
      host: host.trim(),
      family,
      kind,
      ...(effectivePort !== undefined ? { port: effectivePort } : {}),
      ...(kind === "udp-dns" ? { query: "cloudflare.com" } : {}),
      segment,
      intervalMs: intervalMs ?? Number.NaN,
      timeoutMs: kind === "icmp" ? 2000 : 3000,
      enabled: true,
      builtin: false,
    }),
    [name, host, family, kind, effectivePort, segment, intervalMs, existingIds],
  );

  const issues = useMemo(() => {
    const map: Record<string, Issue> = {};
    const res = targetSchema.safeParse(candidate);
    if (!res.success) for (const i of res.error.issues) map[String(i.path[0] ?? "")] ??= issueFromZod(i);
    const h = candidate.host;
    if (h) {
      const fam = ipFamily(h.split("%")[0]);
      if (fam === null && !HOST_RE.test(h)) map.host = { message: "Bitte eine IP-Adresse oder einen Hostnamen eingeben (ohne http://)." };
      else if (fam !== null && fam !== family) map.host = { message: `Das ist eine IPv${fam}-Adresse – wähle unten IPv${fam}.` };
    }
    if (kind === "icmp" && Number.isFinite(candidate.intervalMs) && candidate.intervalMs < 1000) {
      map.intervalMs = { message: "", bound: { kind: "min", value: 1000, inclusive: true } };
    }
    return map;
  }, [candidate, family, kind]);

  const valid = Object.keys(issues).length === 0;
  const show = (k: string) => (submitted || k === "host" ? issues[k] : undefined);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
    if (valid) onAdd(candidate);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Eigenes Messziel hinzufügen"
      description="Zum Beispiel die IP-Adresse deines Spieleservers. Das Ziel wird mit „Speichern“ übernommen."
      size="lg"
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" icon={Plus}>
            Ziel hinzufügen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="nt-name" error={show("name") ? "Bitte einen Namen eingeben." : undefined} hint="z. B. „CS2 Frankfurt“">
            <TextInput id="nt-name" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-invalid={show("name") ? true : undefined} />
          </Field>
          <Field label="Host oder IP-Adresse" htmlFor="nt-host" error={host.trim() || submitted ? show("host")?.message : undefined} hint="IPv4, IPv6 oder Hostname">
            <TextInput
              id="nt-host"
              value={host}
              spellCheck={false}
              autoComplete="off"
              className="np-num"
              onChange={(e) => setHost(e.target.value)}
              aria-invalid={show("host") ? true : undefined}
            />
          </Field>
        </div>
        <ChoiceGroup name="nt-kind" legend="Methode" options={KINDS} value={kind} onChange={(v) => setKind(v)} columns={4} />
        <div className="grid gap-4 sm:grid-cols-3">
          {kind !== "icmp" && (
            <NumField
              id="nt-port"
              label="Port"
              step={1}
              nullable
              value={port}
              placeholder={String(KIND_DEFAULT_PORT[kind] ?? "")}
              onChange={setPort}
              hint={`Leer = ${KIND_DEFAULT_PORT[kind]}`}
              issue={show("port")}
            />
          )}
          <NumField
            id="nt-interval"
            label="Intervall"
            unit="s"
            scale={1000}
            value={intervalMs}
            onChange={setIntervalMs}
            hint={kind === "icmp" ? "Mindestens 1 s" : "Empfohlen 5–10 s"}
            issue={show("intervalMs")}
          />
          <Field label="Abschnitt" htmlFor="nt-segment" hint="Wo liegt das Ziel auf dem Leitungsweg?">
            <Select id="nt-segment" value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
              {SEGMENT_ORDER.map((s) => (
                <option key={s} value={s}>
                  {SHARED_SEGMENT_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ChoiceGroup
          name="nt-family"
          legend="Protokoll"
          options={FAMILIES}
          value={String(family) as "4" | "6"}
          onChange={(v) => setFamily(v === "6" ? 6 : 4)}
          columns={2}
        />
      </div>
    </Dialog>
  );
}
