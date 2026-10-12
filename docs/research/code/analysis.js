// Reference implementations of the analysis algorithms proposed in METHOD.md (plain JS, TS-compatible logic).
'use strict';

// ---------- basic statistics ----------
const quantileSorted = (s, q) => { // linear interpolation, same as @cloudflare/speedtest percentile()
  if (!s.length) return NaN;
  const idx = (s.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
};
const sortNum = (a) => [...a].sort((x, y) => x - y);
const median = (a) => quantileSorted(sortNum(a), 0.5);
function madSigma(a) { // robust sigma = 1.4826 * MAD
  const m = median(a);
  return { median: m, sigma: 1.4826 * median(a.map((x) => Math.abs(x - m))) };
}

// ---------- jitter ----------
// MASD: mean absolute successive difference over consecutive *successful* samples (a loss breaks the chain)
function masd(rtts) {
  let sum = 0, n = 0, prev = null;
  for (const r of rtts) {
    if (r == null) { prev = null; continue; }
    if (prev != null) { sum += Math.abs(r - prev); n++; }
    prev = r;
  }
  return { sum, n, value: n ? sum / n : null }; // store sum & n in rollups (mergeable)
}
// RFC 3550 interarrival-jitter estimator applied to RTT deltas (smoothed, for live gauges)
const rfc3550 = (J, prevRtt, rtt) => J + (Math.abs(rtt - prevRtt) - J) / 16;

// ---------- loss analysis ----------
// seq: array of {ts, lost:boolean}; returns runs of consecutive losses with classification
function lossRuns(seq, { burstMax = 2, intervalMs = 1000 } = {}) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= seq.length; i++) {
    const lost = i < seq.length && seq[i].lost;
    if (lost && start < 0) start = i;
    if (!lost && start >= 0) {
      const len = i - start;
      const before = start > 0 ? seq[start - 1].ts : seq[start].ts - intervalMs;
      const after = i < seq.length ? seq[i].ts : seq[i - 1].ts + intervalMs;
      runs.push({ startTs: seq[start].ts, len, approxDurationMs: after - before - intervalMs,
        kind: len === 1 ? 'isolated' : len <= burstMax ? 'burst' : 'outage' });
      start = -1;
    }
  }
  return runs;
}
// Gilbert (2-state Markov) parameters + conditional loss probability
function gilbert(lostArr) {
  let rr = 0, rl = 0, lr = 0, ll = 0, lost = 0;
  for (let i = 0; i < lostArr.length; i++) {
    if (lostArr[i]) lost++;
    if (i === 0) continue;
    const a = lostArr[i - 1], b = lostArr[i];
    if (!a && !b) rr++; else if (!a && b) rl++; else if (a && !b) lr++; else ll++;
  }
  const p = rl / Math.max(1, rr + rl);      // P(loss | prev received)
  const r = lr / Math.max(1, lr + ll);      // P(received | prev lost)
  const ulp = lost / Math.max(1, lostArr.length);
  const clp = ll / Math.max(1, ll + lr);    // P(loss | prev lost)
  return { ulp, clp, p, r, meanBurstLen: r > 0 ? 1 / r : null, burstiness: ulp > 0 ? clp / ulp : null };
}
// RFC 3611 burst/gap segmentation with Gmin (default 16)
function rfc3611Bursts(lostArr, gmin = 16) {
  const bursts = []; let bStart = -1, lastLoss = -1, recvSince = 0, lostInBurst = 0;
  for (let i = 0; i < lostArr.length; i++) {
    if (lostArr[i]) {
      if (bStart < 0 || recvSince >= gmin) { if (bStart >= 0) bursts.push({ start: bStart, end: lastLoss, lost: lostInBurst }); bStart = i; lostInBurst = 0; }
      lostInBurst++; lastLoss = i; recvSince = 0;
    } else recvSince++;
  }
  if (bStart >= 0) bursts.push({ start: bStart, end: lastLoss, lost: lostInBurst });
  // RFC 3611: a single loss separated by >= Gmin received packets on both sides is a *gap* loss, not a burst
  const real = bursts.filter((b) => b.lost > 1);
  return { bursts: real.map((b) => ({ ...b, len: b.end - b.start + 1, density: b.lost / (b.end - b.start + 1) })), gapLosses: bursts.length - real.length };
}
// Wilson score interval for a loss proportion
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// ---------- spike detection (robust, baseline-relative) ----------
class SpikeDetector {
  constructor({ window = 600, k = 5, minDeltaMs = 25, sigmaFloorMs = 1, absMs = 200 } = {}) {
    Object.assign(this, { window, k, minDeltaMs, sigmaFloorMs, absMs }); this.buf = [];
  }
  push(rtt) { // returns null (lost) or {baseline, threshold, spike, severity}
    if (rtt == null) return null;
    let res = { spike: false };
    if (this.buf.length >= 60) {
      const { median: m, sigma } = madSigma(this.buf);
      const thr = m + Math.max(this.k * Math.max(sigma, this.sigmaFloorMs), this.minDeltaMs);
      const spike = rtt > thr || rtt >= this.absMs;
      const severity = !spike ? 0 : (rtt >= this.absMs || rtt - m >= 150) ? 3 : (rtt - m >= 50 ? 2 : 1);
      res = { baseline: m, threshold: thr, spike, severity };
    }
    this.buf.push(rtt); if (this.buf.length > this.window) this.buf.shift();
    return res;
  }
}
// merge spike samples into episodes (gap <= mergeGapMs)
function episodes(spikeTs, mergeGapMs = 2000) {
  const eps = [];
  for (const t of spikeTs) {
    const e = eps[eps.length - 1];
    if (e && t - e.end <= mergeGapMs) { e.end = t; e.count++; } else eps.push({ start: t, end: t, count: 1 });
  }
  return eps;
}

