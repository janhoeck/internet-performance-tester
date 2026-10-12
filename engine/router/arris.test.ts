// ArrisAdapter integration tests against the in-memory fake router (real crypto + wire protocol).
import { describe, expect, it } from 'vitest';
import { ArrisAdapter, type LoginContext } from './arris';
import { createFakeRouter } from './fake-router';

const PW = 'test-password';

function adapterFor(router = createFakeRouter({ password: PW })) {
  const adapter = new ArrisAdapter({ host: '192.168.0.1', makeSession: router.makeSession });
  return { adapter, router };
}

async function loginOk(): Promise<{ adapter: ArrisAdapter; router: ReturnType<typeof createFakeRouter>; ctx: LoginContext }> {
  const { adapter, router } = adapterFor();
  const res = await adapter.login(PW);
  if (res.outcome.kind !== 'success') throw new Error(`login failed: ${res.outcome.kind}`);
  return { adapter, router, ctx: { csrfNonce: res.outcome.csrfNonce, session: res.session } };
}

describe('fetchStatus (unauthenticated)', () => {
  it('reads the start page without logging in', async () => {
    const { adapter, router } = adapterFor();
    const { info, httpMs } = await adapter.fetchStatus();
    expect(info.connectionStatus).toBe('DOCSIS Online');
    expect(info.aftrAddress).toBe('2a00:0:cff:84a0::3');
    expect(info.dsLite).toBe(true);
    expect(httpMs).toBeGreaterThanOrEqual(0);
    expect(router.calls['ajaxSet_Password.php']).toBeUndefined(); // never logged in
  });
});

describe('login', () => {
  it('succeeds with the correct password and returns a csrf nonce', async () => {
    const { adapter } = adapterFor();
    const res = await adapter.login(PW);
    expect(res.outcome.kind).toBe('success');
    if (res.outcome.kind === 'success') expect(res.outcome.csrfNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(res.page?.sessionId).toBeTruthy();
    res.session.abort();
  });

  it('reports wrong-password for a bad password (and sends exactly one POST)', async () => {
    const { adapter, router } = adapterFor();
    const res = await adapter.login('nope');
    expect(res.outcome.kind).toBe('wrong-password');
    expect(router.calls['ajaxSet_Password.php']).toBe(1);
  });

  it('reports a lockout seen on the start page before sending a password', async () => {
    const router = createFakeRouter({ password: PW, lockoutSec: 120 });
    const { adapter } = adapterFor(router);
    const res = await adapter.login(PW);
    expect(res.outcome.kind).toBe('lockout');
    if (res.outcome.kind === 'lockout') expect(res.outcome.waitSec).toBe(120);
    expect(router.calls['ajaxSet_Password.php']).toBeUndefined(); // never attempted
  });

  it('reports a lockout returned by the password POST', async () => {
    const router = createFakeRouter({ password: PW, forceStatus: 'lockout', waitSec: 90 });
    const { adapter } = adapterFor(router);
    const res = await adapter.login(PW);
    expect(res.outcome.kind).toBe('lockout');
    if (res.outcome.kind === 'lockout') expect(res.outcome.waitSec).toBe(90);
  });

  it('reports error when the router is unreachable (nothing sent)', async () => {
    const router = createFakeRouter({ password: PW, unreachable: true });
    const { adapter } = adapterFor(router);
    const res = await adapter.login(PW);
    expect(res.outcome.kind).toBe('error');
  });
});

describe('authenticated data fetches', () => {
  it('reads DOCSIS channels, uptime, devices and the event log', async () => {
    const { adapter, ctx } = await loginOk();
    const docsis = await adapter.fetchDocsis(ctx);
    expect(docsis?.ds.length).toBe(2);
    expect(docsis?.us.length).toBe(1);

    const status = await adapter.fetchDeviceStatus(ctx);
    expect(status?.uptimeSec).toBe(86400 + 2 * 3600 + 3 * 60);

    const devices = await adapter.fetchAttachedDevices(ctx);
    expect(devices?.[0].hostName).toBe('Jan-PC');

    const log = await adapter.fetchEventLog(ctx);
    expect(log?.[0].key).toBe('us_t3_timeout');
    await adapter.logout(ctx);
  });

  it('returns null from a data fetch when the session is lost (no csrf nonce)', async () => {
    const { adapter, router } = adapterFor();
    // a context with a bogus nonce → the fake answers 400 session-lost
    const badCtx: LoginContext = { csrfNonce: 'deadbeef', session: router.makeSession('192.168.0.1', 80) };
    expect(await adapter.fetchDocsis(badCtx)).toBeNull();
    badCtx.session.abort();
  });

  it('logout frees the session and aborts it', async () => {
    const { adapter, router, ctx } = await loginOk();
    await adapter.logout(ctx);
    expect(router.calls['logout.php']).toBe(1);
    expect(ctx.session.aborted).toBe(true);
  });
});
