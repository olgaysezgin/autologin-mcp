import { spawn as nodeSpawn } from 'node:child_process';
import type { Env } from './paths.js';

export type SpawnFn = typeof nodeSpawn;

export function guiOpenCommand(file: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === 'darwin') return ['open', ['-t', file]];
  if (platform === 'win32') return ['notepad.exe', [file]];
  return ['xdg-open', [file]];
}

/** macOS and Windows always have a desktop; elsewhere a window needs X11 or Wayland (not over SSH, in CI or in a container). */
export function hasDesktop(platform: NodeJS.Platform, env: Env): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

export interface OpenOptions {
  spawn?: SpawnFn;
  env?: Env;
  /** How long to watch the opener for an early failure before trusting that it opened the file. */
  settleMs?: number;
}

/**
 * Opens a file in the desktop's default text editor without waiting for the editor.
 * Rejects when there is no desktop, when the opener is missing, or when it exits with an error
 * within `settleMs` (xdg-open without a display, `open` with no GUI session).
 */
export function openDetached(file: string, platform: NodeJS.Platform, options: OpenOptions = {}): Promise<void> {
  const { spawn = nodeSpawn, env = process.env, settleMs = 1_500 } = options;
  if (!hasDesktop(platform, env)) return Promise.reject(new Error('there is no desktop session here (DISPLAY and WAYLAND_DISPLAY are not set)'));
  const [command, args] = guiOpenCommand(file, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    let timer: NodeJS.Timeout | undefined;
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code === null ? 'a signal' : `code ${code}`}`));
    });
    child.once('spawn', () => {
      timer = setTimeout(() => {
        child.removeAllListeners('exit');
        child.unref();
        resolve();
      }, settleMs);
    });
  });
}

/** Opens a file in `$VISUAL` / `$EDITOR` in the current terminal and waits for it to exit. */
export function openInEditor(file: string, editor: string, spawn: SpawnFn = nodeSpawn): Promise<number> {
  const [command, ...args] = editor.trim().split(/\s+/);
  return new Promise((resolve, reject) => {
    const child = spawn(command!, [...args, file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
