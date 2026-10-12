// Pure per-second segment classification (docs/ARCHITECTURE.md §4.6, critique.md §5.2,
// MESSPLAN §2). First match wins:
//   excluded → link → lan → good → access → aftr → backbone → remote → unknown
import type { AppConfig } from '../../src/lib/shared/config';
import type { ClientState, SecondClass, SecondsRollup } from '../../src/lib/shared/types';

/** RTT from which a second counts as severely errored (the user's complaint: "Ping > 200 ms"). */
export const SES_RTT_MS = 200;

/** Result of one reference probe in the evaluated second. */
export interface MemberResult {
  targetId: string;
  lost: boolean;
  spike: boolean;
  rtt: number | null;
}

/** 'none' = no sample of any member in this second (group unknown, neither good nor bad) */
export type GroupState = 'ok' | 'bad' | 'none';

export interface SecondInput {
  ts: number;
  /** no pinger heartbeat, engine gap or speed test running → not counted */
  excluded: boolean;
  /** expected link down, traffic on another interface (failover) or ≤ 60 s after relink */
  link: boolean;
  gw: MemberResult[];
  isp6: MemberResult[];
  v4: MemberResult[];
  v6: MemberResult[];
  game: MemberResult[];
  selfLoad: boolean;
}

export interface SecondResult {
  ts: number;
  cls: SecondClass;
  /** errored second: loss or spike on the IPv4 or IPv6 internet reference group */
  es: boolean;
  /** severely errored: ≥ half of the internet probes lost or any internet RTT ≥ 200 ms */
  ses: boolean;
  selfLoad: boolean;
}

/** A group is errored if any member is lost or spiked. */
export function groupState(members: readonly MemberResult[]): GroupState {
  if (members.length === 0) return 'none';
  return members.some((m) => m.lost || m.spike) ? 'bad' : 'ok';
}

export function classifySecond(input: SecondInput): SecondResult {
  const { ts } = input;
  if (input.excluded) return { ts, cls: 'excluded', es: false, ses: false, selfLoad: false };
  const gw = groupState(input.gw);
  const isp6 = groupState(input.isp6);
  const v4 = groupState(input.v4);
  const v6 = groupState(input.v6);
  const game = groupState(input.game);

  const internet = [...input.v4, ...input.v6];
  const lost = internet.filter((m) => m.lost).length;
  const es = v4 === 'bad' || v6 === 'bad';
  const ses =
    internet.length > 0 &&
    (lost * 2 >= internet.length || internet.some((m) => m.rtt !== null && m.rtt >= SES_RTT_MS));

  let cls: SecondClass;
  if (input.link) cls = 'link';
  else if (gw === 'bad') cls = 'lan';
  else if (isp6 !== 'bad' && v4 !== 'bad' && v6 !== 'bad' && game !== 'bad') cls = 'good';
  else if (isp6 === 'bad' && v4 === 'bad' && v6 === 'bad') cls = 'access';
  else if (v4 === 'bad' && v6 === 'ok') cls = 'aftr';
  else if (isp6 === 'ok' && v4 === 'bad' && v6 === 'bad') cls = 'backbone';
  else if (game === 'bad' && isp6 !== 'bad' && v4 !== 'bad' && v6 !== 'bad') cls = 'remote';
  else cls = 'unknown';

  return { ts, cls, es, ses, selfLoad: input.selfLoad };
}

/** LINK second: expected link down, egress on another interface, or inside the relink window. */
export function isLinkSecond(client: ClientState | null, inRecovery: boolean): boolean {
  if (inRecovery) return true;
  if (!client) return false;
  return client.linkUp === false || client.onExpected === false;
}

/** Own rx or tx ≥ selfLoadPct % of min(link speed, tariff) in the respective direction. */
export function isSelfLoad(client: ClientState | null, cfg: AppConfig): boolean {
  if (!client) return false;
  const share = cfg.thresholds.selfLoadPct / 100;
  const capOf = (tariff: number | null): number | null => {
    const caps = [client.linkMbps, tariff].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    return caps.length > 0 ? Math.min(...caps) : null;
  };
  const rxCap = capOf(cfg.tariff.downMbps);
  const txCap = capOf(cfg.tariff.upMbps);
  const rx = client.rxMbps;
  const tx = client.txMbps;
  return (rx !== null && rxCap !== null && rx >= share * rxCap) || (tx !== null && txCap !== null && tx >= share * txCap);
}

export function emptySecondsRollup(ts: number): SecondsRollup {
  return { ts, covered: 0, good: 0, link: 0, lan: 0, access: 0, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 0, ses: 0, selfLoad: 0 };
}

/** Count one classified second into a minute row (excluded seconds are not counted). */
export function addSecond(acc: SecondsRollup, r: SecondResult): void {
  if (r.cls === 'excluded') return;
  acc.covered++;
  acc[r.cls]++;
  if (r.es) acc.es++;
  if (r.ses) acc.ses++;
  if (r.selfLoad) acc.selfLoad++;
}
