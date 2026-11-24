import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserLike, TargetLike } from '../src/browser/adapter.ts';
import type { LoginResult, PageLike } from '../src/login/engine.ts';
import { FailureLimiter } from '../src/ratelimit.ts';
import { ResultLog } from '../src/results.ts';
import { ADD_HINT, createServer, INSTRUCTIONS, RUN_IN_PAGE_HINT, type ServerDeps } from '../src/server.ts';
import type { LoadedStore } from '../src/store/envfile.ts';
import { buildStore } from '../src/store/profiles.ts';

const SECRET = 'Sup3r-S3cret';

function store(vars: Record<string, string>): LoadedStore {
  return { ...buildStore(vars), file: '/home/me/.autologin-mcp/credentials.env', exists: true };
}

const APP = { APP_URL: 'app.test', APP_USERNAME: 'qa', APP_PASSWORD: SECRET };

function target(url: string): TargetLike {
  const page = { url: () => url } as PageLike;
  return { type: () => 'page', url: () => url, page: async () => page };
}

function browserWith(...urls: string[]): BrowserLike {
  return { targets: () => urls.map(target), disconnect: async () => undefined, onDisconnected: () => undefined };
}

const bridge = {
  issue: vi.fn(async (profile: { name: string }) => ({
    profile: profile.name,
    expiresInSeconds: 60,
    function: `async () => 'run ${profile.name}'`,
    script: `await (async () => 'run ${profile.name}')()`,
    expression: `(async () => 'run ${profile.name}')()`,
  })),
};

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    version: '9.9.9',
    configFile: '/home/me/.autologin-mcp/credentials.env',
    loadStore: async () => store(APP),
    getBrowser: async () => browserWith('https://app.test/login'),
    login: async (_page, profile) => ({ status: 'success', profile: profile.name, url: 'https://app.test/home' }),
    bridge,
    results: new ResultLog(),
    openConfig: async () => ({ created: false }),
    limiter: new FailureLimiter(),
    ...overrides,
  };
}

let client: Client | null = null;
afterEach(async () => {
  await client?.close();
  client = null;
});

async function connect(deps: ServerDeps): Promise<Client> {
  const server = createServer(deps);
  client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  expect(text).not.toContain(SECRET);
  return { body: JSON.parse(text) as Record<string, unknown>, isError: result.isError };
}

