import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guiOpenCommand, hasDesktop, openDetached, openInEditor, type SpawnFn } from '../src/opener.ts';

function fakeSpawn(event: 'spawn' | 'error' | 'exit', payload?: unknown, exitCode?: number | null) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawn = vi.fn(() => {
    setImmediate(() => {
      child.emit(event, payload);
      if (exitCode !== undefined) setImmediate(() => child.emit('exit', exitCode));
    });
    return child;
  });
  return { spawn: spawn as unknown as SpawnFn & typeof spawn, child };
}

const DESKTOP = { DISPLAY: ':0' };

describe('guiOpenCommand', () => {
  it('uses the platform opener', () => {
    expect(guiOpenCommand('/f', 'darwin')).toEqual(['open', ['-t', '/f']]);
    expect(guiOpenCommand('C:\\f', 'win32')).toEqual(['notepad.exe', ['C:\\f']]);
    expect(guiOpenCommand('/f', 'linux')).toEqual(['xdg-open', ['/f']]);
  });
});

describe('hasDesktop', () => {
  it('needs X11 or Wayland outside macOS and Windows', () => {
    expect(hasDesktop('darwin', {})).toBe(true);
    expect(hasDesktop('win32', {})).toBe(true);
    expect(hasDesktop('linux', {})).toBe(false);
    expect(hasDesktop('linux', { DISPLAY: ' ' })).toBe(false);
    expect(hasDesktop('linux', { DISPLAY: ':0' })).toBe(true);
    expect(hasDesktop('freebsd', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });
});

describe('openDetached', () => {
  it('resolves when the opener is still running after the settle time, and detaches from it', async () => {
    const { spawn, child } = fakeSpawn('spawn');
    await openDetached('/f', 'darwin', { spawn, settleMs: 5 });
    expect(spawn).toHaveBeenCalledWith('open', ['-t', '/f'], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
    child.emit('exit', 1); // a late exit no longer matters
  });

  it('resolves when the opener exits cleanly', async () => {
    const { spawn, child } = fakeSpawn('spawn', undefined, 0);
    await openDetached('/f', 'linux', { spawn, env: DESKTOP, settleMs: 60_000 });
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('rejects when the opener fails early, is missing, or there is no desktop', async () => {
    await expect(openDetached('/f', 'linux', { spawn: fakeSpawn('spawn', undefined, 3).spawn, env: DESKTOP })).rejects.toThrow('xdg-open exited with code 3');
    await expect(openDetached('/f', 'linux', { spawn: fakeSpawn('spawn', undefined, null).spawn, env: DESKTOP })).rejects.toThrow('exited with a signal');
    await expect(openDetached('/f', 'linux', { spawn: fakeSpawn('error', new Error('ENOENT')).spawn, env: DESKTOP })).rejects.toThrow('ENOENT');
    const { spawn } = fakeSpawn('spawn');
    await expect(openDetached('/f', 'linux', { spawn, env: {} })).rejects.toThrow('no desktop session');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the real environment by default', async () => {
    const { spawn } = fakeSpawn('spawn', undefined, 0);
    await expect(openDetached('/f', 'darwin', { spawn })).resolves.toBeUndefined();
  });
});

describe('openInEditor', () => {
  it('runs the editor with its arguments and returns its exit code', async () => {
    const { spawn } = fakeSpawn('exit', 0);
    expect(await openInEditor('/f', ' code  -w ', spawn)).toBe(0);
    expect(spawn).toHaveBeenCalledWith('code', ['-w', '/f'], { stdio: 'inherit' });
    expect(await openInEditor('/f', 'vim', fakeSpawn('exit', null).spawn)).toBe(1);
  });

  it('rejects when the editor cannot start', async () => {
    await expect(openInEditor('/f', 'nope', fakeSpawn('error', new Error('ENOENT')).spawn)).rejects.toThrow('ENOENT');
  });
});