// ---------- periodicity ----------
// events: epoch seconds of episode starts; returns significant autocorrelation peaks (period candidates)
function periodicity(events, { spanSec, maxLag = 900, minLag = 3, smooth = 1 } = {}) {
  if (events.length < 6) return [];
  const t0 = Math.min(...events), n = spanSec || (Math.max(...events) - t0 + 1);
  const x = new Float64Array(n);
  for (const e of events) { const i = e - t0; for (let d = -smooth; d <= smooth; d++) if (i + d >= 0 && i + d < n) x[i + d] = 1; }
  const mean = x.reduce((a, b) => a + b, 0) / n; let den = 0;
  for (let i = 0; i < n; i++) den += (x[i] - mean) ** 2;
  if (!den) return [];
  const r = new Float64Array(maxLag + 1);
  for (let k = minLag; k <= maxLag; k++) { let s = 0; for (let i = 0; i + k < n; i++) s += (x[i] - mean) * (x[i + k] - mean); r[k] = s / den; }
  const thr = 4 / Math.sqrt(n);
  const peaks = [];
  for (let k = minLag + 1; k < maxLag; k++) if (r[k] > thr && r[k] >= r[k - 1] && r[k] >= r[k + 1]) peaks.push({ periodSec: k, r: +r[k].toFixed(3) });
  // keep fundamental periods: drop peaks that are ~multiples of a stronger shorter peak
  peaks.sort((a, b) => b.r - a.r);
  const fund = [];
  for (const p of peaks) if (!fund.some((f) => Math.abs(p.periodSec / f.periodSec - Math.round(p.periodSec / f.periodSec)) < 0.05)) fund.push(p);
  return fund.slice(0, 3);
}

