// Shared domain types – the contract between engine, API routes and UI.
// Keep this file free of runtime imports (types + tiny const maps only).

// ─── Basics ────────────────────────────────────────────────────────────────

/**
 * Network segments along the path PC → … → game server. Used for topology, findings and
 * target grouping.
 *  client   – the PC itself (adapter, driver, CPU, VPN, standby)
 *  lan      – PC ⇄ router link (cable/WLAN), measured by gateway ping
 *  router   – the router as a device (web UI response time, reboots, CPU)
 *  docsis   – cable access line router ⇄ CMTS (DOCSIS values, first IPv6 hop)
 *  aftr     – Vodafone DS-Lite gateway (AFTR/CGNAT, IPv4 only)
 *  isp      – Vodafone backbone (first public IPv4 hops behind the AFTR)
 *  internet – well-known anycast targets (Cloudflare, Google, Quad9)
 *  game     – game/cloud region endpoints
 */
export type Segment = 'client' | 'lan' | 'router' | 'docsis' | 'aftr' | 'isp' | 'internet' | 'game';

export const SEGMENTS: readonly Segment[] = [
  'client', 'lan', 'router', 'docsis', 'aftr', 'isp', 'internet', 'game',
] as const;

export type IpFamily = 4 | 6;

/** icmp = Windows ping.exe; tcp = TCP handshake time; udp-dns = DNS query RTT over UDP; http = HTTP GET time-to-first-byte */
export type ProbeKind = 'icmp' | 'tcp' | 'udp-dns' | 'http';

export const SampleStatus = {
  OK: 0,
  TIMEOUT: 1,
  /** e.g. "Zielhost nicht erreichbar" (ARP failure) – Windows counts this as "received"! */
  UNREACHABLE: 2,
  /** local error: general failure, transmit failed, spawn error, socket error */
  ERROR: 3,
  TTL_EXPIRED: 4,
} as const;
export type SampleStatusCode = (typeof SampleStatus)[keyof typeof SampleStatus];

export type Severity = 'info' | 'warn' | 'critical';
export type Health = 'good' | 'warn' | 'bad' | 'unknown';

// ─── Targets & samples ─────────────────────────────────────────────────────

/**
 * Dynamic host placeholders resolved by the engine at runtime:
 *  $gateway – configured router IP (router.ip)
 *  $isp4    – first responding public IPv4 hop behind the router (latest IPv4 traceroute)
 *  $isp6    – first responding IPv6 hop behind the router (latest IPv6 traceroute, ≈ CMTS)
 *  $aftr    – DS-Lite AFTR IPv6 address (router status `aftrAddress`)
 *  $router6 – router's global IPv6 LAN address (default IPv6 gateway / DNS server), optional
 */
export type DynamicHost = '$gateway' | '$isp4' | '$isp6' | '$aftr' | '$router6';

export interface TargetConfig {
  /** stable short id `[a-z0-9-]+`, e.g. 'gw', 'cf4', 'cf6-udp' */
  id: string;
  /** German display name */
  name: string;
  /** IP literal, hostname or DynamicHost placeholder */
  host: string;
  family: IpFamily;
  kind: ProbeKind;
  /** tcp/http port, udp-dns port (default 53) */
  port?: number;
  /** http path (default '/') */
  path?: string;
  /** DNS name queried by udp-dns probes (default 'cloudflare.com') */
  query?: string;
  segment: Segment;
  /** sampling interval in ms (icmp ≥ 1000) */
  intervalMs: number;
  timeoutMs: number;
  enabled: boolean;
  /** shipped default target: can be disabled but not deleted */
  builtin: boolean;
  /** id of the dual-stack counterpart (e.g. cf4 ⇄ cf6) for IPv4/IPv6 comparisons */
  pairId?: string;
  /** chart color override (CSS color) */
  color?: string;
  description?: string;
}

export interface Sample {
  /**
   * send time, epoch ms. ICMP samples from the pinger use the SCHEDULED tick time, aligned to
   * whole seconds, so all targets of one round share the same ts (join key for per-second analysis).
   */
  ts: number;
  targetId: string;
  /** round-trip time in ms, null when lost */
  rtt: number | null;
  status: SampleStatusCode;
  /** bit set of SampleFlag (default 0) */
  flags?: number;
}

export const SampleFlag = {
  /** taken while a speed/load test saturated the line */
  LOAD: 1,
  /** egress interface was not the expected one (e.g. WLAN failover while the session runs on Ethernet) */
  FAILOVER: 2,
  /** reply arrived later than the probe interval (rtt > 1000 ms) */
  LATE: 4,
} as const;

