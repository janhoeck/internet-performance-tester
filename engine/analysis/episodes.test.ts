import { describe, expect, it } from 'vitest';
import type { SpikeSeverity } from '../../src/lib/shared/stats';
import type { SpikeVerdict } from './baseline';
import { type LossBurst, LossBurstTracker, SpikeEpisodeTracker, type SpikeUpdate } from './episodes';
import { T0 } from './test-helpers';

const BASE = { median: 18, mad: 1 };
const good: SpikeVerdict = { ok: true, spike: false, severity: null, baseline: BASE, unreliable: false };
const lostV: SpikeVerdict = { ok: false, spike: false, severity: null, baseline: BASE, unreliable: false };
const spike = (severity: SpikeSeverity = 'minor'): SpikeVerdict => ({ ok: true, spike: true, severity, baseline: BASE, unreliable: false });
const s = (sec: number) => T0 + sec * 1000;

function kinds(updates: SpikeUpdate[]): string[] {
  return updates.map((u) => (u.kind === 'finished' ? `finished:${u.persisted ? 'persisted' : 'dropped'}` : u.kind));
}

describe('SpikeEpisodeTracker', () => {
  it('does not persist a single minor spike', () => {
    const tr = new SpikeEpisodeTracker('cf4', { mergeGapMs: 2000 });
    expect(tr.push(s(0), spike('minor'), 50)).toEqual([]);
    expect(tr.open?.spikeSamples).toBe(1);
    expect(tr.expire(s(2))).toEqual([]); // a spike 2 s later could still merge
    const out = tr.expire(s(3));
    expect(kinds(out)).toEqual(['finished:dropped']);
    expect(tr.open).toBeNull();
  });

  it('merges spikes with gaps ≤ 2 s and qualifies at the second spike sample', () => {
    const tr = new SpikeEpisodeTracker('cf4', { mergeGapMs: 2000 });
    expect(tr.push(s(0), spike(), 50)).toEqual([]);
    expect(tr.push(s(1), good, 19)).toEqual([]);
    const q = tr.push(s(2), spike(), 60); // gap exactly 2 s → same episode
    expect(kinds(q)).toEqual(['qualified']);
    const ep = q[0].episode;
    expect(ep).toMatchObject({ targetId: 'cf4', startTs: s(0), endTs: s(2), spikeSamples: 2, peakMs: 60, baselineMs: 18, severity: 'minor' });
    expect(kinds(tr.push(s(3), spike(), 55))).toEqual(['grown']);
    // 3 s without a spike → the episode is finished before the next spike starts a new one
    const next = tr.push(s(7), spike(), 70);
    expect(kinds(next)).toEqual(['finished:persisted']);
    const fin = next[0];
    expect(fin.kind === 'finished' && fin.episode).toMatchObject({ startTs: s(0), endTs: s(3), spikeSamples: 3, peakMs: 60 });
    expect(tr.open).toMatchObject({ startTs: s(7), spikeSamples: 1 });
  });

  it('persists a single spike of severity ≥ major immediately and tracks severity raises', () => {
    const tr = new SpikeEpisodeTracker('cf4', { mergeGapMs: 2000 });
    const q = tr.push(s(0), spike('major'), 80);
    expect(kinds(q)).toEqual(['qualified']);
    const g = tr.push(s(1), spike('severe'), 240);
    expect(g).toHaveLength(1);
    expect(g[0].kind === 'grown' && g[0].severityRaised).toBe(true);
    expect(g[0].episode).toMatchObject({ severity: 'severe', peakMs: 240 });
    const g2 = tr.push(s(2), spike('minor'), 50);
    expect(g2[0].kind === 'grown' && g2[0].severityRaised).toBe(false);
    expect(g2[0].episode.severity).toBe('severe'); // severity never drops
    expect(kinds(tr.finish())).toEqual(['finished:persisted']);
    expect(tr.finish()).toEqual([]);
  });

  it('lost samples neither extend nor end an episode (only the merge gap does)', () => {
    const tr = new SpikeEpisodeTracker('cf4', { mergeGapMs: 2000 });
    tr.push(s(0), spike(), 50);
    expect(tr.push(s(1), lostV, null)).toEqual([]);
    expect(tr.push(s(2), lostV, null)).toEqual([]);
    expect(tr.open?.endTs).toBe(s(0));
    expect(kinds(tr.push(s(3), lostV, null))).toEqual(['finished:dropped']);
  });

  it('flags a level shift when > 50 % of the last 60 s (≥ 10 samples) are spikes', () => {
    const tr = new SpikeEpisodeTracker('cf4', { mergeGapMs: 2000 });
    for (let i = 0; i < 30; i++) tr.push(s(i), good, 19);
    let last: SpikeUpdate[] = [];
    // alternating spike/good keeps the episode open (gaps of 1 s) – share rises towards 50 %
    for (let i = 30; i < 90; i++) last = tr.push(s(i), i % 3 === 0 ? good : spike(), i % 3 === 0 ? 20 : 70);
    expect(tr.levelShare()).toBeGreaterThan(0.5);
    expect(last[last.length - 1].episode.levelShift).toBe(true);
    expect(tr.open?.levelShift).toBe(true);
  });

  it('needs at least 10 successful samples for the level-shift share', () => {
    const tr = new SpikeEpisodeTracker('cf4', { mergeGapMs: 2000 });
    for (let i = 0; i < 5; i++) tr.push(s(i), spike(), 70);
    expect(tr.levelShare()).toBe(0);
    expect(tr.open?.levelShift).toBe(false);
    tr.reset();
    expect(tr.open).toBeNull();
  });
});

