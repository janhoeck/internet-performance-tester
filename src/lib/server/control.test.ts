import { describe, expect, it } from 'vitest';
import { CONTROL_ACTIONS, controlRequestSchema, controlTimeoutMs, toControlRequest } from './control';
import './http'; // German zod messages

const parse = (v: unknown) => controlRequestSchema.safeParse(v);

describe('controlRequestSchema', () => {
  it('knows every ControlAction', () => {
    expect(CONTROL_ACTIONS).toHaveLength(13);
    expect(CONTROL_ACTIONS).toContain('router.setPassword');
  });

  it('accepts valid requests and keeps params', () => {
    const ok = parse({ action: 'session.start', params: { durationMin: 4320, label: 'Nach Kabeltausch' } });
    expect(ok.success).toBe(true);
    if (ok.success) expect(toControlRequest(ok.data)).toEqual({ action: 'session.start', params: { durationMin: 4320, label: 'Nach Kabeltausch' } });
    expect(parse({ action: 'session.start', params: { durationMin: null } }).success).toBe(true);
    expect(parse({ action: 'speedtest.run' }).success).toBe(true);
    expect(parse({ action: 'traceroute.run', params: { family: 6 } }).success).toBe(true);
    expect(parse({ action: 'router.setPassword', params: { password: null } }).success).toBe(true);
    const noParams = parse({ action: 'mtr.run' });
    if (noParams.success) expect(toControlRequest(noParams.data)).toEqual({ action: 'mtr.run' });
  });

  it('rejects unknown actions and invalid params', () => {
    expect(parse({ action: 'system.shutdown' }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(parse({ action: 'traceroute.run', params: { family: 5 } }).success).toBe(false);
    expect(parse({ action: 'eventlog.import', params: {} }).success).toBe(false);
    expect(parse({ action: 'session.start', params: { durationMin: -5 } }).success).toBe(false);
    const res = parse({ action: 'router.setPassword', params: { password: 1234 } });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].path).toEqual(['params', 'password']);
  });

  it('gives slow actions more time', () => {
    expect(controlTimeoutMs('router.setPassword')).toBeGreaterThan(controlTimeoutMs('speedtest.run'));
    expect(controlTimeoutMs('eventlog.import')).toBe(60_000);
  });
});
