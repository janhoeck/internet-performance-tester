import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/lib/shared/config';
import { summarize } from '../../src/lib/shared/stats';
import type { EngineDb } from '../core/types';
import { openEngineDb } from './engine-db';

const dirs: string[] = [];
function tmpDb(): EngineDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-test-'));
  dirs.push(dir);
  return openEngineDb(path.join(dir, 'test.db'), { flushIntervalMs: 60_000 });
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows may keep the file locked briefly */
    }
  }
});

describe('EngineDb', () => {
  it('buffers samples and reads them back', () => {
    const db = tmpDb();
    const t0 = 1_760_000_000_000;
    db.addSample({ targetId: 'cf4', ts: t0, rtt: 12.345678, status: 0 });
    db.addSample({ targetId: 'cf4', ts: t0 + 1000, rtt: null, status: 1 });
    db.addSample({ targetId: 'cf4', ts: t0 + 1000, rtt: 5, status: 0 }); // duplicate ts ignored
    const rows = db.samplesBetween('cf4', t0, t0 + 2000);
    expect(rows).toHaveLength(2);
    expect(rows[0].rtt).toBeCloseTo(12.346, 3);
    expect(rows[1].rtt).toBeNull();
    db.close();
  });

  it('deduplicates events and updates episodes', () => {
    const db = tmpDb();
    const id = db.insertEvent({ ts: 1, type: 'nic_link_down', severity: 'warn', title: 'Link down', source: 'eventlog', dedupeKey: 'evtlog:System:1' });
    expect(id).toBeGreaterThan(0);
    expect(db.insertEvent({ ts: 1, type: 'nic_link_down', severity: 'warn', title: 'Link down', source: 'eventlog', dedupeKey: 'evtlog:System:1' })).toBeNull();
    expect(db.hasEvent('evtlog:System:1')).toBe(true);
    db.updateEvent(id!, { endTs: 5000, details: { downtimeMs: 4999 } });
    db.close();
  });

  it('manages sessions and settings', () => {
    const db = tmpDb();
    const s = db.createSession({ startedAt: 100, endedAt: null, plannedEndAt: null, label: 'Test', status: 'running', note: null });
    expect(db.runningSession()?.id).toBe(s.id);
    db.updateSession(s.id, { status: 'completed', endedAt: 200 });
    expect(db.runningSession()).toBeNull();
    db.setSetting('x', 'y');
    expect(db.getSetting('x')).toBe('y');
    db.setSetting('x', null);
    expect(db.getSetting('x')).toBeNull();
    db.close();
  });

  it('finds minutes without rollups and stores rollups', () => {
    const db = tmpDb();
    const m0 = 1_760_000_040_000 - (1_760_000_040_000 % 60_000);
    for (let i = 0; i < 120; i++) db.addSample({ targetId: 'gw', ts: m0 + i * 1000, rtt: 1, status: 0 });
    const missing = db.minutesMissingRollup(m0, m0 + 180_000, 10);
    expect(missing.map((m) => m.ts).sort()).toEqual([m0, m0 + 60_000]);
    const s = summarize(new Array(60).fill(1));
    db.upsertRollups([{ ts: m0, targetId: 'gw', spikes: 0, ...s }]);
    expect(db.minutesMissingRollup(m0, m0 + 180_000, 10).map((m) => m.ts)).toEqual([m0 + 60_000]);
    db.close();
  });

  it('purges old raw data per retention', () => {
    const db = tmpDb();
    const now = 1_760_000_000_000;
    db.addSample({ targetId: 'gw', ts: now - (DEFAULT_CONFIG.retention.rawDays + 1) * 86_400_000, rtt: 1, status: 0 });
    db.addSample({ targetId: 'gw', ts: now - 1000, rtt: 1, status: 0 });
    db.addMetrics([{ key: 'sys.cpu_pct', ts: now - 100 * 86_400_000, value: 5 }, { key: 'sys.cpu_pct', ts: now, value: 7 }]);
    db.purge(DEFAULT_CONFIG.retention, now);
    expect(db.samplesBetween('gw', 0, now + 1)).toHaveLength(1);
    db.close();
  });

  it('stores sample flags, second classes and recent rollups', () => {
    const db = tmpDb();
    const m0 = 1_760_000_040_000 - (1_760_000_040_000 % 60_000);
    db.addSample({ targetId: 'cf4', ts: m0, rtt: 20, status: 0, flags: 3 });
    expect(db.samplesBetween('cf4', m0, m0 + 1)[0].flags).toBe(3);
    db.upsertSecondsRollups([{ ts: m0, covered: 60, good: 55, link: 2, lan: 0, access: 3, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 5, ses: 1, selfLoad: 0 }]);
    db.upsertSecondsRollups([{ ts: m0, covered: 60, good: 50, link: 2, lan: 0, access: 8, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 10, ses: 2, selfLoad: 1 }]);
    const s = summarize([20, 21, 22]);
    db.upsertRollups([{ ts: m0, targetId: 'cf4', spikes: 0, ...s }]);
    expect(db.rollupsSince(m0 - 1)).toHaveLength(1);
    expect(db.rollupsSince(m0 + 1)).toHaveLength(0);
    db.close();
  });

  it('reads back a minute of classified seconds, finds events by dedupe key and updates their segment', () => {
    const db = tmpDb();
    const m0 = 1_760_000_040_000 - (1_760_000_040_000 % 60_000);
    expect(db.secondsRollupAt(m0)).toBeNull();
    const row = { ts: m0, covered: 40, good: 38, link: 0, lan: 0, access: 2, aftr: 0, backbone: 0, remote: 0, unknown: 0, es: 2, ses: 0, selfLoad: 0 };
    db.upsertSecondsRollups([row]);
    expect(db.secondsRollupAt(m0)).toEqual(row);
    const id = db.insertEvent({ ts: m0, type: 'outage', severity: 'critical', segment: 'internet', title: 'Ausfall', source: 'icmp', dedupeKey: 'incident:outage:1' });
    expect(db.eventIdByDedupeKey('incident:outage:1')).toBe(id);
    expect(db.eventIdByDedupeKey('nope')).toBeNull();
    db.updateEvent(id!, { segment: 'docsis' });
    db.close();
  });

  it('finds missing rollup minutes per target without mixing targets', () => {
    const db = tmpDb();
    const m0 = 1_760_000_040_000 - (1_760_000_040_000 % 60_000);
    for (let i = 0; i < 60; i++) {
      db.addSample({ targetId: 'a', ts: m0 + i * 1000, rtt: 1, status: 0 });
      db.addSample({ targetId: 'b', ts: m0 + 60_000 + i * 1000, rtt: 1, status: 0 });
    }
    const s = summarize(new Array(60).fill(1));
    db.upsertRollups([{ ts: m0, targetId: 'b', spikes: 0, ...s }]); // wrong target/minute must not hide 'a'
    const missing = db.minutesMissingRollup(m0, m0 + 180_000, 10);
    expect(missing).toEqual(expect.arrayContaining([{ targetId: 'a', ts: m0 }, { targetId: 'b', ts: m0 + 60_000 }]));
    expect(missing).toHaveLength(2);
    db.close();
  });

  it('stores snapshots, speedtests and traceroutes', () => {
    const db = tmpDb();
    db.insertSnapshot('router', 10, { a: 1 });
    db.insertSnapshot('router', 20, { a: 2 });
    expect(db.latestSnapshot<{ a: number }>('router')?.data.a).toBe(2);
    db.insertTraceroute({ ts: 5, target: '1.1.1.1', family: 4, hops: [{ hop: 1, ip: '192.168.0.1', rtts: [1, 1, 1], lossPct: 0, avgMs: 1 }], reached: true, pathHash: 'abc', changed: false, trigger: 'manual', durationMs: 1000 });
    expect(db.latestTraceroute(4)?.hops[0].ip).toBe('192.168.0.1');
    expect(db.latestTraceroute(6)).toBeNull();
    db.insertSpeedtest({
      ts: 1, endTs: 2, trigger: 'manual', server: 'Cloudflare FRA', downMbps: 94, upMbps: 40, idleLatencyMs: 18, idleJitterMs: 1,
      loadedDownLatencyMs: 60, loadedDownP95Ms: 80, loadedUpLatencyMs: 30, loadedUpP95Ms: 40, bloatDownMs: 42, bloatUpMs: 12,
      grade: 'B', bytesDown: 1, bytesUp: 1, streams: 6, nicLinkMbps: 100, error: null, series: [],
    });
    expect(db.latestSpeedtest()?.downMbps).toBe(94);
    db.close();
  });
});
