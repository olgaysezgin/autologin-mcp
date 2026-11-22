import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guiOpenCommand, openDetached, openInEditor, type SpawnFn } from '../src/opener.ts';

function fakeSpawn(event: 'spawn' | 'error' | 'exit', payload?: unknown) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawn = vi.fn(() => {
    setImmediate(() => child.emit(event, payload));
    return child;
  });
  return { spawn: spawn as unknown as SpawnFn & typeof spawn, child };
}

describe('guiOpenCommand', () => {
  it('uses the platform opener', () => {
    expect(guiOpenCommand('/f', 'darwin')).toEqual(['open', ['-t', '/f']]);
    expect(guiOpenCommand('C:\\f', 'win32')).toEqual(['notepad.exe', ['C:\\f']]);
    expect(guiOpenCommand('/f', 'linux')).toEqual(['xdg-open', ['/f']]);
  });
});

describe('openDetached', () => {
  it('resolves once the opener started and detaches from it', async () => {
    const { spawn, child } = fakeSpawn('spawn');
    await openDetached('/f', 'darwin', spawn);
    expect(spawn).toHaveBeenCalledWith('open', ['-t', '/f'], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('rejects when the opener is missing', async () => {
    const { spawn } = fakeSpawn('error', new Error('ENOENT'));
    await expect(openDetached('/f', 'linux', spawn)).rejects.toThrow('ENOENT');
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