describe('MCP server', () => {
  it('announces instructions, version and three tools', async () => {
    const c = await connect(makeDeps());
    expect(c.getInstructions()).toBe(INSTRUCTIONS);
    expect(c.getServerVersion()).toMatchObject({ name: 'autologin', version: '9.9.9' });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_profiles', 'login', 'login_status', 'open_config']);
  });

  it('reports the latest login outcomes, redacted', async () => {
    const results = new ResultLog(() => 0);
    const c = await connect(makeDeps({ results }));
    expect((await call(c, 'login_status')).body).toEqual({ results: [], hint: expect.stringContaining('No login result') });
    await call(c, 'login');
    results.record('other', { status: 'failed', hint: `leaked ${SECRET}` }, 'bridge');
    expect((await call(c, 'login_status')).body).toEqual({
      results: [
        { profile: 'app', status: 'success', url: 'https://app.test/home', via: 'cdp', at: '1970-01-01T00:00:00.000Z' },
        { profile: 'other', status: 'failed', hint: 'leaked [REDACTED]', via: 'bridge', at: '1970-01-01T00:00:00.000Z' },
      ],
    });
    expect((await call(c, 'login_status', { profile: 'App' })).body).toEqual({ results: [expect.objectContaining({ profile: 'app' })] });
  });

  it('lists profiles without passwords, including problems', async () => {
    const c = await connect(makeDeps({ loadStore: async () => store({ ...APP, BAD_URL: 'x.test' }) }));
    expect((await call(c, 'list_profiles')).body).toEqual({
      file: '/home/me/.autologin-mcp/credentials.env',
      profiles: [
        { profile: 'app', url: 'app.test', username: 'qa' },
        { profile: 'bad', url: 'x.test', username: null, problems: ['BAD_USERNAME is missing', 'BAD_PASSWORD is missing'] },
      ],
    });
  });

  it('hints how to add a profile when there is none', async () => {
    const c = await connect(makeDeps({ loadStore: async () => store({}) }));
    expect((await call(c, 'list_profiles')).body).toMatchObject({ profiles: [], hint: ADD_HINT });
  });

  it('logs in the matching tab', async () => {
    const login = vi.fn(async (page: PageLike, profile: { name: string }): Promise<LoginResult> => ({ status: 'success', profile: profile.name, url: page.url() }));
    const c = await connect(makeDeps({ login }));
    expect(await call(c, 'login')).toEqual({ body: { status: 'success', profile: 'app', url: 'https://app.test/login' }, isError: false });
    expect((await call(c, 'login', { profile: 'APP', url: 'https://app.test/login' })).body).toMatchObject({ status: 'success' });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('explains a missing login form when the previous login already went through', async () => {
    const outcomes: LoginResult[] = [
      { status: 'success', profile: 'app', url: 'https://app.test/home' },
      { status: 'no_login_form', profile: 'app', url: 'https://app.test/home', hint: 'No visible password field was found on the page.' },
    ];
    const c = await connect(makeDeps({ login: async () => outcomes.shift()!, results: new ResultLog(() => Date.UTC(2026, 10, 22, 12)) }));
    expect((await call(c, 'login')).body).not.toHaveProperty('previous_login');
    expect((await call(c, 'login')).body).toEqual({
      status: 'no_login_form',
      profile: 'app',
      url: 'https://app.test/home',
      hint: expect.stringContaining('already logged in'),
      previous_login: { status: 'success', at: '2026-11-22T12:00:00.000Z', url: 'https://app.test/home' },
    });
  });

  it('validates the requested profile', async () => {
    const c = await connect(makeDeps({ loadStore: async () => store({ ...APP, BAD_URL: 'x.test' }) }));
    expect((await call(c, 'login', { profile: 'ghost' })).body).toMatchObject({ status: 'no_profile', candidates: ['app', 'bad'] });
    expect((await call(c, 'login', { profile: 'BAD' })).body).toEqual({
      status: 'invalid_profile',
      profile: 'bad',
      hint: 'BAD_USERNAME is missing; BAD_PASSWORD is missing',
    });
  });

  it('reports a missing configuration, and a missing browser in cdp mode', async () => {
    const empty = await connect(makeDeps({ loadStore: async () => store({}) }));
    expect((await call(empty, 'login')).body).toMatchObject({ status: 'no_profile', hint: expect.stringContaining('No usable profile') });
    await empty.close();
    const cdpOnly = async () => store({ ...APP, AUTOLOGIN_MODE: 'cdp' });
    const offline = await connect(makeDeps({ loadStore: cdpOnly, getBrowser: async () => Promise.reject(new Error('enable remote debugging')) }));
    expect((await call(offline, 'login')).body).toEqual({ status: 'browser_not_connected', hint: 'enable remote debugging' });
    await offline.close();
    const odd = await connect(makeDeps({ loadStore: cdpOnly, getBrowser: async () => Promise.reject('raw') }));
    expect((await call(odd, 'login')).body).toEqual({ status: 'browser_not_connected', hint: 'raw' });
  });

  it('passes tab selection problems through in cdp mode', async () => {
    const c = await connect(makeDeps({ loadStore: async () => store({ ...APP, AUTOLOGIN_MODE: 'cdp' }), getBrowser: async () => browserWith('https://other.test/') }));
    expect((await call(c, 'login')).body).toMatchObject({ status: 'no_matching_tab' });
  });

  it('falls back to the bridge when Chrome is not reachable or the tab is not in it (auto mode)', async () => {
    const offline = await connect(makeDeps({ getBrowser: async () => Promise.reject(new Error('no remote debugging')) }));
    expect(await call(offline, 'login', { url: 'https://app.test/login' })).toEqual({
      body: {
        status: 'run_in_page',
        profile: 'app',
        hint: RUN_IN_PAGE_HINT,
        expires_in_s: 60,
        script: "await (async () => 'run app')()",
        function: "async () => 'run app'",
        expression: "(async () => 'run app')()",
      },
      isError: false,
    });
    await offline.close();
    const elsewhere = await connect(makeDeps({ getBrowser: async () => browserWith('https://other.test/') }));
    expect((await call(elsewhere, 'login')).body).toMatchObject({ status: 'run_in_page' });
  });

  it('keeps CDP answers that are not about reachability', async () => {
    const two = await connect(makeDeps({ getBrowser: async () => browserWith('https://app.test/a', 'https://app.test/b') }));
    expect((await call(two, 'login')).body).toMatchObject({ status: 'ambiguous_tab' });
  });

  it('never touches Chrome in bridge mode and picks the profile from the arguments', async () => {
    const getBrowser = vi.fn(async () => browserWith('https://app.test/login'));
    const vars = {
      AUTOLOGIN_MODE: 'bridge',
      ADMIN_URL: 'app.test',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: SECRET,
      VIEWER_URL: 'app.test',
      VIEWER_USERNAME: 'viewer',
      VIEWER_PASSWORD: 'p2',
      LOCAL_URL: 'localhost:3000',
      LOCAL_USERNAME: 'me',
      LOCAL_PASSWORD: 'p3',
    };
    const c = await connect(makeDeps({ getBrowser, loadStore: async () => store(vars) }));
    expect((await call(c, 'login', { url: 'http://localhost:3000/login' })).body).toMatchObject({ status: 'run_in_page', profile: 'local' });
    expect((await call(c, 'login', { url: 'https://app.test/login', profile: 'Viewer' })).body).toMatchObject({ status: 'run_in_page', profile: 'viewer' });
    expect((await call(c, 'login', { profile: 'admin' })).body).toMatchObject({ status: 'run_in_page', profile: 'admin' });
    expect((await call(c, 'login', { url: 'https://app.test/login' })).body).toMatchObject({ status: 'ambiguous_profile', candidates: ['admin', 'viewer'] });
    expect((await call(c, 'login')).body).toMatchObject({ status: 'ambiguous_profile', candidates: ['admin', 'viewer', 'local'] });
    expect((await call(c, 'login', { url: 'https://evil.test/' })).body).toMatchObject({ status: 'origin_mismatch', hint: expect.stringContaining('evil.test does not match any profile') });
    expect((await call(c, 'login', { url: 'https://evil.test/', profile: 'LOCAL' })).body).toMatchObject({ hint: expect.stringContaining('does not match profile "local"') });
    expect(getBrowser).not.toHaveBeenCalled();
  });

  it('rate-limits bridge logins after repeated failures', async () => {
    const limiter = new FailureLimiter();
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('app');
    const c = await connect(makeDeps({ limiter, loadStore: async () => store({ ...APP, AUTOLOGIN_MODE: 'bridge' }) }));
    expect((await call(c, 'login')).body).toMatchObject({ status: 'rate_limited', profile: 'app' });
  });

  it('stops after repeated failures and flags errors', async () => {
    const results: LoginResult[] = [{ status: 'failed', hint: `wrong ${SECRET}` }, { status: 'error', hint: 'crashed' }, { status: 'failed' }];
    const c = await connect(makeDeps({ login: async () => results.shift()! }));
    expect(await call(c, 'login')).toEqual({ body: { status: 'failed', hint: 'wrong [REDACTED]' }, isError: false });
    expect((await call(c, 'login')).isError).toBe(true);
    await call(c, 'login');
    expect((await call(c, 'login')).body).toMatchObject({ status: 'rate_limited', profile: 'app' });
  });

  it('answers a tab on a known single sign-on host with needs_human instead of origin_mismatch (#2)', async () => {
    const c = await connect(makeDeps({ getBrowser: async () => Promise.reject(new Error('no remote debugging')) }));
    for (const url of ['https://accounts.google.com/v3/signin/identifier?continue=x', 'https://login.microsoftonline.com/common/oauth2/authorize', 'https://acme.okta.com/oauth2/v1/authorize']) {
      expect((await call(c, 'login', { url })).body).toMatchObject({ status: 'needs_human', reason: 'sso', url, hint: expect.stringContaining('single sign-on') });
    }
    expect((await call(c, 'login', { url: 'https://evil.test/' })).body).toMatchObject({ status: 'origin_mismatch' });
  });

  it('does not count needs_human toward the rate limit: no password was sent', async () => {
    const c = await connect(makeDeps({ login: async () => ({ status: 'needs_human', reason: 'password_step_timeout' }) }));
    for (let i = 0; i < 4; i += 1) expect((await call(c, 'login')).body).toMatchObject({ status: 'needs_human' });
  });

  it('turns unexpected exceptions into redacted errors', async () => {
    const c = await connect(makeDeps({ login: async () => Promise.reject(new Error(`boom ${SECRET}`)) }));
    expect(await call(c, 'login')).toEqual({ body: { status: 'error', hint: 'boom [REDACTED]' }, isError: true });
    await c.close();
    const broken = await connect(makeDeps({ loadStore: async () => Promise.reject('unreadable') }));
    expect(await call(broken, 'login')).toEqual({ body: { status: 'error', hint: 'unreadable' }, isError: true });
  });

  it('opens the credentials file for the user without returning it', async () => {
    const c = await connect(makeDeps({ openConfig: async () => ({ created: true }) }));
    expect(await call(c, 'open_config')).toEqual({
      body: expect.objectContaining({ file: '/home/me/.autologin-mcp/credentials.env', created: true, opened: true }),
      isError: false,
    });
    await c.close();
    const headless = await connect(makeDeps({ openConfig: async () => Promise.reject(new Error('no display')) }));
    expect(await call(headless, 'open_config')).toEqual({
      body: {
        file: '/home/me/.autologin-mcp/credentials.env',
        opened: false,
        hint: expect.stringMatching(/no display.*npx autologin-mcp add.*Do not read this file/),
      },
      isError: false,
    });
  });
});

describe('MCP server: TOTP profiles (#1)', () => {
  const TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vars = { ...APP, APP_TOTP_SECRET: ` ${TOTP} ` };

  it('lists which profiles have a TOTP secret, never the secret itself', async () => {
    const c = await connect(makeDeps({ loadStore: async () => store({ ...vars, BAD_URL: 'x.test', BAD_USERNAME: 'u', BAD_PASSWORD: 'bad-password', BAD_TOTP_SECRET: 'not base32!' }) }));
    const { body } = await call(c, 'list_profiles');
    expect(body.profiles).toEqual([
      { profile: 'app', url: 'app.test', username: 'qa', totp: true },
      { profile: 'bad', url: 'x.test', username: 'u', problems: ['BAD_TOTP_SECRET: not a base32 secret or an otpauth:// URI'] },
    ]);
    expect(JSON.stringify(body)).not.toContain(TOTP);
  });

  it('redacts the TOTP secret from login results, outcomes and errors', async () => {
    const results = new ResultLog(() => 0);
    const outcomes: LoginResult[] = [{ status: 'failed', reason: 'totp_rejected', hint: `secret ${TOTP} rejected` }];
    const uri = `otpauth://totp/App:qa?secret=${TOTP.toLowerCase()}&issuer=App`;
    const viaUri = await connect(makeDeps({ loadStore: async () => store({ ...APP, APP_TOTP_SECRET: uri }), login: async () => ({ status: 'failed', hint: `${uri} / ${TOTP.toLowerCase()}` }) }));
    expect((await call(viaUri, 'login')).body).toEqual({ status: 'failed', hint: '[REDACTED] / [REDACTED]' });
    await viaUri.close();
    const c = await connect(makeDeps({ results, loadStore: async () => store(vars), login: async () => outcomes.shift() ?? Promise.reject(new Error(`boom ${TOTP}`)) }));
    expect((await call(c, 'login')).body).toEqual({ status: 'failed', reason: 'totp_rejected', hint: 'secret [REDACTED] rejected' });
    expect((await call(c, 'login_status')).body).toEqual({ results: [expect.objectContaining({ hint: 'secret [REDACTED] rejected' })] });
    expect((await call(c, 'login')).body).toEqual({ status: 'error', hint: 'boom [REDACTED]' });
  });

  it('counts a rejected code toward the rate limit, like a wrong password', async () => {
    const c = await connect(makeDeps({ loadStore: async () => store(vars), login: async () => ({ status: 'failed', reason: 'totp_rejected' }) }));
    for (let i = 0; i < 3; i += 1) expect((await call(c, 'login')).body).toMatchObject({ status: 'failed', reason: 'totp_rejected' });
    expect((await call(c, 'login')).body).toMatchObject({ status: 'rate_limited' });
  });
});