describe('LossBurstTracker', () => {
  const opts = (windowSec = 10, minLosses = 2) => ({ windowMs: () => windowSec * 1000, minLosses: () => minLosses });

  function run(tr: LossBurstTracker, pattern: string, start = 0): LossBurst[] {
    const out: LossBurst[] = [];
    [...pattern].forEach((c, i) => {
      const b = tr.push(s(start + i), c === 'x');
      if (b) out.push(b);
    });
    return out;
  }

  it('opens a burst at ≥ 2 losses within 10 s and finishes it 10 s after the last loss', () => {
    const tr = new LossBurstTracker('cf4', opts());
    expect(run(tr, '..x..x...')).toEqual([]);
    expect(tr.open).toEqual({ targetId: 'cf4', startTs: s(2), endTs: s(5), lost: 2, sent: 4, maxRun: 1 });
    expect(run(tr, '.xx', 9)).toEqual([]); // extends: losses at 10 and 11
    expect(tr.open).toMatchObject({ endTs: s(11), lost: 4, sent: 10, maxRun: 2 });
    expect(run(tr, '.........', 12)).toEqual([]); // 12…20: < 10 s after the last loss
    const done = run(tr, '.', 21);
    expect(done).toEqual([{ targetId: 'cf4', startTs: s(2), endTs: s(11), lost: 4, sent: 10, maxRun: 2 }]);
    expect(tr.open).toBeNull();
  });

  it('losses 10 s apart are not a burst (window is (ts − 10 s, ts])', () => {
    const tr = new LossBurstTracker('cf4', opts());
    expect(run(tr, 'x.........x')).toEqual([]);
    expect(tr.open).toBeNull();
    const tr9 = new LossBurstTracker('cf4', opts());
    run(tr9, 'x........x');
    expect(tr9.open).toMatchObject({ startTs: s(0), endTs: s(9), lost: 2, sent: 10 });
  });

  it('honours burstMinLosses and burstWindowSec from the (fresh) config', () => {
    let min = 3;
    const tr = new LossBurstTracker('cf4', { windowMs: () => 5000, minLosses: () => min });
    run(tr, 'x.x..');
    expect(tr.open).toBeNull();
    run(tr, 'x', 5); // losses at 2 and 5 within 5 s, plus 0 dropped out of the window
    expect(tr.open).toBeNull();
    min = 2;
    run(tr, 'x', 6); // window (1, 6] holds losses at 2, 5 and 6
    expect(tr.open).toMatchObject({ startTs: s(2), endTs: s(6), lost: 3, sent: 5, maxRun: 2 });
  });

  it('expire() and finish() close an open burst', () => {
    const tr = new LossBurstTracker('cf4', opts());
    run(tr, 'xx');
    expect(tr.expire(s(10))).toBeNull();
    expect(tr.expire(s(11))).toMatchObject({ startTs: s(0), endTs: s(1), lost: 2 });
    run(tr, 'xx', 20);
    expect(tr.finish()).toMatchObject({ startTs: s(20), lost: 2 });
    expect(tr.finish()).toBeNull();
  });
});
