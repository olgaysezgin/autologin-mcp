import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REUSED_NOTE, type BridgeResult } from '../../src/bridge/filler.ts';
import { BridgeServer } from '../../src/bridge/server.ts';
import { BrowserManager, connectPuppeteer } from '../../src/browser/connect.ts';
import { selectTarget } from '../../src/browser/tabs.ts';
import { performLogin, type LoginResult, type LoginTiming } from '../../src/login/engine.ts';
import { createDefaultDeps } from '../../src/serve.ts';
import { createServer } from '../../src/server.ts';
import { buildStore, isUsable, type UsableProfile } from '../../src/store/profiles.ts';
import { launchChrome, type TestChrome } from '../helpers/chrome.ts';
import { startFixtureServer, VALID, type FixtureServer } from '../helpers/fixture-server.ts';

const FAST: LoginTiming = { detectTimeoutMs: 3_000, verifyTimeoutMs: 5_000, pollMs: 100, earlyFailAfterMs: 400 };

let chrome: TestChrome;
let app: FixtureServer;
/** A second CDP client that plays the role of Claude in Chrome: it opens and drives the tabs. */
let driver: Browser;
let manager: BrowserManager;

beforeAll(async () => {
  chrome = await launchChrome();
  app = await startFixtureServer();
  driver = await puppeteer.connect({ browserWSEndpoint: chrome.wsEndpoint, defaultViewport: null });
  manager = new BrowserManager({ getCdpUrl: async () => undefined, dirs: [chrome.userDataDir] });
});

afterEach(async () => {
  for (const page of await driver.pages()) if (page.url() !== 'about:blank') await page.close();
});

afterAll(async () => {
  await manager.dispose();
  await driver.disconnect();
  await chrome.close();
  await app.close();
});

function profile(extra: Record<string, string> = {}, password = VALID.password): UsableProfile {
  const store = buildStore({ APP_URL: new URL(app.origin).host, APP_USERNAME: VALID.username, APP_PASSWORD: password, ...extra });
  const p = store.profiles[0]!;
  if (!isUsable(p)) throw new Error(p.problems.join('; '));
  return p;
}

async function open(file: string): Promise<Page> {
  const page = await driver.newPage();
  await page.goto(`${app.origin}/${file}`);
  return page;
}

async function loginOn(file: string, p: UsableProfile, timing: LoginTiming = FAST): Promise<{ tab: Page; result: LoginResult }> {
  const tab = await open(file);
  const browser = await manager.get();
  const selection = await selectTarget(browser.targets(), [p], { url: tab.url() });
  if (!selection.ok) throw new Error(JSON.stringify(selection.result));
  return { tab, result: await performLogin(selection.page, selection.profile, timing) };
}

