import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeServer, type BridgeTicket } from '../src/bridge/server.ts';
import { buildStore, type UsableProfile } from '../src/store/profiles.ts';

const profile = buildStore({
  APP_URL: 'localhost:3000',
  APP_USERNAME: 'qa@example.com',
  APP_PASSWORD: 's3cret',
  APP_SUBMIT_SELECTOR: '#go',
  APP_SUCCESS_SELECTOR: '#menu',
}).profiles[0] as UsableProfile;
const ORIGIN = 'http://localhost:3000';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function request(url: string, options: { method?: string; origin?: string; body?: string; chunks?: string[] } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = options.origin ? { origin: options.origin } : {};
    const req = http.request(url, { method: options.method ?? 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += String(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject);
    void (async () => {
      for (const chunk of options.chunks ?? []) {
        req.write(chunk);
        await new Promise((r) => setTimeout(r, 20));
      }
      req.end(options.body);
    })();
  });
}

function urls(ticket: BridgeTicket) {
  const [, base, token] = /"(http:\/\/127\.0\.0\.1:\d+)\/v1\/filler\/([\w-]+)\.js"/.exec(ticket.function)!;
  return {
    filler: `${base}/v1/filler/${token}.js`,
    credentials: `${base}/v1/credentials/${token}`,
    result: `${base}/v1/result/${token}`,
    base: base!,
    token: token!,
  };
}