/**
 * Per-second classification (first match wins), computed by the engine from one ICMP round:
 *  excluded – no heartbeat / PC asleep / engine gap
 *  good     – no loss and no spike on the reference targets
 *  link     – expected interface down, egress on another interface (failover) or ≤ 60 s after relink
 *  lan      – gateway lost or above the LAN spike threshold
 *  access   – gateway fine, CMTS hop (isp6) bad and both families errored  (segment 'docsis')
 *  aftr     – IPv4 internet errored while IPv6 internet is clean            (segment 'aftr')
 *  backbone – CMTS fine, both families errored                              (segment 'isp')
 *  remote   – only game targets bad                                          (segment 'game')
 *  unknown  – errored but no rule matched
 */
export type SecondClass =
  | 'excluded' | 'good' | 'link' | 'lan' | 'access' | 'aftr' | 'backbone' | 'remote' | 'unknown';

export const SECOND_CLASS_SEGMENT: Record<Exclude<SecondClass, 'excluded' | 'good' | 'unknown'>, Segment> = {
  link: 'client',
  lan: 'lan',
  access: 'docsis',
  aftr: 'aftr',
  backbone: 'isp',
  remote: 'game',
};

/** One-minute counts of classified seconds (table seconds_1m). */
export interface SecondsRollup {
  /** minute start, epoch ms */
  ts: number;
  /** seconds with a heartbeat (not excluded) */
  covered: number;
  good: number;
  link: number;
  lan: number;
  access: number;
  aftr: number;
  backbone: number;
  remote: number;
  unknown: number;
  /** errored seconds (any loss or spike on the internet reference targets) */
  es: number;
  /** severely errored seconds (≥ half of the reference probes lost or RTT ≥ 200 ms) */
  ses: number;
  /** seconds in which own traffic reached ≥ 80 % of min(link speed, tariff) */
  selfLoad: number;
}

/** One-minute aggregate per target (table rollup_1m). Percentiles from the histogram. */
export interface Rollup {
  /** minute start, epoch ms (multiple of 60000) */
  ts: number;
  targetId: string;
  sent: number;
  lost: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** mean absolute difference of consecutive successful RTTs (ms) */
  jitter: number | null;
  stddev: number | null;
  /** number of samples classified as latency spike */
  spikes: number;
  /** counts per LATENCY_BUCKETS_MS bucket (see stats.ts); length = LATENCY_BUCKETS_MS.length + 1 */
  hist: number[];
}

/** Summary over an arbitrary range (computed from rollups by merging histograms). */
export interface TargetStats {
  targetId: string;
  from: number;
  to: number;
  sent: number;
  lost: number;
  lossPct: number | null;
  min: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  jitter: number | null;
  spikes: number;
  spikesPerHour: number | null;
  /** minutes with any data / minutes in range, 0..100 */
  coveragePct: number;
}

// ─── Events ────────────────────────────────────────────────────────────────

export type EventType =
  | 'nic_link_down'      // Windows event log (e.g. e2fexpress 27)
  | 'nic_link_up'        // Windows event log (e.g. e2fexpress 32/33) – details.speedMbps
  | 'adapter_change'     // adapter status/link speed change seen by polling
  | 'route_switch'       // active interface for internet traffic changed (e.g. Ethernet → WLAN)
  | 'standby'            // Kernel-Power 42
  | 'resume'             // Kernel-Power 107
  | 'engine_gap'         // engine timer gap (sleep/hang) – samples missing, not loss
  | 'outage'             // all internet targets lost ≥ N s – details.classification
  | 'loss_burst'         // several losses on a target within a short window
  | 'latency_spike'      // episode of samples above spike threshold
  | 'route_change'       // traceroute path changed
  | 'speedtest'          // speed test window (stats exclude it by default)
  | 'router_reboot'      // router uptime reset / router unreachable then back
  | 'router_offline'     // router stopped answering
  | 'router_log'         // entry from router event log (DOCSIS T3/T4 etc.)
  | 'docsis_change'      // channel count / lock / modulation change, threshold crossing
  | 'router_login'       // login success/failure/lockout
  | 'wlan_connect'
  | 'wlan_disconnect'
  | 'wlan_roam'          // BSSID change
  | 'ip_change'          // public IP / WAN IPv6 / AFTR changed
  | 'identity_change'    // gateway MAC / DHCP server / DNS servers changed, IP address conflict (Tcpip 4199)
  | 'gaming'             // a configured game process was running (episode: ts … endTs)
  | 'vpn_change'         // WARP/VPN state changed
  | 'mtu_change'
  | 'nat_change'
  | 'session_start'
  | 'session_end'
  | 'config_change'
  | 'note';              // user note

