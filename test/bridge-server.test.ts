import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeServer, type BridgeTicket } from '../src/bridge/server.ts';
import { buildStore, type UsableProfile } from '../src/store/profiles.ts';
import { totpCode } from '../src/totp.ts';

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

describe('BridgeServer: one run per script, even when the first run found no form (#2 review)', () => {
  it('serves the filler once; a re-run gets the first run outcome without touching the page', async () => {
    server = new BridgeServer({ reuseWaitMs: 50 });
    const t = urls(await server.issue(profile));
    expect((await request(t.filler, { origin: ORIGIN })).text).toContain('const login = ');
    await request(t.result, { method: 'POST', body: JSON.stringify({ status: 'no_login_form', url: `${ORIGIN}/` }) });
    const rerun = (await request(t.filler, { origin: ORIGIN })).text;
    expect(rerun).not.toContain('const login = ');
    expect(rerun).toContain('"status":"no_login_form"');
    expect(rerun).toContain('This one-time script already ran');
    // The credentials were never released, and a re-run cannot get them either.
    expect((await request(t.credentials, { method: 'POST', origin: ORIGIN })).status).toBe(200);
  });

  it('answers expired when the first run never reported', async () => {
    server = new BridgeServer({ reuseWaitMs: 20 });
    const t = urls(await server.issue(profile));
    await request(t.filler, { origin: ORIGIN });
    const rerun = (await request(t.filler, { origin: ORIGIN })).text;
    expect(rerun).toContain('"status":"expired"');
    expect(rerun).not.toContain('const login = ');
  });
});

