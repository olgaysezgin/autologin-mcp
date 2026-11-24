import os from 'node:os';
import type { EventEmitter } from 'node:events';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BridgeServer, type BridgeOptions } from './bridge/server.js';
import { BrowserManager, chromeUserDataDirs, type BrowserManagerOptions } from './browser/connect.js';
import { DEFAULT_TIMING, performLogin, realClock } from './login/engine.js';
import { openDetached, type SpawnFn } from './opener.js';
import { credentialsPath, resolveConfigDir, type Env } from './paths.js';
import { FailureLimiter } from './ratelimit.js';
import { ResultLog } from './results.js';
import { createServer, type ServerDeps } from './server.js';
import { ensureEnvFile, loadStore } from './store/envfile.js';
import { VERSION } from './version.js';

export interface ServeOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  transport?: Transport;
  /** Closing this stream (stdin by default) shuts the server down. */
  input?: EventEmitter;
  connect?: BrowserManagerOptions['connect'];
  spawn?: SpawnFn;
  bridge?: Omit<BridgeOptions, 'onResult' | 'noFormContext' | 'codeStepContext'>;
}

export function createDefaultDeps(options: ServeOptions = {}): { deps: ServerDeps; browser: BrowserManager; bridge: BridgeServer } {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const file = credentialsPath(resolveConfigDir(env, home));
  const browser = new BrowserManager({
    getCdpUrl: async () => (await loadStore(file)).settings.cdpUrl,
    dirs: chromeUserDataDirs(platform, home, env),
    connect: options.connect,
  });
  const limiter = new FailureLimiter();
  const results = new ResultLog();
  const bridge = new BridgeServer({
    ...options.bridge,
    onResult: (profile, result) => {
      if (result.status === 'failed' || result.status === 'error') limiter.recordFailure(profile);
      results.record(profile, result, 'bridge');
    },
    noFormContext: (profile) => results.noFormContext(profile),
    codeStepContext: (profile) => results.codeStep(profile),
  });
  const deps: ServerDeps = {
    version: VERSION,
    configFile: file,
    loadStore: () => loadStore(file),
    getBrowser: () => browser.get(),
    login: (page, profile, codeStep) => performLogin(page, profile, DEFAULT_TIMING, realClock, codeStep),
    bridge,
    openConfig: async () => {
      const created = await ensureEnvFile(file);
      await openDetached(file, platform, { spawn: options.spawn, env });
      return { created };
    },
    limiter,
    results,
  };
  return { deps, browser, bridge };
}

/** Runs the MCP server until the client disconnects, then releases Chrome and the bridge port. */
export async function serve(options: ServeOptions = {}): Promise<void> {
  const { deps, browser, bridge } = createDefaultDeps(options);
  const server = createServer(deps);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  const input = options.input ?? process.stdin;
  const shutdown = () => void server.close();
  input.once('end', shutdown);
  input.once('close', shutdown);
  await server.connect(options.transport ?? new StdioServerTransport());
  await closed;
  await Promise.all([browser.dispose(), bridge.close()]);
}
