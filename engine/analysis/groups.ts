// Reference target groups for the per-second classifier and the outage detector
// (docs/ARCHITECTURE.md §4.6). Groups are derived from segment/family/pairId of the configured
// targets instead of hard-coded ids, so renamed or user-added targets keep working.
import type { AppConfig } from '../../src/lib/shared/config';
import type { TargetConfig } from '../../src/lib/shared/types';

export interface ReferenceGroups {
  /** LAN ICMP targets (default gw, gw6) */
  gw: string[];
  /** first provider hop / CMTS ICMP targets, segment docsis (default isp6) */
  isp6: string[];
  /** internet ICMP IPv4 targets that have an IPv6 counterpart (default cf4, g4) */
  v4: string[];
  /** their IPv6 counterparts (default cf6, g6) */
  v6: string[];
  /** game / cloud region targets of any probe kind (default aws-fra, aws-irl) */
  game: string[];
  /** all enabled internet ICMP targets – an outage needs ≥ 2 of them lost */
  internet: string[];
  /** ICMP targets of provider hops behind the CMTS: segment aftr / isp (default aftr, isp4) */
  provider: string[];
  /** ids of all ICMP targets (enabled or not) – used to assemble pinger rounds */
  icmp: ReadonlySet<string>;
}

const ids = (list: readonly TargetConfig[]): string[] => list.map((t) => t.id);

function isPair(a: TargetConfig, b: TargetConfig): boolean {
  return a.pairId === b.id || b.pairId === a.id;
}

export function resolveGroups(cfg: AppConfig): ReferenceGroups {
  const enabled = cfg.targets.filter((t) => t.enabled);
  const icmp = enabled.filter((t) => t.kind === 'icmp');
  const internet = icmp.filter((t) => t.segment === 'internet');
  const inet4 = internet.filter((t) => t.family === 4);
  const inet6 = internet.filter((t) => t.family === 6);

  // Prefer dual-stack pairs (same provider on both families → fair IPv4/IPv6 comparison).
  let v4 = inet4.filter((a) => inet6.some((b) => isPair(a, b)));
  let v6 = inet6.filter((b) => v4.some((a) => isPair(a, b)));
  if (v4.length === 0 || v6.length === 0) {
    v4 = inet4;
    v6 = inet6;
  }

  return {
    gw: ids(icmp.filter((t) => t.segment === 'lan')),
    isp6: ids(icmp.filter((t) => t.segment === 'docsis')),
    v4: ids(v4),
    v6: ids(v6),
    game: ids(enabled.filter((t) => t.segment === 'game')),
    internet: ids(internet),
    provider: ids(icmp.filter((t) => t.segment === 'aftr' || t.segment === 'isp')),
    icmp: new Set(cfg.targets.filter((t) => t.kind === 'icmp').map((t) => t.id)),
  };
}

/** resolveGroups() memoized on the config object (ctx.config() returns a new object on reload). */
export class GroupCache {
  private cfg: AppConfig | null = null;
  private groups: ReferenceGroups | null = null;

  get(cfg: AppConfig): ReferenceGroups {
    if (cfg !== this.cfg || this.groups === null) {
      this.cfg = cfg;
      this.groups = resolveGroups(cfg);
    }
    return this.groups;
  }
}