describe('login engine in a real Chrome (auto-connect via DevToolsActivePort)', () => {
  it('logs into a classic server-rendered form and types the exact password', async () => {
    const { result } = await loginOn('plain.html', profile());
    expect(result).toMatchObject({ status: 'success', profile: 'app' });
    expect(result.url).toMatch(/\/dashboard\.html$/);
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('reports a wrong password with the page error and clears the password field', async () => {
    const { tab, result } = await loginOn('plain.html', profile({}, 'wrong-password'));
    expect(result).toMatchObject({ status: 'failed', reason: 'still_on_login_form', hint: 'Invalid email or password' });
    expect(await tab.$eval('input[type="password"]', (el) => (el as HTMLInputElement).value)).toBe('');
  });

  it('logs into an identifier-first page that swaps the form in place', async () => {
    const { result } = await loginOn('two-step.html', profile());
    expect(result).toMatchObject({ status: 'success', profile: 'app' });
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('fills a one-page form whose password field mounts after the email field in one submit', async () => {
    const { tab, result } = await loginOn('staggered.html', profile());
    expect(result).toMatchObject({ status: 'success', profile: 'app' });
    expect(app.received.at(-1)).toEqual(VALID);
    expect(await tab.evaluate('window.submits')).toBe(1);
  });

  it('logs into an identifier-first page behind an expired-session alert, with a slow password step', async () => {
    const { result } = await loginOn('two-step-slow.html', profile());
    expect(result).toMatchObject({ status: 'success', profile: 'app' });
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('hands single sign-on and captcha pages to a human, and reports a code step after the password (#2)', async () => {
    const quick = { ...FAST, detectTimeoutMs: 800 };
    const before = app.received.length;
    expect((await loginOn('sso.html', profile(), quick)).result).toMatchObject({ status: 'needs_human', reason: 'sso' });
    expect((await loginOn('captcha.html', profile(), quick)).result).toMatchObject({ status: 'needs_human', reason: 'captcha' });
    expect(app.received.length).toBe(before);
    const { result } = await loginOn('mfa.html', profile());
    expect(result).toMatchObject({ status: 'needs_human', reason: 'mfa_required', hint: expect.stringContaining('one-time code') });
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('types nothing on another site when the username step leads there', async () => {
    const other = await startFixtureServer(); // another port: another site, like a single sign-on host
    try {
      const before = app.received.length;
      const { tab, result } = await loginOn(`cross-site.html?to=${encodeURIComponent(`${other.origin}/plain.html`)}`, profile());
      expect(result).toMatchObject({ status: 'needs_human', reason: 'left_profile_site', hint: expect.stringContaining('nothing was typed there') });
      expect(new URL(tab.url()).origin).toBe(other.origin);
      expect(await tab.$eval('input[type="password"]', (el) => (el as HTMLInputElement).value)).toBe('');
      expect(other.received).toEqual([]);
      expect(app.received.length).toBe(before);
      await tab.close();
    } finally {
      await other.close();
    }
  });

  it('works with controlled inputs that only update on input events (React-like)', async () => {
    const { result } = await loginOn('controlled.html', profile());
    expect(result.status).toBe('success');
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('presses Enter when there is no submit button', async () => {
    const { result } = await loginOn('enter.html', profile());
    expect(result.status).toBe('success');
    expect(result.url).toMatch(/\/dashboard\.html$/);
  });

  it('waits for a login form that renders late', async () => {
    const { result } = await loginOn('late.html', profile());
    expect(result.status).toBe('success');
  });

  it('uses explicit selectors and a success selector for unusual layouts', async () => {
    const selectors = {
      APP_USERNAME_SELECTOR: '#login-name',
      APP_PASSWORD_SELECTOR: '#secret',
      APP_SUBMIT_SELECTOR: '#go',
      APP_SUCCESS_SELECTOR: '#welcome',
    };
    const { result } = await loginOn('custom.html', profile(selectors));
    expect(result.status).toBe('success');
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('gives up when the heuristic cannot submit an unusual layout', async () => {
    const { result } = await loginOn('custom.html', profile(), { ...FAST, verifyTimeoutMs: 800 });
    expect(result).toMatchObject({ status: 'failed', reason: 'still_on_login_form' });
    expect(result.hint).toMatch(/Still on the login form/);
  });

  it('reports pages without a login form', async () => {
    const { result } = await loginOn('dashboard.html', profile(), { ...FAST, detectTimeoutMs: 300 });
    expect(result.status).toBe('no_login_form');
  });

  it('connects through an http endpoint (AUTOLOGIN_CDP_URL) too', async () => {
    const browser = await connectPuppeteer({ kind: 'http', url: chrome.httpEndpoint });
    expect(browser.targets().some((t) => t.type() === 'page')).toBe(true);
    await browser.disconnect();
  });

  it('exposes only page targets as pages and returns null for missing elements', async () => {
    await open('dashboard.html');
    const browser = await manager.get();
    const targets = browser.targets();
    const nonPage = targets.find((t) => t.type() !== 'page');
    expect(nonPage).toBeDefined();
    expect(await nonPage!.page()).toBeNull();
    const page = await targets.find((t) => t.url().endsWith('/dashboard.html'))!.page();
    expect(await page!.element('#does-not-exist')).toBeNull();
  });
});

describe('bridge mode in a real Chrome (autologin-mcp has no CDP access)', () => {
  let bridge: BridgeServer;
  const reports: Array<[string, BridgeResult]> = [];
  beforeAll(() => {
    bridge = new BridgeServer({ timing: FAST, onResult: (profileName, result) => reports.push([profileName, result]) });
  });
  afterAll(async () => {
    await bridge.close();
  });

  /** Runs the agent snippet in the tab, exactly like Claude in Chrome's javascript_tool would. */
  async function bridgeOn(file: string, p: UsableProfile, ticketFn?: string) {
    const tab = await open(file);
    const fn = ticketFn ?? (await bridge.issue(p)).function;
    const result = (await tab.evaluate(`(${fn})()`)) as BridgeResult & { status: string };
    return { tab, result, fn };
  }

  it('logs into a SPA with controlled inputs', async () => {
    const { result } = await bridgeOn('controlled.html', profile());
    expect(result).toMatchObject({ status: 'success' });
    expect(app.received.at(-1)).toEqual(VALID);
    await vi.waitFor(() => expect(reports.at(-1)).toEqual(['app', expect.objectContaining({ status: 'success' })]));
  });

  it('reports "submitted" for a classic form that navigates, and the app logs in', async () => {
    const { tab, result } = await bridgeOn('plain.html', profile());
    expect(result.status).toBe('submitted');
    await tab.waitForFunction(() => location.pathname === '/dashboard.html');
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('reports a wrong password with the page error, clears the field and tells the server', async () => {
    const { tab, result } = await bridgeOn('controlled.html', profile({}, 'wrong-password'));
    expect(result).toMatchObject({ status: 'failed', hint: 'Invalid credentials' });
    expect(await tab.$eval('#pass', (el) => (el as HTMLInputElement).value)).toBe('');
    await vi.waitFor(() => expect(reports.at(-1)![1].status).toBe('failed'));
  });

  it('handles an identifier-first page in bridge mode', async () => {
    const { result } = await bridgeOn('two-step.html', profile());
    expect(result.status).toBe('success');
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('fills a staggered one-page form in one submit, and an identifier-first page behind an alert', async () => {
    const staggered = await bridgeOn('staggered.html', profile());
    expect(staggered.result.status).toBe('success');
    expect(app.received.at(-1)).toEqual(VALID);
    expect(await staggered.tab.evaluate('window.submits')).toBe(1);
    const slow = await bridgeOn('two-step-slow.html', profile());
    expect(slow.result.status).toBe('success');
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('never fetches the credentials on single sign-on or captcha pages, and reports a code step (#2)', async () => {
    const run = async (file: string) => {
      const tab = await open(file);
      const asked: string[] = [];
      tab.on('request', (request) => {
        if (request.url().includes('/v1/credentials/')) asked.push(request.url());
      });
      const fn = (await bridge.issue(profile())).function;
      const result = await tab.evaluate(`(${fn})()`);
      await tab.close();
      return { result, asked };
    };
    // Control: on a normal login page the same listener does see the credentials request.
    expect(await run('controlled.html')).toMatchObject({ result: { status: 'success' }, asked: [expect.stringContaining('/v1/credentials/')] });
    for (const [file, reason] of [['sso.html', 'sso'], ['captcha.html', 'captcha']] as const) {
      expect(await run(file)).toEqual({ result: expect.objectContaining({ status: 'needs_human', reason }), asked: [] });
    }
    const { result } = await bridgeOn('mfa.html', profile());
    expect(result).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
    expect(app.received.at(-1)).toEqual(VALID);
  });

  it('runs a script once: after a run that found no form, a re-run types nothing (#2 review)', async () => {
    const before = app.received.length;
    const tab = await open('dashboard.html');
    const fn = (await bridge.issue(profile())).function;
    expect(await tab.evaluate(`(${fn})()`)).toMatchObject({ status: 'no_login_form' });
    await tab.goto(`${app.origin}/controlled.html`);
    expect(await tab.evaluate(`(${fn})()`)).toMatchObject({ status: 'no_login_form', note: expect.stringContaining('already ran') });
    expect(await tab.$eval('#user', (el) => (el as HTMLInputElement).value)).toBe('');
    expect(app.received.length).toBe(before);
    await tab.close();
  });

  it('reports a username step that leads to another site as the username only, and sends no password', async () => {
    const other = await startFixtureServer();
    try {
      const before = app.received.length;
      const tab = await open(`cross-site.html?to=${encodeURIComponent(`${other.origin}/plain.html`)}`);
      const fn = (await bridge.issue(profile())).function;
      const result = await tab.evaluate(`(${fn})()`).catch(() => null);
      // The page navigates away, so the agent's call may be cut off; the page still reported the outcome.
      await vi.waitFor(() => expect(reports.at(-1)).toEqual(['app', expect.objectContaining({ status: 'submitted', reason: 'username_step_navigated' })]));
      if (result !== null) expect(result).toMatchObject({ status: 'submitted', reason: 'username_step_navigated' });
      expect(other.received).toEqual([]);
      expect(app.received.length).toBe(before);
      await tab.close();
    } finally {
      await other.close();
    }
  });

  it('handles Enter-to-submit pages and explicit selectors', async () => {
    // enter.html navigates on Enter, so the evaluate call can be cut off (as an agent's can); the page still reports.
    const reported = reports.length;
    const tab = await open('enter.html');
    const fn = (await bridge.issue(profile())).function;
    const direct = (await tab.evaluate(`(${fn})()`).catch(() => null)) as { status: string } | null;
    await vi.waitFor(() => expect(reports.slice(reported)).toEqual([['app', expect.objectContaining({ status: 'submitted' })]]));
    if (direct !== null) expect(direct.status).toBe('submitted');
    const selectors = { APP_USERNAME_SELECTOR: '#login-name', APP_PASSWORD_SELECTOR: '#secret', APP_SUBMIT_SELECTOR: '#go', APP_SUCCESS_SELECTOR: '#welcome' };
    expect((await bridgeOn('custom.html', profile(selectors))).result.status).toBe('success');
  });

  it('refuses to fill a page of another site and works only once', async () => {
    const other = buildStore({ OTHER_URL: 'other.test', OTHER_USERNAME: 'u', OTHER_PASSWORD: 'p' }).profiles[0] as UsableProfile;
    const { result: mismatch } = await bridgeOn('plain.html', other);
    expect(mismatch).toMatchObject({ status: 'origin_mismatch' });

    const { fn, result: first } = await bridgeOn('controlled.html', profile());
    expect(first.status).toBe('success');
    const { tab, result: second } = await bridgeOn('controlled.html', profile(), fn);
    expect(second).toMatchObject({ status: 'success', note: REUSED_NOTE });
    expect(await tab.$eval('#pass', (el) => (el as HTMLInputElement).value)).toBe('');
  });
});

describe('MCP server end to end', () => {
  it('returns a run_in_page script in bridge mode that logs the tab in', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-e2e-'));
    await fs.writeFile(
      path.join(dir, 'credentials.env'),
      [`APP_URL=${new URL(app.origin).host}`, `APP_USERNAME=${VALID.username}`, `APP_PASSWORD=\`${VALID.password}\``, 'AUTOLOGIN_MODE=bridge'].join('\n'),
    );
    const { deps, browser, bridge } = createDefaultDeps({ env: { AUTOLOGIN_HOME: dir }, home: dir, platform: process.platform, bridge: { timing: FAST } });
    const server = createServer(deps);
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tab = await open('controlled.html');
    const login = await client.callTool({ name: 'login', arguments: { url: tab.url() } });
    const text = (login.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain(VALID.password);
    const body = JSON.parse(text) as { status: string; script: string; expression: string };
    expect(body.status).toBe('run_in_page');
    // Puppeteer's page.evaluate has no top-level await: `script` fails there, `expression` is the form it takes.
    await expect(tab.evaluate(body.script)).rejects.toThrow('await is not defined');
    expect(await tab.evaluate(body.expression)).toMatchObject({ status: 'success' });
    expect(app.received.at(-1)).toEqual(VALID);
    await vi.waitFor(async () => {
      const status = await client.callTool({ name: 'login_status', arguments: { profile: 'app' } });
      expect(JSON.parse((status.content as Array<{ text: string }>)[0]!.text).results).toEqual([expect.objectContaining({ status: 'success', via: 'bridge' })]);
    });

    // The agent did not get that result (its JavaScript call was cut off) and logs in again on the logged-in app.
    const home = await open('dashboard.html');
    const again = JSON.parse((((await client.callTool({ name: 'login', arguments: { url: home.url() } })).content) as Array<{ text: string }>)[0]!.text) as {
      function: string;
    };
    const previous = { status: 'success', at: expect.any(String), url: expect.stringContaining('/controlled.html') };
    expect(await home.evaluate(`(${again.function})()`)).toMatchObject({
      status: 'no_login_form',
      hint: expect.stringContaining('already logged in'),
      previous_login: previous,
    });
    await vi.waitFor(async () => {
      const status = await client.callTool({ name: 'login_status', arguments: { profile: 'app' } });
      expect(JSON.parse((status.content as Array<{ text: string }>)[0]!.text).results).toEqual([
        expect.objectContaining({ status: 'no_login_form', hint: expect.stringContaining('already logged in'), previous_login: previous }),
      ]);
    });

    await client.close();
    await Promise.all([browser.dispose(), bridge.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('logs a tab in through the login tool without the password reaching the client', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-e2e-'));
    await fs.writeFile(
      path.join(dir, 'credentials.env'),
      [`APP_URL=${new URL(app.origin).host}`, `APP_USERNAME=${VALID.username}`, `APP_PASSWORD=\`${VALID.password}\``, `AUTOLOGIN_CDP_URL=${chrome.wsEndpoint}`].join('\n'),
    );
    const { deps, browser } = createDefaultDeps({ env: { AUTOLOGIN_HOME: dir }, home: dir, platform: process.platform });
    const server = createServer(deps);
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tab = await open('plain.html');
    const login = await client.callTool({ name: 'login', arguments: { url: tab.url() } });
    const listed = await client.callTool({ name: 'list_profiles', arguments: {} });
    const loginText = (login.content as Array<{ text: string }>)[0]!.text;
    const listText = (listed.content as Array<{ text: string }>)[0]!.text;

    expect(JSON.parse(loginText)).toMatchObject({ status: 'success', profile: 'app' });
    expect(JSON.parse(listText).profiles).toEqual([{ profile: 'app', url: new URL(app.origin).host, username: VALID.username }]);
    for (const text of [loginText, listText]) expect(text).not.toContain(VALID.password);

    await client.close();
    await browser.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
