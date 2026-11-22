import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserLike } from '../src/browser/adapter.ts';
import {
  BrowserManager,
  BrowserNotConnectedError,
  chromeUserDataDirs,
  NOT_CONNECTED_HINT,
  readDevToolsActivePort,
  resolveEndpoint,
  withTimeout,
} from '../src/browser/connect.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-connect-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function portFile(name: string, content: string, mtime?: Date): Promise<string> {
  const d = path.join(dir, name);
  await fs.mkdir(d, { recursive: true });
  const file = path.join(d, 'DevToolsActivePort');
  await fs.writeFile(file, content);
  if (mtime) await fs.utimes(file, mtime, mtime);
  return d;
}

describe('chromeUserDataDirs', () => {
  it('lists profile folders per OS', () => {
    expect(chromeUserDataDirs('darwin', '/Users/me', {})[0]).toBe('/Users/me/Library/Application Support/Google/Chrome');
    expect(chromeUserDataDirs('win32', 'C:\\Users\\me', {})[0]).toBe('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data');
    expect(chromeUserDataDirs('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'D:\\Local' })[3]).toBe('D:\\Local\\Google\\Chrome SxS\\User Data');
    expect(chromeUserDataDirs('linux', '/home/me', {})).toContain('/home/me/.config/chromium');
    expect(chromeUserDataDirs('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })[0]).toBe('/cfg/google-chrome');
  });
});

describe('readDevToolsActivePort / resolveEndpoint', () => {
  it('returns the newest valid endpoint and skips broken files', async () => {
    const old = await portFile('old', '9222\n/devtools/browser/old\n', new Date(1_000_000));
    const fresh = await portFile('fresh', '9333\r\n/devtools/browser/fresh', new Date(2_000_000));
    const older = await portFile('older', '9444\n/devtools/browser/older\n', new Date(500_000));
    const bad = [await portFile('empty', ''), await portFile('port', 'abc\n/devtools/browser/x'), await portFile('path', '9222\n/json')];
    const missing = path.join(dir, 'missing');
    expect(await readDevToolsActivePort([missing, ...bad, old, fresh, older])).toBe('ws://127.0.0.1:9333/devtools/browser/fresh');
    expect(await readDevToolsActivePort([missing, ...bad])).toBeNull();
  });

  it('prefers AUTOLOGIN_CDP_URL over auto-connect', async () => {
    const auto = await portFile('auto', '9222\n/devtools/browser/a');
    expect(await resolveEndpoint('ws://host:1/devtools/browser/x', [auto])).toEqual({ kind: 'ws', url: 'ws://host:1/devtools/browser/x' });
    expect(await resolveEndpoint('WSS://host/x', [])).toEqual({ kind: 'ws', url: 'WSS://host/x' });
    expect(await resolveEndpoint('http://127.0.0.1:9222', [])).toEqual({ kind: 'http', url: 'http://127.0.0.1:9222' });
    expect(await resolveEndpoint(undefined, [auto])).toEqual({ kind: 'ws', url: 'ws://127.0.0.1:9222/devtools/browser/a' });
    expect(await resolveEndpoint(undefined, [])).toBeNull();
  });
});

function fakeBrowser() {
  let onDisconnected: () => void = () => undefined;
  const browser: BrowserLike & { fireDisconnected(): void } = {
    targets: () => [],
    disconnect: vi.fn(async () => undefined),
    onDisconnected: (listener) => {
      onDisconnected = listener;
    },
    fireDisconnected: () => onDisconnected(),
  };
  return browser;
}

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through answers that arrive in time', async () => {
    const browser = fakeBrowser();
    expect(await withTimeout(Promise.resolve(browser), 1_000)).toBe(browser);
    await expect(withTimeout(Promise.reject(new Error('refused')), 1_000)).rejects.toThrow('refused');
  });

  it('gives up on a silent Chrome and closes a connection that arrives too late', async () => {
    vi.useFakeTimers();
    const late = fakeBrowser();
    vi.mocked(late.disconnect).mockRejectedValueOnce(new Error('gone'));
    let arrive!: (browser: BrowserLike) => void;
    const pending = withTimeout(new Promise<BrowserLike>((resolve) => (arrive = resolve)), 20_000);
    vi.advanceTimersByTime(20_000);
    await expect(pending).rejects.toThrow('no answer within 20s');
    arrive(late);
    await vi.runAllTimersAsync();
    expect(late.disconnect).toHaveBeenCalledOnce();
  });

  it('is used by BrowserManager', async () => {
    const manager = new BrowserManager({ getCdpUrl: async () => 'ws://x', dirs: [], connect: () => new Promise(() => undefined), connectTimeoutMs: 10 });
    await expect(manager.get()).rejects.toThrow(/Could not connect to Chrome at ws:\/\/x \(no answer within 0s/);
  });
});

describe('BrowserManager', () => {
  const options = (connect: (ep: unknown) => Promise<BrowserLike>) => ({ getCdpUrl: async () => 'http://127.0.0.1:9222', dirs: [], connect });

  it('connects once and reuses the connection', async () => {
    const browser = fakeBrowser();
    const connect = vi.fn(async () => browser);
    const manager = new BrowserManager(options(connect));
    const [a, b] = await Promise.all([manager.get(), manager.get()]);
    expect(a).toBe(browser);
    expect(b).toBe(browser);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ kind: 'http', url: 'http://127.0.0.1:9222' });
  });

  it('reconnects after Chrome disconnects', async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new BrowserManager(options(connect));
    expect(await manager.get()).toBe(first);
    first.fireDisconnected();
    expect(await manager.get()).toBe(second);
  });

  it('explains how to enable remote debugging when there is no endpoint', async () => {
    const manager = new BrowserManager({ getCdpUrl: async () => undefined, dirs: [dir] });
    await expect(manager.get()).rejects.toBeInstanceOf(BrowserNotConnectedError);
    await expect(manager.get()).rejects.toThrow(NOT_CONNECTED_HINT);
  });

  it('wraps connection failures and retries on the next call', async () => {
    const browser = fakeBrowser();
    const connect = vi.fn().mockRejectedValueOnce(new Error('refused')).mockRejectedValueOnce('denied').mockResolvedValueOnce(browser);
    const manager = new BrowserManager(options(connect));
    await expect(manager.get()).rejects.toThrow(/Could not connect to Chrome at http:\/\/127\.0\.0\.1:9222 \(refused\)/);
    await expect(manager.get()).rejects.toThrow(/\(denied\)/);
    expect(await manager.get()).toBe(browser);
  });

  it('disconnects on dispose and tolerates failures', async () => {
    const browser = fakeBrowser();
    const manager = new BrowserManager(options(async () => browser));
    await manager.dispose();
    await manager.get();
    await manager.dispose();
    expect(browser.disconnect).toHaveBeenCalledOnce();

    const failing = new BrowserManager(options(async () => Promise.reject(new Error('nope'))));
    await failing.get().catch(() => undefined);
    const pending = failing.get();
    await failing.dispose();
    await expect(pending).rejects.toThrow();

    const stubborn = fakeBrowser();
    vi.mocked(stubborn.disconnect).mockRejectedValueOnce(new Error('already gone'));
    const manager2 = new BrowserManager(options(async () => stubborn));
    await manager2.get();
    await expect(manager2.dispose()).resolves.toBeUndefined();
  });
});