describe('BridgeServer: one-time codes for a TOTP profile (#1)', () => {
  const totpProfile = buildStore({
    APP_URL: 'localhost:3000',
    APP_USERNAME: 'qa@example.com',
    APP_PASSWORD: 's3cret',
    APP_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  }).profiles[0] as UsableProfile;
  const codeUrl = (ticket: BridgeTicket) => `${urls(ticket).base}/v1/code/${urls(ticket).token}`;
  /** The start of a 30 s step: the current code has all its time left. */
  const NOW = 1_700_000_010_000;
  /** Loads the filler like the page does, and returns the code nonce the script carries. */
  async function startRun(ticket: BridgeTicket): Promise<string> {
    const script = (await request(urls(ticket).filler, { origin: ORIGIN })).text;
    return /const codeNonce = "([\w-]+)";/.exec(script)![1]!;
  }
  const askCode = (ticket: BridgeTicket, nonce: unknown, origin = ORIGIN) =>
    request(codeUrl(ticket), { method: 'POST', origin, body: JSON.stringify({ nonce }) });

  it('tells the filler whether the profile has a TOTP secret, never the secret', async () => {
    server = new BridgeServer();
    const filler = (await request(urls(await server.issue(totpProfile)).filler, { origin: ORIGIN })).text;
    expect(filler).toContain('"totp":true');
    expect(filler).toContain('/v1/code/');
    expect(filler).toMatch(/const codeNonce = "[\w-]{20,}";/);
    expect(filler).not.toContain('GEZDGNBV');
    const plain = (await request(urls(await server.issue(profile)).filler, { origin: ORIGIN })).text;
    expect(plain).toContain('"totp":false');
    expect(plain).toContain('const codeNonce = null;');
  });

  it('hands out the current code once, to the profile origin, and only to the run that loaded the filler (#1 review)', async () => {
    server = new BridgeServer({ now: () => NOW });
    const ticket = await server.issue(totpProfile);
    const nonce = await startRun(ticket);
    for (const wrong of [undefined, 'guess', nonce.slice(1)]) {
      const refused = await askCode(ticket, wrong);
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.text)).toMatchObject({ status: 'refused' });
    }
    expect((await askCode(ticket, nonce, 'https://evil.test')).status).toBe(403);
    expect((await request(codeUrl(ticket), { origin: ORIGIN })).status).toBe(405);
    const ok = await askCode(ticket, nonce);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(ok.text)).toEqual({ code: totpCode(totpProfile.totp!, NOW) });
    const again = await askCode(ticket, nonce);
    expect(again.status).toBe(409);
    expect(JSON.parse(again.text)).toMatchObject({ status: 'already_used' });
  });

  it('gives no code once the run reported its outcome (#1 review)', async () => {
    server = new BridgeServer({ now: () => NOW });
    const ticket = await server.issue(totpProfile);
    const nonce = await startRun(ticket);
    await request(urls(ticket).result, { method: 'POST', body: JSON.stringify({ status: 'failed', url: `${ORIGIN}/` }) });
    const late = await askCode(ticket, nonce);
    expect(late.status).toBe(410);
    expect(JSON.parse(late.text)).toMatchObject({ status: 'finished' });
  });

  it('gives a run that started a fresh time window, for a code step late in a long login (#1 review)', async () => {
    let now = NOW;
    server = new BridgeServer({ now: () => now });
    const ticket = await server.issue(totpProfile);
    now += 50_000;
    const nonce = await startRun(ticket);
    now += 40_000; // 90 s after the script was issued, 40 s into the run
    expect((await request(urls(ticket).credentials, { method: 'POST', origin: ORIGIN })).status).toBe(200);
    expect((await askCode(ticket, nonce)).status).toBe(200);
  });

  it('waits for the next code when the current one is about to expire', async () => {
    let now = 1_700_000_039_000; // 1 s before the next step
    const sleep = vi.fn(async (ms: number) => void (now += ms));
    server = new BridgeServer({ now: () => now, sleep });
    const ticket = await server.issue(totpProfile);
    const nonce = await startRun(ticket);
    expect(JSON.parse((await askCode(ticket, nonce)).text)).toEqual({ code: totpCode(totpProfile.totp!, 1_700_000_040_050) });
    expect(sleep).toHaveBeenCalledWith(1_050);
  });

  it('waits with a real timer by default', async () => {
    // A clock that runs in real time from 600 ms before a step boundary: the code asked for then is about to expire.
    const boundary = 1_700_000_040_000;
    const start = Date.now();
    server = new BridgeServer({ now: () => boundary - 600 + (Date.now() - start) });
    const ticket = await server.issue(totpProfile);
    const nonce = await startRun(ticket);
    const { code } = JSON.parse((await askCode(ticket, nonce)).text) as { code: string };
    expect(code).toBe(totpCode(totpProfile.totp!, boundary));
    expect(code).not.toBe(totpCode(totpProfile.totp!, boundary - 600));
  });

  it('gives a code to a script on a code page of its own only during a login (#1 review 2)', async () => {
    let step: 'after_password' | 'after_code' | null = null;
    server = new BridgeServer({ now: () => NOW, codeStepContext: () => step });
    const askCodeOnly = (ticket: BridgeTicket, nonce: string) => request(codeUrl(ticket), { method: 'POST', origin: ORIGIN, body: JSON.stringify({ nonce, codeOnly: true }) });
    for (const value of [null, 'after_code'] as const) {
      step = value;
      const ticket = await server.issue(totpProfile);
      const nonce = await startRun(ticket);
      const refused = await askCodeOnly(ticket, nonce);
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.text)).toMatchObject({ status: 'refused', hint: expect.stringContaining('no login') });
    }
    step = 'after_password';
    const ticket = await server.issue(totpProfile);
    const script = (await request(urls(ticket).filler, { origin: ORIGIN })).text;
    expect(script).toContain('"codeStep":"after_password"');
    const nonce = /const codeNonce = "([\w-]+)";/.exec(script)![1]!;
    expect(JSON.parse((await askCodeOnly(ticket, nonce)).text)).toEqual({ code: totpCode(totpProfile.totp!, NOW) });
  });

  it('has no code for a profile without a TOTP secret', async () => {
    server = new BridgeServer();
    const ticket = await server.issue(profile);
    await startRun(ticket).catch(() => null);
    const none = await askCode(ticket, 'anything');
    expect(none.status).toBe(404);
    expect(JSON.parse(none.text)).toMatchObject({ status: 'no_totp' });
  });
});
