import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendBlock,
  ensureEnvFile,
  loadStore,
  permissionWarning,
  quoteValue,
  readText,
  removeProfile,
  renderProfile,
  writeSecureFile,
} from '../src/store/envfile.ts';
import { ENV_TEMPLATE } from '../src/templates.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-env-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;

describe('readText / loadStore', () => {
  it('returns null for a missing file and rethrows other errors', async () => {
    expect(await readText(path.join(dir, 'missing'))).toBeNull();
    await expect(readText(dir)).rejects.toThrow();
  });

  it('loads profiles from the file without touching process.env', async () => {
    const file = path.join(dir, 'credentials.env');
    expect(await loadStore(file)).toMatchObject({ file, exists: false, profiles: [] });
    await fs.writeFile(file, "APP_URL=example.com\nAPP_USERNAME=me\nAPP_PASSWORD='s3cret#1'\n");
    const store = await loadStore(file);
    expect(store.exists).toBe(true);
    expect(store.profiles[0]).toMatchObject({ name: 'app', password: 's3cret#1' });
    expect(process.env.APP_PASSWORD).toBeUndefined();
  });

  it('parses the template as an empty store', async () => {
    const file = path.join(dir, 'credentials.env');
    await fs.writeFile(file, ENV_TEMPLATE);
    expect((await loadStore(file)).profiles).toEqual([]);
  });
});

describe('quoteValue', () => {
  it.each([
    ['plain', "'plain'"],
    ["it's", `"it's"`],
    [`a'b"c`, '`a\'b"c`'],
    ["a'b\\nc", "`a'b\\nc`"],
    ['spaces and # hash', "'spaces and # hash'"],
  ])('%j → %s and reads back verbatim', (value, quoted) => {
    expect(quoteValue(value)).toBe(quoted);
    expect(parse(`K=${quoteValue(value)}`).K).toBe(value);
  });

  it('rejects multi-line values and values using every quote character', () => {
    expect(() => quoteValue('a\nb')).toThrow(/single line/);
    expect(() => quoteValue('\'"`')).toThrow(/edit the credentials file by hand/);
  });
});

describe('renderProfile / appendBlock / removeProfile', () => {
  const block = renderProfile({ name: 'staging', url: 'staging.example.com', username: 'qa@x.io', password: `p'w"#` });

  it('renders a block that parses back', () => {
    expect(block.startsWith('# --- staging ---\nSTAGING_URL=staging.example.com\n')).toBe(true);
    expect(parse(block)).toEqual({ STAGING_URL: 'staging.example.com', STAGING_USERNAME: 'qa@x.io', STAGING_PASSWORD: `p'w"#` });
  });

  it('adds a TOTP secret line when there is one (#1)', () => {
    const withTotp = renderProfile({ name: 'app', url: 'x.test', username: 'u', password: 'p', totpSecret: 'GEZD GNBV' });
    expect(parse(withTotp)).toEqual({ APP_URL: 'x.test', APP_USERNAME: 'u', APP_PASSWORD: 'p', APP_TOTP_SECRET: 'GEZD GNBV' });
  });

  it.each([
    ['', 'B'],
    ['x', 'x\n\nB'],
    ['x\n', 'x\n\nB'],
    ['x\n\n', 'x\n\nB'],
  ])('appendBlock(%j)', (text, expected) => {
    expect(appendBlock(text, 'B')).toBe(expected);
  });

  it('removes only the named profile', () => {
    const other = renderProfile({ name: 'staging_admin', url: 'staging.example.com', username: 'a', password: 'b' });
    const text = appendBlock(appendBlock('# header\nAUTOLOGIN_CDP_URL=http://x\n', block), other) + 'export STAGING_AUTO_LOGIN=true\n';
    const { text: next, removed } = removeProfile(text, 'STAGING');
    expect(removed).toBe(4);
    expect(parse(next)).toEqual({ AUTOLOGIN_CDP_URL: 'http://x', STAGING_ADMIN_URL: 'staging.example.com', STAGING_ADMIN_USERNAME: 'a', STAGING_ADMIN_PASSWORD: 'b' });
    expect(next).not.toContain('# --- staging ---');
    expect(next).not.toMatch(/\n{3,}/);
    expect(removeProfile(text, 'nope').removed).toBe(0);
  });
});

describe('writeSecureFile / ensureEnvFile / permissionWarning', () => {
  it('writes atomically with owner-only permissions', async () => {
    const file = path.join(dir, 'nested', 'credentials.env');
    await writeSecureFile(file, 'A=1\n');
    expect(await fs.readFile(file, 'utf8')).toBe('A=1\n');
    if (process.platform !== 'win32') {
      expect(await mode(file)).toBe(0o600);
      expect(await mode(path.dirname(file))).toBe(0o700);
    }
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the template once', async () => {
    const file = path.join(dir, 'credentials.env');
    expect(await ensureEnvFile(file)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(ENV_TEMPLATE);
    expect(await ensureEnvFile(file)).toBe(false);
  });

  it('warns when other users can read the file', async () => {
    const file = path.join(dir, 'credentials.env');
    expect(await permissionWarning(file, 'linux')).toBeNull();
    await writeSecureFile(file, 'A=1');
    expect(await permissionWarning(file, 'linux')).toBeNull();
    await fs.chmod(file, 0o644);
    expect(await permissionWarning(file, 'darwin')).toContain('chmod 600');
    expect(await permissionWarning(file, 'win32')).toBeNull();
    expect(await permissionWarning(file)).toEqual(process.platform === 'win32' ? null : expect.stringContaining('chmod 600'));
  });
});
