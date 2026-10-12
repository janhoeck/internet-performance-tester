import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Sample, SampleStatus, type SampleStatusCode } from '../../src/lib/shared/types';
import { SampleSequencer, splitRounds } from './sequencer';
import { T0, lost, ok } from './test-helpers';

const icmpIds = new Set(['gw', 'cf4', 'cf6', 'g4']);
const isIcmp = (id: string) => icmpIds.has(id);

describe('SampleSequencer', () => {
  it('releases samples only after the delay, sorted by ts', () => {
    const seq = new SampleSequencer(3000);
    seq.add({ sample: ok('cf4', T0 + 1000, 20), load: false });
    seq.add({ sample: lost('g4', T0), load: false }); // timeout of the earlier tick arrives later
    seq.add({ sample: ok('cf4', T0, 18), load: false });
    expect(seq.drain(T0 + 2999)).toEqual([]);
    const out = seq.drain(T0 + 3000);
    expect(out.map((e) => `${e.sample.targetId}@${e.sample.ts - T0}`)).toEqual(['cf4@0', 'g4@0']);
    expect(seq.pending).toBe(1);
    expect(seq.drain(T0 + 4000).map((e) => e.sample.ts - T0)).toEqual([1000]);
  });

  it('drops samples that arrive after their target was processed past their ts', () => {
    const seq = new SampleSequencer(3000);
    seq.add({ sample: ok('cf4', T0 + 1000, 20), load: false });
    seq.drain(T0 + 5000);
    expect(seq.add({ sample: ok('cf4', T0, 18), load: false })).toBe(false);
    expect(seq.add({ sample: ok('cf4', T0 + 1000, 18), load: false })).toBe(false);
    expect(seq.add({ sample: ok('g4', T0, 18), load: false })).toBe(true); // other target unaffected
    expect(seq.late).toBe(2);
  });
});

describe('splitRounds', () => {
  it('groups ICMP samples by tick and keeps non-ICMP samples apart', () => {
    const entries = [ok('gw', T0, 1), ok('cf4', T0, 18), ok('aws-fra', T0 + 400, 30), lost('g4', T0), ok('gw', T0 + 1000, 1)].map((sample) => ({
      sample,
      load: sample.targetId === 'cf4',
    }));
    const { rounds, others } = splitRounds(entries, isIcmp);
    expect(rounds.map((r) => r.ts - T0)).toEqual([0, 1000]);
    expect([...rounds[0].samples.keys()].sort()).toEqual(['cf4', 'g4', 'gw']);
    expect(rounds[0].load).toBe(true);
    expect(rounds[1].load).toBe(false);
    expect(others.map((e) => e.sample.targetId)).toEqual(['aws-fra']);
  });

  it('maps unaligned fallback samples to the nearest tick and keeps the worse duplicate', () => {
    const entries = [ok('cf4', T0 + 1450, 18), lost('cf4', T0 + 550), ok('gw', T0 + 1499, 2)].map((sample) => ({ sample, load: false }));
    const { rounds } = splitRounds(entries, isIcmp);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].ts).toBe(T0 + 1000);
    expect(rounds[0].samples.get('cf4')?.sample.rtt).toBeNull();
  });

  it('reassembles complete rounds from the real pinger stream (fixtures/windows/dotnet_pinger_stream.json)', () => {
    interface Rec { type: string; arrive: number; target?: string; seq?: number; status?: string; rtt?: number | null }
    const fixture = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'fixtures/windows/dotnet_pinger_stream.json'), 'utf8'),
    ) as { recs: Rec[] };
    const idOf: Record<string, string> = { '192.168.0.1': 'gw', '1.1.1.1': 'cf4', '2606:4700:4700::1111': 'cf6', '192.0.2.1': 'g4', '192.168.0.2': 'x-arp' };
    const statusOf: Record<string, SampleStatusCode> = { Success: SampleStatus.OK, TimedOut: SampleStatus.TIMEOUT, DestinationHostUnreachable: SampleStatus.UNREACHABLE };
    const seq = new SampleSequencer(3000);
    const drained: Sample[] = [];
    for (const r of fixture.recs) {
      if (r.type !== 'echo' || !r.target || !r.seq || !r.status) continue;
      const arrive = T0 + r.arrive;
      drained.push(...seq.drain(arrive).map((e) => e.sample));
      const ts = T0 + (r.seq - 1) * 1000; // scheduled tick
      seq.add({ sample: { targetId: idOf[r.target], ts, rtt: r.status === 'Success' ? (r.rtt ?? 0) : null, status: statusOf[r.status] ?? SampleStatus.ERROR }, load: false });
    }
    drained.push(...seq.drain(Number.POSITIVE_INFINITY).map((e) => e.sample));
    expect(seq.late).toBe(0);
    const { rounds } = splitRounds(drained.map((sample) => ({ sample, load: false })), (id) => id !== 'nothing');
    expect(rounds).toHaveLength(9);
    for (const r of rounds) expect(r.samples.size).toBe(5);
    expect(rounds[1].samples.get('x-arp')?.sample.status).toBe(SampleStatus.UNREACHABLE);
    expect(rounds[0].samples.get('cf4')?.sample.rtt).toBe(18);
  });
});
