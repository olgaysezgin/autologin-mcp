import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function chromePath(): string {
  const found = [process.env.CHROME_PATH, ...CANDIDATES].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH to run the browser tests.');
  return found;
}

export interface TestChrome {
  /** Chrome writes DevToolsActivePort here, just like a real profile with remote debugging on. */
  userDataDir: string;
  wsEndpoint: string;
  httpEndpoint: string;
  close(): Promise<void>;
}

/** Launches a throwaway headless Chrome with remote debugging, mimicking chrome://inspect auto-connect. */
export async function launchChrome(): Promise<TestChrome> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const proc: ChildProcess = spawn(chromePath(), args, { stdio: 'ignore' });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let text = '';
  for (let i = 0; i < 200 && !text.includes('/devtools/browser/'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    text = await fs.readFile(portFile, 'utf8').catch(() => '');
  }
  const [port, wsPath] = text.split('\n').map((s) => s.trim());
  if (!port || !wsPath) throw new Error('Chrome did not start with remote debugging.');
  return {
    userDataDir,
    wsEndpoint: `ws://127.0.0.1:${port}${wsPath}`,
    httpEndpoint: `http://127.0.0.1:${port}`,
    close: async () => {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill();
      await exited;
      // Chrome's helper processes can still write to the profile briefly after the main process exits.
      await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