export type EventSource =
  | 'engine' | 'icmp' | 'tcp' | 'udp' | 'eventlog' | 'adapter' | 'wlan' | 'route' | 'vpn'
  | 'system' | 'router' | 'traceroute' | 'speedtest' | 'stun' | 'mtu' | 'user';

export interface NetEvent {
  id?: number;
  ts: number;
  /** for episodes (outage, spike, speedtest, link down until up …) */
  endTs?: number | null;
  type: EventType;
  severity: Severity;
  segment?: Segment | null;
  /** short German title, e.g. "Netzwerkkabel getrennt (Link down)" */
  title: string;
  details?: Record<string, unknown> | null;
  source: EventSource;
  /** unique key to avoid duplicates, e.g. 'evtlog:System:123456' */
  dedupeKey?: string | null;
}

/** details.classification of 'outage' events */
export type OutageClass =
  | 'client'    // NIC link down / adapter problem on the PC
  | 'lan'       // gateway unreachable too (cable/LAN/router LAN side)
  | 'docsis'    // gateway ok, first IPv6 hop / AFTR unreachable (cable line)
  | 'aftr'      // IPv6 fine, IPv4 broken (DS-Lite gateway)
  | 'isp'       // AFTR/CMTS ok, Vodafone backbone hop lost
  | 'internet'  // provider hops fine, internet targets lost
  | 'unknown';

// ─── Generic metrics & snapshots ───────────────────────────────────────────

export interface MetricPoint {
  ts: number;
  /** see METRICS registry in metrics.ts, e.g. 'nic.link_mbps', 'docsis.ds.snr_min' */
  key: string;
  value: number;
}

export type SnapshotKind =
  | 'adapters' | 'wlan' | 'vpn' | 'route' | 'router' | 'docsis' | 'router_log'
  | 'nat' | 'mtu' | 'env';

