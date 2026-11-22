import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = typeof nodeSpawn;

export function guiOpenCommand(file: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === 'darwin') return ['open', ['-t', file]];
  if (platform === 'win32') return ['notepad.exe', [file]];
  return ['xdg-open', [file]];
}

/** Opens a file in the desktop's default text editor without waiting for it. */
export function openDetached(file: string, platform: NodeJS.Platform, spawn: SpawnFn = nodeSpawn): Promise<void> {
  const [command, args] = guiOpenCommand(file, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
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