// ---------- hop attribution (pathping-style, generalised) ----------
// hops: [{ttl, lossPct (source->hop), rttMed}] ordered by TTL, destination last; null = no reply data
function attributeHops(hops) {
  const n = hops.length; const out = [];
  for (let i = 0; i < n; i++) {
    // persistent loss = minimum loss seen at this hop or any later hop (loss must persist to count)
    let persist = Infinity, persistRtt = Infinity;
    for (let j = i; j < n; j++) {
      if (hops[j].lossPct != null) persist = Math.min(persist, hops[j].lossPct);
      if (hops[j].rttMed != null) persistRtt = Math.min(persistRtt, hops[j].rttMed);
    }
    out.push({ ttl: hops[i].ttl, persistentLoss: persist, nodeLoss: hops[i].lossPct == null ? null : hops[i].lossPct - persist, persistentRtt: persistRtt });
  }
  for (let i = 0; i < n; i++) {
    const prevL = i ? out[i - 1].persistentLoss : 0, prevR = i ? out[i - 1].persistentRtt : 0;
    out[i].linkLoss = Math.max(0, out[i].persistentLoss - prevL);   // loss introduced on the link INTO this hop
    out[i].addedRtt = Math.max(0, out[i].persistentRtt - prevR);    // latency added by the link INTO this hop
  }
  return out;
}

// ---------- mergeable log-bucket histogram (DDSketch style) ----------
const G = 1.04, LNG = Math.log(G), MIN = 0.1;
const bucketOf = (ms) => (ms <= MIN ? 0 : Math.ceil(Math.log(ms / MIN) / LNG));
const bucketValue = (i) => (i === 0 ? 0 : (MIN * 2 * G ** i) / (G + 1));
function histQuantile(h, q) {
  const ks = Object.keys(h).map(Number).sort((a, b) => a - b); const n = ks.reduce((s, k) => s + h[k], 0);
  let c = 0; const rank = q * (n - 1); for (const k of ks) { c += h[k]; if (c > rank) return bucketValue(k); } return NaN;
}

// ---------- gaming score ----------
const interp = (x, pts) => { // pts: [[x, f], ...] ascending x; clamps outside
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
  return pts[pts.length - 1][1];
};
const ANCHORS = {
  latencyP50: [[35, 1], [60, 0.92], [100, 0.75], [150, 0.5], [200, 0.3], [300, 0]],
  jitterMasd: [[3, 1], [5, 0.97], [10, 0.9], [20, 0.75], [30, 0.6], [50, 0.35], [100, 0]],
  spikeTail: [[15, 1], [30, 0.95], [50, 0.85], [100, 0.65], [200, 0.4], [400, 0.1]],   // p99 - p50 (ms)
  lossPct: [[0, 1], [0.1, 0.98], [0.5, 0.9], [1, 0.8], [2, 0.6], [5, 0.3], [10, 0]],
  outagesPerHour: [[0, 1], [0.04, 0.95], [0.25, 0.85], [1, 0.6], [3, 0.3], [6, 0.1]],
};
function gamingScore(m) {
  const f = {}; for (const k of Object.keys(ANCHORS)) if (m[k] != null) f[k] = interp(m[k], ANCHORS[k]);
  const prod = Object.values(f).reduce((a, b) => a * b, 1);
  const score = Math.round(100 * prod);
  const lnSum = Object.values(f).reduce((s, v) => s + Math.log(Math.max(v, 1e-6)), 0);
  const deficit = 100 - 100 * prod;
  const pointsLost = {}; for (const [k, v] of Object.entries(f)) pointsLost[k] = lnSum < 0 ? +(deficit * Math.log(Math.max(v, 1e-6)) / lnSum).toFixed(1) : 0;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  const worst = Object.entries(f).sort((a, b) => a[1] - b[1])[0];
  return { score, grade, factors: f, pointsLost, limitingFactor: worst && worst[1] < 0.97 ? worst[0] : null };
}
// simplified E-model MOS (PingPlotter/NetBeez variant), latency = avg RTT, jitter = MASD
function mos(avgRtt, jitter, lossPct) {
  const eff = avgRtt + 2 * jitter + 10;
  let R = eff < 160 ? 93.2 - eff / 40 : 93.2 - (eff - 120) / 10;
  R -= 2.5 * lossPct;
  if (R < 0) return 1; if (R > 100) return 4.5;
  return 1 + 0.035 * R + 0.000007 * R * (R - 60) * (100 - R);
}
// Cloudflare AIM 'gaming' classification (from @cloudflare/speedtest internalConfig.ts)
function aimGaming({ latency, packetLoss /* ratio 0..1 */, loadedLatencyIncrease }) {
  const th = (d, r) => (v) => { let i = 0; while (i < d.length && v >= d[i]) i++; return r[i]; };
  const pts = th([0.01, 0.05, 0.25, 0.5], [10, 5, 0, -10, -20])(packetLoss)
    + th([10, 20, 50, 100, 500], [20, 10, 5, 0, -10, -20])(latency)
    + th([10, 20, 50, 100, 500], [20, 10, 5, 0, -10, -20])(loadedLatencyIncrease);
  const s = Math.max(0, pts); const idx = th([5, 15, 25, 30], [0, 1, 2, 3, 4])(s);
  return { points: s, classification: ['bad', 'poor', 'average', 'good', 'great'][idx] };
}