export interface Snapshot<T = unknown> {
  id?: number;
  ts: number;
  kind: SnapshotKind;
  data: T;
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export type SessionStatus = 'running' | 'completed' | 'aborted';

export interface TestSession {
  id: number;
  startedAt: number;
  endedAt: number | null;
  /** null = unlimited */
  plannedEndAt: number | null;
  label: string | null;
  status: SessionStatus;
  note: string | null;
}

// ─── Speed test ────────────────────────────────────────────────────────────

export type SpeedPhase = 'idle' | 'download' | 'upload' | 'done' | 'error';
export type BufferbloatGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface SpeedSeriesPoint {
  /** ms since test start */
  t: number;
  phase: SpeedPhase;
  /** instantaneous throughput in Mbps (download or upload depending on phase) */
  mbps?: number | null;
  /** latency probe result during the phase (ms, null = lost) */
  rtt?: number | null;
}

export interface SpeedtestResult {
  id?: number;
  ts: number;
  endTs: number;
  trigger: 'schedule' | 'manual';
  /** e.g. 'Cloudflare FRA' */
  server: string | null;
  downMbps: number | null;
  upMbps: number | null;
  idleLatencyMs: number | null;
  idleJitterMs: number | null;
  loadedDownLatencyMs: number | null;
  loadedDownP95Ms: number | null;
  loadedUpLatencyMs: number | null;
  loadedUpP95Ms: number | null;
  /** loaded median − idle median */
  bloatDownMs: number | null;
  bloatUpMs: number | null;
  grade: BufferbloatGrade | null;
  bytesDown: number;
  bytesUp: number;
  streams: number;
  /** NIC link speed at test time (detects 100 Mbit/s bottleneck) */
  nicLinkMbps: number | null;
  error: string | null;
  series: SpeedSeriesPoint[];
}

export interface SpeedtestProgress {
  running: boolean;
  phase: SpeedPhase;
  /** 0..1 */
  progress: number;
  currentMbps: number | null;
  currentRtt: number | null;
  result?: SpeedtestResult | null;
  error?: string | null;
}

// ─── Traceroute / MTR / MTU / NAT ──────────────────────────────────────────

export interface MtrStats {
  sent: number;
  lost: number;
  lossPct: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
}

export interface TraceHop {
  hop: number;
  /** null when the hop did not answer ('*') */
  ip: string | null;
  rtts: (number | null)[];
  lossPct: number;
  avgMs: number | null;
  /** per-hop ping statistics from the MTR pass (optional) */
  mtr?: MtrStats | null;
}

export interface TracerouteResult {
  id?: number;
  ts: number;
  target: string;
  family: IpFamily;
  hops: TraceHop[];
  reached: boolean;
  /** hash over the sequence of responding hop IPs */
  pathHash: string;
  changed: boolean;
  trigger: 'schedule' | 'manual' | 'incident' | 'startup';
  durationMs: number;
}

export interface MtuResult {
  ts: number;
  family: IpFamily;
  target: string;
  /** path MTU in bytes (payload + IP/ICMP headers), null when undetermined */
  mtu: number | null;
  maxPayload: number | null;
  note?: string | null;
}

export type NatMapping = 'endpoint-independent' | 'endpoint-dependent' | 'blocked' | 'unknown';

export interface NatResult {
  ts: number;
  family: IpFamily;
  localAddress: string | null;
  publicIp: string | null;
  mappings: { server: string; mapped: string | null; rttMs: number | null; error?: string | null }[];
  mapping: NatMapping;
  /** public IP differs from router WAN IP / DS-Lite active */
  cgnat: boolean | null;
}

// ─── Router ────────────────────────────────────────────────────────────────

export type RouterAdapterId = 'arris-vodafone-station' | 'generic';

export interface DocsisChannel {
  dir: 'ds' | 'us';
  channelId: number | null;
  /** 'SC-QAM' | 'OFDM' | 'OFDMA' | raw string from router */
  type: string;
  frequencyMHz: number | null;
  /** raw frequency text, e.g. '751~861' for OFDM blocks */
  frequencyText: string | null;
  powerDbmv: number | null;
  /** SNR / MER in dB (downstream; upstream usually null) */
  snrDb: number | null;
  modulation: string | null;
  locked: boolean | null;
  /** cumulative codeword counters (downstream) */
  corrected: number | null;
  uncorrectable: number | null;
  rating: Health;
  /** short German reason when rating is warn/bad */
  ratingNote?: string | null;
  raw?: Record<string, unknown>;
}

export interface DocsisSnapshot {
  ts: number;
  ds: DocsisChannel[];
  us: DocsisChannel[];
  /** overall rating of the line */
  rating: Health;
  notes: string[];
}

export interface RouterLogEntry {
  /** parsed time, null if the router clock/format is unknown */
  ts: number | null;
  timeText: string;
  level: string | null;
  message: string;
  /** e.g. 'T3', 'T4', 'ranging', 'sync', 'reboot', 'dhcp', 'other' */
  category: string;
  severity: Severity;
}

export interface RouterStatus {
  ts: number;
  ip: string;
  reachable: boolean;
  /** HTTP GET / response time (router load indicator) */
  httpMs: number | null;
  adapter: RouterAdapterId;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  loginConfigured: boolean;
  loginEnabled: boolean;
  loggedIn: boolean;
  loginError: string | null;
  lockoutUntil: number | null;
  /** e.g. 'DOCSIS Online' */
  connectionStatus: string | null;
  wanIpv4: string | null;
  wanIpv6: string | null;
  aftrAddress: string | null;
  dsLite: boolean | null;
  gwMode: string | null;
  uptimeSec: number | null;
  lastRebootReason: string | null;
  docsis: DocsisSnapshot | null;
  /** devices the router sees (overview page, needs login); `speed` is the router-side port/link rate */
  attachedDevices: RouterAttachedDevice[] | null;
  /** additional raw key/values (e.g. all `_ga.*` vars) */
  extra: Record<string, string | number | boolean | null>;
}

export interface RouterAttachedDevice {
  kind: 'lan' | 'wlan' | 'guest';
  hostName: string | null;
  mac: string | null;
  ipv4: string | null;
  ipv6: string | null;
  /** e.g. '1000 Mbps' / '100 Mbps' (LAN) or WLAN link rate */
  speed: string | null;
  /** true if this is the PC running the tool (matched by MAC/IP) */
  isThisPc: boolean;
}

// ─── PC / client ───────────────────────────────────────────────────────────

export interface AdapterInfo {
  name: string;
  description: string;
  ifIndex: number;
  /** 'Up' | 'Disconnected' | … */
  status: string;
  linkMbps: number | null;
  mediaType: string | null;
  mac: string | null;
  driverVersion: string | null;
  driverDate: string | null;
  /** driver service name (= event log provider for Intel, e.g. 'e2fexpress') */
  serviceName: string | null;
  isWifi: boolean;
  /** VPN/tunnel/virtual adapters (WARP, Hyper-V, Bluetooth PAN …) */
  isVirtual: boolean;
  /** WLAN: MSFT_NetAdapter.MediaConnectState (1 connected, 2 disconnected) – OperationalStatus lies for WLAN */
  mediaConnected: boolean | null;
  /** assigned IPv4/IPv6 addresses (used to map the egress source address to an interface) */
  addresses: string[];
  /** interface GUID (maps NCSI/WLAN events to adapters) */
  guid?: string | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  rxDiscards: number | null;
  txErrors: number | null;
  txDiscards: number | null;
}

export interface ActiveRoute {
  family: IpFamily;
  destination: string;
  ifAlias: string | null;
  ifIndex: number | null;
  sourceAddress: string | null;
  nextHop: string | null;
}

export interface AdapterSnapshot {
  ts: number;
  adapters: AdapterInfo[];
  routes: ActiveRoute[];
  /** relevant advanced properties of the primary adapter (EEE, Speed & Duplex, …) */
  advanced: { name: string; value: string }[];
}

export interface WlanInfo {
  ts: number;
  present: boolean;
  connected: boolean;
  ssid: string | null;
  bssid: string | null;
  radioType: string | null;
  band: string | null;
  channel: number | null;
  signalPct: number | null;
  rssiDbm: number | null;
  rxMbps: number | null;
  txMbps: number | null;
  raw: Record<string, string>;
}

export interface VpnInfo {
  ts: number;
  warp: {
    installed: boolean;
    connected: boolean | null;
    status: string | null;
    mode: string | null;
    /** include = only listed networks tunneled (game traffic direct); exclude/full = everything tunneled */
    splitTunnel: 'include' | 'exclude' | null;
  } | null;
  /** other active tunnel/VPN adapters by name */
  otherTunnels: string[];
}

/** Per-day count of NIC link events (from the Windows event log incl. imported history). */
export interface LinkEventDay {
  day: string; // YYYY-MM-DD (local time)
  down: number;
  up1g: number;
  up100m: number;
  upOther: number;
}

// ─── Engine status & live stream ───────────────────────────────────────────

export interface ProbeState {
  targetId: string;
  /** resolved host (IP) or null when a dynamic host is not yet known */
  resolvedHost: string | null;
  running: boolean;
  lastTs: number | null;
  lastRtt: number | null;
  lastStatus: SampleStatusCode | null;
  error: string | null;
  /** non-error detail for the UI, e.g. "Cloudflare-Standort dus01" or "Ersatzmessung (ping.exe)" */
  info?: string | null;
}

export interface ModuleState {
  name: string;
  enabled: boolean;
  running: boolean;
  busy: boolean;
  lastRunTs: number | null;
  nextRunTs: number | null;
  lastError: string | null;
}

export interface DynamicHosts {
  gateway: string | null;
  isp4: string | null;
  isp6: string | null;
  aftr: string | null;
  router6: string | null;
}

/** Live connection context of the PC (1 Hz link state + egress check). */
export interface ClientState {
  ts: number;
  /** interface the session expects internet traffic on (from session start), e.g. 'Ethernet' */
  expectedIf: string | null;
  /** current egress interface for IPv4 / IPv6 internet traffic (by local source address) */
  egressV4If: string | null;
  egressV6If: string | null;
  egressV4Address: string | null;
  egressV6Address: string | null;
  onExpected: boolean | null;
  /** primary physical adapter link (1 Hz) */
  linkUp: boolean | null;
  linkMbps: number | null;
  /** own throughput over the last second */
  rxMbps: number | null;
  txMbps: number | null;
  gaming: boolean;
  /** engine keeps Windows from idle sleep while a session runs */
  preventSleep: boolean;
}

export interface PingerStatus {
  /** agent = PowerShell .NET pinger, fallback = ping.exe per target */
  mode: 'stopped' | 'starting' | 'agent' | 'fallback';
  restarts: number;
  /** SetThreadExecutionState active (standby blocked) – null = unknown / not requested */
  preventSleepActive: boolean | null;
  /** German status text (null = all fine) */
  lastError: string | null;
}

export interface EngineStatus {
  version: string;
  pid: number;
  startedAt: number;
  now: number;
  session: TestSession | null;
  probes: ProbeState[];
  modules: ModuleState[];
  dynamicHosts: DynamicHosts;
  client: ClientState | null;
  /** ICMP pinger agent state (null = probes module not loaded / no session) */
  pinger?: PingerStatus | null;
  speedtest: SpeedtestProgress | null;
  dbPath: string;
  dbSizeBytes: number | null;
}

/** Messages on the live stream (engine GET /live, proxied by Next /api/live). One JSON object per SSE `data:` line. */
export type LiveMessage =
  | { type: 'hello'; data: EngineStatus }
  | { type: 'status'; data: EngineStatus }
  | { type: 'samples'; data: Sample[] }
  | { type: 'event'; data: NetEvent }
  | { type: 'metrics'; data: MetricPoint[] }
  | { type: 'speedtest'; data: SpeedtestProgress }
  | { type: 'traceroute'; data: TracerouteResult }
  | { type: 'router'; data: RouterStatus }
  | { type: 'session'; data: TestSession | null }
  /** 1 Hz connection context (link, egress, own throughput) */
  | { type: 'client'; data: ClientState }
  /** emitted only by the Next proxy when the engine is not reachable */
  | { type: 'offline'; data: { since: number; error: string } };

/** Control actions accepted by engine POST /control and Next POST /api/control. */
export type ControlAction =
  | 'session.start'      // params: { durationMin: number | null, label?: string }
  | 'session.stop'
  | 'speedtest.run'
  | 'traceroute.run'     // params: { family?: 4 | 6 }
  | 'mtr.run'
  | 'mtu.run'
  | 'stun.run'
  | 'udpburst.run'
  | 'router.poll'
  | 'router.login'       // force re-login
  | 'router.setPassword' // params: { password: string | null } – engine stores it DPAPI-encrypted
  | 'eventlog.import'    // params: { days: number }
  | 'config.reload';

export interface ControlRequest {
  action: ControlAction;
  params?: Record<string, unknown>;
}

export interface ControlResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ─── Diagnosis ─────────────────────────────────────────────────────────────

export type Confidence = 'low' | 'medium' | 'high';

export interface FindingEvidence {
  label: string;
  value: string;
  ts?: number;
  tsEnd?: number;
}

export interface Finding {
  /** rule id, e.g. 'nic-link-flaps' */
  id: string;
  severity: Severity;
  confidence: Confidence;
  segment: Segment;
  /** German */
  title: string;
  /** German, 1–3 sentences */
  summary: string;
  evidence: FindingEvidence[];
  /** German, actionable */
  recommendations: string[];
  /** ranking 0..100 (higher = more likely the root cause of the gaming problems) */
  score: number;
  relatedEventIds?: number[];
}

export interface SegmentHealth {
  segment: Segment;
  status: Health;
  /** German label, e.g. 'PC & Adapter' */
  label: string;
  /** German one-liner */
  summary: string;
  kpis: { label: string; value: string; status?: Health }[];
}

/**
 * Multiplicative gaming score (see docs/research/methodology.md §11): score = 100 · Π fᵢ with
 * factors interpolated from p50, jitter (MASD), tail (p99 − p50), loss %, outages per hour.
 */
export interface GamingScore {
  /** 0..100 */
  score: number;
  /** A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40 */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  parts: {
    key: 'p50' | 'jitter' | 'tail' | 'loss' | 'outages';
    label: string;
    /** formatted input value, e.g. '18 ms' */
    value: string;
    /** 0..1 */
    factor: number;
    /** share of the missing points attributed to this factor */
    pointsLost: number;
  }[];
  /** key of the lowest factor (the limiting one), null if all factors are 1 */
  limiting: GamingScore['parts'][number]['key'] | null;
  /** E-model style MOS estimate (1..4.5) */
  mos: number | null;
}

export interface DiagnosisReport {
  from: number;
  to: number;
  generatedAt: number;
  verdict: {
    severity: Severity;
    /** German headline, e.g. "Hauptursache: instabile Netzwerkverbindung am PC" */
    title: string;
    text: string;
    primarySegment: Segment | null;
  };
  findings: Finding[];
  segments: SegmentHealth[];
  /** classified seconds in range (from seconds_1m) – the backbone of the root-cause verdict */
  seconds: {
    covered: number;
    bad: number;
    es: number;
    ses: number;
    selfLoad: number;
    byClass: Record<Exclude<SecondClass, 'excluded' | 'good'>, number>;
  } | null;
  gamingScore: GamingScore | null;
  dataQuality: {
    samples: number;
    coveragePct: number;
    gaps: number;
    notes: string[];
  };
}
