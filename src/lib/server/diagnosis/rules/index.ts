// Registry of all diagnosis rules R01–R20 (MESSPLAN §5). Order = evaluation order.
import type { RuleDef } from '../types';
import { NIC_LINK_FLAPS, nicLinkFlaps } from './r01-nic-link-flaps';
import { NIC_100M, nic100m } from './r02-nic-100m';
import { WLAN_FAILOVER, wlanFailover } from './r03-wlan-failover';
import { BUFFERBLOAT_LOAD, bufferbloatLoad } from './r04-bufferbloat-load';
import { LAN_QUALITY, lanQuality } from './r05-lan-quality';
import { LAN_UNREACHABLE, lanUnreachable } from './r06-lan-unreachable';
import { ACCESS_SPIKES, accessSpikes } from './r07-access-spikes';
import { HOUSEHOLD_LOAD, householdLoad } from './r08-household-load';
import { DOCSIS_VALUES, docsisValues } from './r09-docsis-values';
import { PEAK_HOURS, peakHours } from './r10-peak-hours';
import { IPV4_VS_IPV6, ipv4VsIpv6 } from './r11-ipv4-vs-ipv6';
import { REMOTE_ONLY, remoteOnly } from './r12-remote-only';
import { IDENTITY_CHANGE, identityChange } from './r13-identity-change';
import { AFTER_CHANGE, afterChange } from './r14-after-change';
import { VPN_ACTIVE, vpnActive } from './r15-vpn-active';
import { DATA_QUALITY, dataQuality } from './r16-data-quality';
import { TOP_CAUSE, topCauseFinding } from './r17-top-cause';
import { SPEED_BELOW_TARIFF, speedBelowTariff } from './r18-speed-below-tariff';
import { PERIODIC_SPIKES, periodicSpikes } from './r19-periodic-spikes';
import { ROUTER_INSTABILITY, routerInstability } from './r20-router-instability';

export const RULES: readonly RuleDef[] = [
  { code: 'R01', id: NIC_LINK_FLAPS, run: nicLinkFlaps },
  { code: 'R02', id: NIC_100M, run: nic100m },
  { code: 'R03', id: WLAN_FAILOVER, run: wlanFailover },
  { code: 'R04', id: BUFFERBLOAT_LOAD, run: bufferbloatLoad },
  { code: 'R05', id: LAN_QUALITY, run: lanQuality },
  { code: 'R06', id: LAN_UNREACHABLE, run: lanUnreachable },
  { code: 'R07', id: ACCESS_SPIKES, run: accessSpikes },
  { code: 'R08', id: HOUSEHOLD_LOAD, run: householdLoad },
  { code: 'R09', id: DOCSIS_VALUES, run: docsisValues },
  { code: 'R10', id: PEAK_HOURS, run: peakHours },
  { code: 'R11', id: IPV4_VS_IPV6, run: ipv4VsIpv6 },
  { code: 'R12', id: REMOTE_ONLY, run: remoteOnly },
  { code: 'R13', id: IDENTITY_CHANGE, run: identityChange },
  { code: 'R14', id: AFTER_CHANGE, run: afterChange },
  { code: 'R15', id: VPN_ACTIVE, run: vpnActive },
  { code: 'R16', id: DATA_QUALITY, run: dataQuality },
  { code: 'R17', id: TOP_CAUSE, run: topCauseFinding },
  { code: 'R18', id: SPEED_BELOW_TARIFF, run: speedBelowTariff },
  { code: 'R19', id: PERIODIC_SPIKES, run: periodicSpikes },
  { code: 'R20', id: ROUTER_INSTABILITY, run: routerInstability },
];

export {
  ACCESS_SPIKES, AFTER_CHANGE, BUFFERBLOAT_LOAD, DATA_QUALITY, DOCSIS_VALUES, HOUSEHOLD_LOAD, IDENTITY_CHANGE, IPV4_VS_IPV6,
  LAN_QUALITY, LAN_UNREACHABLE, NIC_100M, NIC_LINK_FLAPS, PEAK_HOURS, PERIODIC_SPIKES, REMOTE_ONLY, ROUTER_INSTABILITY,
  SPEED_BELOW_TARIFF, TOP_CAUSE, VPN_ACTIVE, WLAN_FAILOVER,
};