module.exports = { quantileSorted, median, madSigma, masd, rfc3550, lossRuns, gilbert, rfc3611Bursts, wilson, SpikeDetector, episodes, periodicity, attributeHops, bucketOf, bucketValue, histQuantile, gamingScore, mos, aimGaming };

// ---------- self test ----------
if (require.main === module) {
  const assert = require('assert');
  // MASD (PingPlotter KB example style): 184,115 -> 69 ...
  assert.strictEqual(masd([10, 20, null, 30, 25]).value, (10 + 5) / 2);
  // loss runs
  const seq = [0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0].map((l, i) => ({ ts: i * 1000, lost: !!l }));
  const runs = lossRuns(seq);
  assert.deepStrictEqual(runs.map((r) => r.kind), ['isolated', 'burst', 'outage']);
  assert.strictEqual(runs[2].approxDurationMs, 4000);
  // gilbert on random vs bursty
  const rnd = Array.from({ length: 20000 }, () => Math.random() < 0.01);
  const bursty = []; for (let i = 0; i < 2000; i++) { const b = Math.random() < 0.002; for (let j = 0; j < 10; j++) bursty.push(b && j < 5); }
  console.log('gilbert random', gilbert(rnd)); console.log('gilbert bursty', gilbert(bursty));
  console.log('wilson 1/900', wilson(1, 900).map((x) => (x * 100).toFixed(3) + '%'));
  console.log('rfc3611 bursts', rfc3611Bursts([0, 1, 0, 1, 0, 0, 1, ...Array(20).fill(0), 1].map(Boolean)));
  // spike detector
  const sd = new SpikeDetector(); const spikes = [];
  for (let t = 0; t < 3600; t++) { const v = 18 + Math.round(Math.random() * 6) + (t % 60 === 0 ? 120 : 0); const r = sd.push(v); if (r && r.spike) spikes.push(t); }
  console.log('spikes found', spikes.length, 'first', spikes.slice(0, 5));
  console.log('periodicity', periodicity(spikes, { spanSec: 3600 }));
  // hop attribution (pathping doc example: 0,16,13,14,13 % source-to-here)
  console.log('attribution', attributeHops([{ ttl: 1, lossPct: 0, rttMed: 41 }, { ttl: 2, lossPct: 16, rttMed: 22 }, { ttl: 3, lossPct: 13, rttMed: 24 }, { ttl: 4, lossPct: 14, rttMed: 21 }, { ttl: 5, lossPct: 13, rttMed: 24 }]).map((h) => `${h.ttl}: link=${h.linkLoss} node=${h.nodeLoss}`).join(' | '));
  console.log('score good', gamingScore({ latencyP50: 22, jitterMasd: 3, spikeTail: 12, lossPct: 0, outagesPerHour: 0 }));
  console.log('score evening', gamingScore({ latencyP50: 25, jitterMasd: 12, spikeTail: 120, lossPct: 0.8, outagesPerHour: 0.5 }));
  console.log('mos', mos(25, 12, 0.8).toFixed(2), 'aim', aimGaming({ latency: 20, packetLoss: 0.008, loadedLatencyIncrease: 45 }));
}
