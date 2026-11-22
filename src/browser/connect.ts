import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import type { Env } from '../paths.js';
import { adaptBrowser, type BrowserLike } from './adapter.js';

export interface Endpoint {
  kind: 'ws' | 'http';
  url: string;
}

export const NOT_CONNECTED_HINT =
  'Chrome remote debugging is not available. In Chrome (144+) open chrome://inspect/#remote-debugging, turn it on, ' +
  'then retry and click "Allow" when Chrome asks. Alternatively set AUTOLOGIN_CDP_URL in the credentials file ' +
  'to a Chrome started with --remote-debugging-port.';

export class BrowserNotConnectedError extends Error {}

/** Chrome profile directories that may contain a DevToolsActivePort file, per OS. */
export function chromeUserDataDirs(platform: NodeJS.Platform, home: string, env: Env): string[] {
  if (platform === 'darwin') {
    const base = path.posix.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Chromium'].map((d) => path.posix.join(base, d));
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
    return ['Google\\Chrome', 'Google\\Chrome Beta', 'Google\\Chrome Dev', 'Google\\Chrome SxS', 'Chromium'].map((d) =>
      path.win32.join(base, d, 'User Data'),
    );
  }
  const base = env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium'].map((d) => path.posix.join(base, d));
}

/** Reads the newest DevToolsActivePort file written by a Chrome with remote debugging enabled. */
export async function readDevToolsActivePort(dirs: string[]): Promise<string | null> {
  let best: { url: string; mtime: number } | null = null;
  for (const dir of dirs) {
    const file = path.join(dir, 'DevToolsActivePort');
    try {
      const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      const [port = '', wsPath = ''] = text.split(/\r?\n/).map((line) => line.trim());
      if (!/^\d+$/.test(port) || !wsPath.startsWith('/devtools/browser/')) continue;
      if (best === null || stat.mtimeMs > best.mtime) best = { url: `ws://127.0.0.1:${port}${wsPath}`, mtime: stat.mtimeMs };
    } catch {
      // This Chrome is not running with remote debugging.
    }
  }
  return best?.url ?? null;
}

export async function resolveEndpoint(cdpUrl: string | undefined, dirs: string[]): Promise<Endpoint | null> {
  if (cdpUrl) return { kind: /^wss?:/i.test(cdpUrl) ? 'ws' : 'http', url: cdpUrl };
  const ws = await readDevToolsActivePort(dirs);
  return ws === null ? null : { kind: 'ws', url: ws };
}

export async function connectPuppeteer(endpoint: Endpoint): Promise<BrowserLike> {
  // defaultViewport: null keeps puppeteer from resizing the user's tabs.
  const browser = await puppeteer.connect(
    endpoint.kind === 'ws'
      ? { browserWSEndpoint: endpoint.url, defaultViewport: null }
      : { browserURL: endpoint.url, defaultViewport: null },
  );
  return adaptBrowser(browser);
}

export interface BrowserManagerOptions {
  getCdpUrl(): Promise<string | undefined>;
  dirs: string[];
  connect?: (endpoint: Endpoint) => Promise<BrowserLike>;
  /** How long to wait for Chrome (and its "Allow" prompt) before giving up. */
  connectTimeoutMs?: number;
}

/** Resolves like `promise`, or rejects after `ms`; a late connection is closed instead of leaking. */
export function withTimeout(promise: Promise<BrowserLike>, ms: number): Promise<BrowserLike> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`no answer within ${Math.round(ms / 1000)}s (was the "Allow" prompt dismissed?)`));
    }, ms);
    promise.then(
      (browser) => {
        clearTimeout(timer);
        if (timedOut) void browser.disconnect().catch(() => undefined);
        else resolve(browser);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Keeps a single, lazily opened connection so Chrome asks for permission once per session. */
export class BrowserManager {
  private current: Promise<BrowserLike> | null = null;

  constructor(private readonly options: BrowserManagerOptions) {}

  get(): Promise<BrowserLike> {
    this.current ??= this.open().catch((error: unknown) => {
      this.current = null;
      throw error;
    });
    return this.current;
  }

  private async open(): Promise<BrowserLike> {
    const endpoint = await resolveEndpoint(await this.options.getCdpUrl(), this.options.dirs);
    if (endpoint === null) throw new BrowserNotConnectedError(NOT_CONNECTED_HINT);
    let browser: BrowserLike;
    try {
      browser = await withTimeout((this.options.connect ?? connectPuppeteer)(endpoint), this.options.connectTimeoutMs ?? 20_000);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BrowserNotConnectedError(`Could not connect to Chrome at ${endpoint.url} (${reason}). ${NOT_CONNECTED_HINT}`);
    }
    browser.onDisconnected(() => {
      this.current = null;
    });
    return browser;
  }

  async dispose(): Promise<void> {
    const pending = this.current;
    this.current = null;
    if (pending === null) return;
    const browser = await pending.catch(() => null);
    await browser?.disconnect().catch(() => undefined);
  }
}
