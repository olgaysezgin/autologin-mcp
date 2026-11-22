import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnFn } from '../src/opener.ts';
import { createDefaultDeps, serve } from '../src/serve.ts';
import { buildStore, type UsableProfile } from '../src/store/profiles.ts';
import { VERSION } from '../src/version.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-serve-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const fakeSpawn = (() => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => child.emit('spawn'));
  return child;
}) as unknown as SpawnFn;

describe('createDefaultDeps', () => {
  it('defaults to the real environment', () => {
    const { deps } = createDefaultDeps();
    expect(deps.configFile.endsWith('credentials.env')).toBe(true);
    expect(deps.version).toBe(VERSION);
  });

  it('reads the store, creates and opens the file, and reports a missing browser', async () => {
    const { deps, browser } = createDefaultDeps({ env: { AUTOLOGIN_HOME: dir }, home: dir, platform: 'linux', spawn: fakeSpawn });
    expect(deps.configFile).toBe(path.join(dir, 'credentials.env'));
    expect((await deps.loadStore()).exists).toBe(false);
    expect(await deps.openConfig()).toEqual({ created: true });
    expect(await deps.openConfig()).toEqual({ created: false });
    await expect(deps.getBrowser()).rejects.toThrow(/remote debugging/);
    await browser.dispose();
  });

  it('counts failed bridge logins reported by the page', async () => {
    const { deps, bridge } = createDefaultDeps({ env: { AUTOLOGIN_HOME: dir }, home: dir, platform: 'linux' });
    const profile = buildStore({ APP_URL: 'localhost:3000', APP_USERNAME: 'u', APP_PASSWORD: 'p' }).profiles[0] as UsableProfile;
    const report = async (status: string) => {
      const ticket = await bridge.issue(profile);
      const [, url] = /"(http:[^"]+)\/v1\/filler\/([\w-]+)\.js"/.exec(ticket.function)!;
      const token = /\/v1\/filler\/([\w-]+)\.js/.exec(ticket.function)![1];
      await fetch(`${url}/v1/result/${token}`, { method: 'POST', body: JSON.stringify({ status }) });
    };
    await report('success');
    expect(deps.results.get('app')).toEqual([expect.objectContaining({ status: 'success', via: 'bridge' })]);
    await report('failed');
    await report('error');
    expect(deps.limiter.isBlocked('app')).toBe(false);
    await report('failed');
    expect(deps.limiter.isBlocked('app')).toBe(true);
    expect(deps.results.get('app')).toEqual([expect.objectContaining({ status: 'failed' })]);
    await bridge.close();
  });
});

describe('serve', () => {
  async function start(input?: EventEmitter) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const running = serve({ env: { AUTOLOGIN_HOME: dir }, home: dir, platform: 'linux', transport: serverTransport, input });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
    return { running, client };
  }

  it('serves tools until stdin ends', async () => {
    const input = new EventEmitter();
    const { running, client } = await start(input);
    expect((await client.listTools()).tools).toHaveLength(4);
    input.emit('end');
    await expect(running).resolves.toBeUndefined();
  });

  it('stops when stdin closes', async () => {
    const input = new EventEmitter();
    const { running } = await start(input);
    input.emit('close');
    await expect(running).resolves.toBeUndefined();
  });

  it('stops when the client disconnects (default stdin listener)', async () => {
    const { running, client } = await start();
    await client.close();
    await expect(running).resolves.toBeUndefined();
  });

  it('uses the stdio transport by default', async () => {
    const input = new EventEmitter();
    const running = serve({ env: { AUTOLOGIN_HOME: dir }, home: dir, platform: 'linux', input });
    await new Promise((resolve) => setImmediate(resolve));
    input.emit('end');
    await expect(running).resolves.toBeUndefined();
  });
});
