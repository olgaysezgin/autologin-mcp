import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExec } from '../src/exec.ts';

describe('createExec', () => {
  const exec = createExec();

  it('resolves with output and exit code', async () => {
    expect(await exec(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    expect(await exec(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'])).toMatchObject({ code: 3, stderr: 'bad' });
  });

  it('rejects only when the command does not exist', async () => {
    await expect(exec('definitely-not-a-command-autologin', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps non-numeric failures to exit code 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-exec-'));
    const file = path.join(dir, 'not-executable');
    await fs.writeFile(file, 'echo hi', { mode: 0o644 });
    expect((await exec(file, [])).code).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs through a shell on Windows', async () => {
    expect((await createExec('win32')('node', ['--version'])).code).toBe(0);
  });
});