let server: BridgeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('BridgeServer', () => {
  it('issues one-time tickets on a loopback port', async () => {
    server = new BridgeServer();
    const ticket = await server.issue(profile);
    expect(ticket).toMatchObject({ profile: 'app', expiresInSeconds: 60 });
    expect(ticket.script).toBe(`await (${ticket.function})()`);
    expect(ticket.expression).toBe(`(${ticket.function})()`);
    expect(ticket.function).not.toContain('s3cret');
    const { base, token } = urls(ticket);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
    const other = await server.issue(profile);
    expect(urls(other).base).toBe(base);
    expect(urls(other).token).not.toBe(token);
  });

  it('serves the filler only to the profile origin', async () => {
    server = new BridgeServer();
    const { filler } = urls(await server.issue(profile));
    const ok = await request(filler, { origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('text/javascript');
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.text).toContain('bridgeLogin');
    expect(ok.text).not.toContain('s3cret');
    const evil = await request(filler, { origin: 'https://evil.test' });
    expect(evil.text).toContain('origin_mismatch');
    expect(evil.text).toContain('https://evil.test');
    const bare = await request(filler);
    expect(bare.text).toContain('unknown origin');
    expect(bare.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('embeds the profile no-form context in the filler it serves', async () => {
    const context = { previous_login: { status: 'success', at: '2026-11-22T12:00:00.000Z' }, hint: 'already logged in' };
    const noFormContext = vi.fn(() => context);
    server = new BridgeServer({ noFormContext });
    const { filler } = urls(await server.issue(profile));
    expect((await request(filler, { origin: ORIGIN })).text).toContain(`const noForm = ${JSON.stringify(context)};`);
    expect(noFormContext).toHaveBeenCalledWith('app');
    expect((await request(filler, { origin: 'https://evil.test' })).text).not.toContain('already logged in');

    const plain = new BridgeServer();
    const p = urls(await plain.issue(profile));
    expect((await request(p.filler, { origin: ORIGIN })).text).toContain('const noForm = null;');
    await plain.close();
  });

  it('releases credentials once, to the right origin, over POST', async () => {
    server = new BridgeServer({ reuseWaitMs: 50 });
    const { credentials } = urls(await server.issue(profile));
    expect((await request(credentials, { method: 'POST', origin: 'https://evil.test' })).status).toBe(403);
    expect((await request(credentials, { method: 'POST' })).status).toBe(403);
    expect((await request(credentials, { origin: ORIGIN })).status).toBe(405);
    const ok = await request(credentials, { method: 'POST', origin: 'http://127.0.0.1:3000' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({
      username: 'qa@example.com',
      password: 's3cret',
      selectors: { submit: '#go' },
      successSelector: '#menu',
    });
    const again = await request(credentials, { method: 'POST', origin: ORIGIN });
    expect(again.status).toBe(410);
    expect(JSON.parse(again.text)).toMatchObject({ status: 'expired', hint: expect.stringContaining('already used and its outcome is unknown') });
  });

  it('answers a re-run of a used script with the first run outcome', async () => {
    server = new BridgeServer();
    const t = urls(await server.issue(profile));
    expect((await request(t.credentials, { method: 'POST', origin: ORIGIN })).status).toBe(200);
    const rerun = request(t.credentials, { method: 'POST', origin: ORIGIN });
    await new Promise((r) => setTimeout(r, 30));
    await request(t.result, { method: 'POST', body: JSON.stringify({ status: 'success', url: `${ORIGIN}/home` }) });
    const waited = await rerun;
    expect(waited.status).toBe(409);
    expect(JSON.parse(waited.text)).toEqual({ status: 'already_used', result: { status: 'success', url: `${ORIGIN}/home` } });
    const later = await request(t.credentials, { method: 'POST', origin: ORIGIN });
    expect(JSON.parse(later.text).result.status).toBe('success');
  });

  it('releases waiting re-runs when it closes', async () => {
    server = new BridgeServer();
    const t = urls(await server.issue(profile));
    await request(t.credentials, { method: 'POST', origin: ORIGIN });
    const rerun = request(t.credentials, { method: 'POST', origin: ORIGIN }).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    await server.close();
    server = null;
    const settled = await rerun;
    expect(settled === null || settled.status === 410).toBe(true);
  });

  it('expires tickets and forgets them', async () => {
    let now = 1_000;
    server = new BridgeServer({ ttlMs: 10_000, now: () => now });
    const first = urls(await server.issue(profile));
    now += 10_000;
    expect((await request(first.credentials, { method: 'POST', origin: ORIGIN })).status).toBe(410);
    await server.issue(profile);
    expect((await request(first.filler, { origin: ORIGIN })).status).toBe(410);
    expect((await request(`${first.base}/v1/credentials/unknown-token-0123456789`, { method: 'POST', origin: ORIGIN })).status).toBe(410);
    expect((await request(`${first.base}/somewhere`)).status).toBe(404);
  });

  it('answers CORS / private-network preflights', async () => {
    server = new BridgeServer();
    const { credentials } = urls(await server.issue(profile));
    const preflight = await request(credentials, { method: 'OPTIONS', origin: ORIGIN });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('limits how often a profile can be released', async () => {
    server = new BridgeServer({ maxReleases: 1 });
    const a = urls(await server.issue(profile));
    const b = urls(await server.issue(profile));
    expect((await request(a.credentials, { method: 'POST', origin: ORIGIN })).status).toBe(200);
    const blocked = await request(b.credentials, { method: 'POST', origin: ORIGIN });
    expect(blocked.status).toBe(429);
    expect(JSON.parse(blocked.text).status).toBe('rate_limited');
  });

  it('passes the first well-formed result report to onResult', async () => {
    const onResult = vi.fn();
    server = new BridgeServer({ onResult });
    const t = urls(await server.issue(profile));
    expect((await request(t.result, { method: 'POST', origin: ORIGIN, body: 'not json' })).status).toBe(204);
    await request(t.result, { method: 'POST', origin: ORIGIN, body: JSON.stringify({ nope: 1 }) });
    await request(t.result, { method: 'POST', origin: ORIGIN, body: 'x'.repeat(20_000) });
    const oversized = await request(t.result, { method: 'POST', origin: ORIGIN, chunks: ['{"status":"', 'x'.repeat(9_000), 'y'.repeat(9_000)], body: '"}' });
    expect(oversized.status).toBe(204);
    expect(onResult).not.toHaveBeenCalled();
    await request(t.result, { method: 'POST', origin: ORIGIN, body: JSON.stringify({ status: 'failed', url: ORIGIN }) });
    await request(t.result, { method: 'POST', body: JSON.stringify({ status: 'success', url: ORIGIN }) });
    expect(onResult).toHaveBeenCalledExactlyOnceWith('app', { status: 'failed', url: ORIGIN });

    const silent = new BridgeServer();
    const s = urls(await silent.issue(profile));
    expect((await request(s.result, { method: 'POST', body: JSON.stringify({ status: 'success' }) })).status).toBe(204);
    await silent.close();
  });

  it('closes cleanly, also when it never started', async () => {
    const idle = new BridgeServer();
    await idle.close();
    server = new BridgeServer();
    const { filler } = urls(await server.issue(profile));
    await server.close();
    await expect(request(filler, { origin: ORIGIN })).rejects.toThrow();
    await server.close();
  });
});
