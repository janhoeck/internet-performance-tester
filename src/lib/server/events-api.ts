// Parameter/body schemas for /api/events.
import { z } from 'zod';
import type { EventSource, EventType, Segment, Severity } from '../shared/types';
import { zInt, zList, zTs } from './params';

const EVENT_TYPE_MAP: Record<EventType, true> = {
  nic_link_down: true,
  nic_link_up: true,
  adapter_change: true,
  route_switch: true,
  standby: true,
  resume: true,
  engine_gap: true,
  outage: true,
  loss_burst: true,
  latency_spike: true,
  route_change: true,
  speedtest: true,
  router_reboot: true,
  router_offline: true,
  router_log: true,
  docsis_change: true,
  router_login: true,
  wlan_connect: true,
  wlan_disconnect: true,
  wlan_roam: true,
  ip_change: true,
  identity_change: true,
  gaming: true,
  vpn_change: true,
  mtu_change: true,
  nat_change: true,
  session_start: true,
  session_end: true,
  config_change: true,
  note: true,
};
export const EVENT_TYPES = Object.keys(EVENT_TYPE_MAP) as EventType[];

const SEVERITY_MAP: Record<Severity, true> = { info: true, warn: true, critical: true };
const SEGMENT_MAP: Record<Segment, true> = { client: true, lan: true, router: true, docsis: true, aftr: true, isp: true, internet: true, game: true };
const SOURCE_MAP: Record<EventSource, true> = {
  engine: true, icmp: true, tcp: true, udp: true, eventlog: true, adapter: true, wlan: true, route: true, vpn: true,
  system: true, router: true, traceroute: true, speedtest: true, stun: true, mtu: true, user: true,
};

const oneOf = (map: Record<string, true>) => new RegExp(`^(${Object.keys(map).join('|')})$`);

export const eventsQuerySchema = z.object({
  from: zTs,
  to: zTs,
  types: zList(oneOf(EVENT_TYPE_MAP), 40, 'Ereignistyp'),
  severity: zList(oneOf(SEVERITY_MAP), 3, 'Schweregrad'),
  segment: zList(oneOf(SEGMENT_MAP), 8, 'Abschnitt'),
  source: zList(oneOf(SOURCE_MAP), 16, 'Quelle'),
  limit: zInt(1, 5000),
  offset: zInt(0, 10_000_000),
});

export const MAX_NOTE_DETAILS_BYTES = 16 * 1024;

/** POST /api/events body: user note ("Lag jetzt markieren"). */
export const noteBodySchema = z.object({
  title: z.string().trim().min(1, 'Titel fehlt').max(200),
  ts: z.number().int().min(0).max(9_999_999_999_999).optional(),
  details: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .refine((d) => d === undefined || d === null || JSON.stringify(d).length <= MAX_NOTE_DETAILS_BYTES, {
      message: `Details sind zu groß (max. ${MAX_NOTE_DETAILS_BYTES / 1024} KB)`,
    }),
});
