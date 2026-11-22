import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parse } from 'dotenv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultContext, main, packageSpec, parseArgs, USAGE, type CliContext } from '../src/cli.ts';
import type { ExecFn } from '../src/exec.ts';
import type { SpawnFn } from '../src/opener.ts';
import { InputClosedError, type Prompter } from '../src/prompt.ts';
import { VERSION } from '../src/version.ts';

let home: string;
let out: string;
let err: string;
let file: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-cli-'));
  file = path.join(home, '.autologin-mcp', 'credentials.env');
  out = '';
  err = '';
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** Answers questions from a script; strings are answers, booleans answer confirm(). */
function scripted(answers: Array<string | boolean>, hidden: string[] = []): Prompter & { closed: boolean } {
  const next = () => {
    if (answers.length === 0) throw new InputClosedError();
    return answers.shift()!;
  };
  return {
    closed: false,
    ask: async () => String(next()),
    askHidden: async (q) => {
      hidden.push(q);
      return String(next());
    },
    confirm: async () => next() === true,
    close() {
      this.closed = true;
    },
  };
}

function ctx(overrides: Partial<CliContext> = {}, answers: Array<string | boolean> = []): Partial<CliContext> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (c) => (out += String(c)));
  stderr.on('data', (c) => (err += String(c)));
  const prompter = scripted(answers);
  return {
    env: {},
    home,
    platform: 'linux',
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    stdout,
    stderr,
    exec: vi.fn<ExecFn>(async () => ({ code: 0, stdout: '', stderr: '' })),
    prompter: () => prompter,
    serve: vi.fn(async () => undefined),
    guardSource: path.join(home, 'guard.js'),
    ...overrides,
  };
}

const tty = () => Object.assign(new PassThrough(), { isTTY: true });

function spawnEmitting(event: 'spawn' | 'exit', payload?: unknown) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    setImmediate(() => child.emit(event, payload));
    return child;
  }) as unknown as SpawnFn;
}

describe('parseArgs', () => {
  it('splits command, positionals and flags', () => {
    expect(parseArgs(['add', 'staging', '--url', 'x.test', '--username=me', '-y'])).toEqual({
      command: 'add',
      positionals: ['staging'],
      flags: { yes: true, dryRun: false, purge: false, help: false, version: false, url: 'x.test', username: 'me' },
    });
    expect(parseArgs(['uninstall', '--yes', '--dry-run', '--purge', '-h', '-v']).flags).toMatchObject({ yes: true, dryRun: true, purge: true, help: true, version: true });
    expect(parseArgs([]).command).toBe('');
  });

  it('rejects unknown options and missing values', () => {
    expect(() => parseArgs(['add', '--url'])).toThrow('--url needs a value');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option --nope');
  });
});

describe('main', () => {
  it('prints the version and help', async () => {
    expect(await main(['--version'], ctx())).toBe(0);
    expect(await main(['version'], ctx())).toBe(0);
    expect(out).toBe(`${VERSION}\n${VERSION}\n`);
    expect(await main(['help'], ctx())).toBe(0);
    expect(await main(['add', '--help'], ctx())).toBe(0);
    expect(out).toContain(USAGE);
  });

  it('rejects bad arguments and unknown commands', async () => {
    expect(await main(['--bogus'], ctx())).toBe(1);
    expect(await main(['frobnicate'], ctx())).toBe(1);
    expect(err).toContain('Unknown option --bogus');
    expect(err).toContain('Unknown command "frobnicate"');
  });

  it('runs the MCP server by default', async () => {
    const c = ctx();
    expect(await main([], c)).toBe(0);
    expect(await main(['serve'], c)).toBe(0);
    expect(c.serve).toHaveBeenCalledTimes(2);
  });

  it('reports unexpected errors', async () => {
    await fs.mkdir(file, { recursive: true });
    expect(await main(['list'], ctx())).toBe(1);
    expect(err).toMatch(/^Error: /);
  });

  it('has a real default context', () => {
    const c = defaultContext();
    expect(c.home).toBe(os.homedir());
    expect(c.guardSource.endsWith(path.join('hooks', 'guard.js'))).toBe(true);
    expect(typeof c.serve).toBe('function');
  });
});

describe('install / uninstall', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(home, 'guard.js'), '// guard');
  });

  it('installs with -y and dry-runs without confirmation', async () => {
    expect(await main(['install', '-y'], ctx())).toBe(0);
    expect(out).toContain('Registered MCP server "autologin"');
    expect(await main(['install', '--dry-run'], ctx())).toBe(0);
    expect(out).toContain('Dry run');
  });

  it('needs -y without a terminal, and asks on a terminal', async () => {
    expect(await main(['install'], ctx())).toBe(1);
    expect(err).toContain('re-run with -y');
    expect(await main(['install'], ctx({ stdin: tty() }, [false]))).toBe(1);
    expect(await main(['install'], ctx({ stdin: tty() }, []))).toBe(1);
    expect(await main(['install'], ctx({ stdin: tty() }, [true]))).toBe(0);
  });

  it('registers a custom package spec, resolving local tarballs to absolute paths', async () => {
    const tarball = path.join(home, 'autologin-mcp-1.0.0.tgz');
    await fs.writeFile(tarball, 'tgz');
    expect(packageSpec(undefined)).toBe(`autologin-mcp@${VERSION}`);
    expect(packageSpec('github:olgaysezgin/autologin-mcp')).toBe('github:olgaysezgin/autologin-mcp');
    expect(packageSpec(path.relative(process.cwd(), tarball))).toBe(`file:${tarball}`);
    expect(parseArgs(['install', '--package=x']).flags.package).toBe('x');
    const c = ctx();
    expect(await main(['install', '-y', '--package', tarball], c)).toBe(0);
    expect(c.exec).toHaveBeenCalledWith('claude', ['mcp', 'add', '--scope', 'user', 'autologin', '--', 'npx', '-y', `file:${tarball}`]);
    expect(out).toContain(`(user scope, file:${tarball})`);
  });

  it('returns 1 when registration needs manual work', async () => {
    const exec = vi.fn<ExecFn>(async () => Promise.reject(new Error('ENOENT')));
    expect(await main(['install', '-y'], ctx({ exec }))).toBe(1);
    expect(await main(['uninstall', '-y'], ctx({ exec }))).toBe(1);
  });

  it('uninstalls, optionally purging', async () => {
    await main(['install', '-y'], ctx());
    expect(await main(['uninstall', '--dry-run'], ctx())).toBe(0);
    expect(await main(['uninstall'], ctx())).toBe(1);
    expect(await main(['uninstall', '-y', '--purge'], ctx())).toBe(0);
    await expect(fs.access(file)).rejects.toThrow();
  });
});

describe('add', () => {
  it('asks for everything, hides the password and writes a 600 file', async () => {
    const hidden: string[] = [];
    const prompter = scripted(['Staging', 'https://staging.example.com/login', 'qa@example.com', `p'w"#1`, `p'w"#1`], hidden);
    expect(await main(['add'], ctx({ prompter: () => prompter }))).toBe(0);
    const text = await fs.readFile(file, 'utf8');
    expect(parse(text)).toEqual({ STAGING_URL: 'staging.example.com', STAGING_USERNAME: 'qa@example.com', STAGING_PASSWORD: `p'w"#1` });
    expect(text).toContain('# autologin-mcp credentials');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(hidden).toEqual(['Password (hidden): ', 'Repeat the password: ']);
    expect(out).toContain('the path was removed');
    expect(out).not.toContain("p'w");
    expect(prompter.closed).toBe(true);
  });

  it('takes the name, url and username from arguments and replaces an existing profile', async () => {
    await main(['add', 'local', '--url', 'localhost:3000', '--username', 'admin'], ctx({}, ['one', 'one']));
    expect(await main(['add', 'local', '--url', 'localhost:3000', '--username', 'root'], ctx({}, [false]))).toBe(1);
    expect(err).toContain('Cancelled.');
    expect(await main(['add', 'local', '--url', 'localhost:3000', '--username', 'root'], ctx({}, [true, 'two', 'two']))).toBe(0);
    const vars = parse(await fs.readFile(file, 'utf8'));
    expect(vars).toMatchObject({ LOCAL_USERNAME: 'root', LOCAL_PASSWORD: 'two' });
    expect((await fs.readFile(file, 'utf8')).match(/# --- local ---/g)).toHaveLength(1);
  });

  it.each([
    [['add', 'bad name'], [], 'Invalid profile name'],
    [['add', 'autologin_x'], [], 'Invalid profile name'],
    [['add', 'app', '--url', 'not a url'], [], 'Invalid URL'],
    [['add', 'app', '--url', 'x.test'], [''], 'A username is required.'],
    [['add', 'app', '--url', 'x.test', '--username', 'u'], [''], 'A password is required.'],
    [['add', 'app', '--url', 'x.test', '--username', 'u'], ['a', 'b'], 'The passwords do not match.'],
    [['add', 'app', '--url', 'x.test', '--username', 'u'], ['\'"`', '\'"`'], 'edit the credentials file by hand'],
    [['add', 'app', '--url', 'x.test'], [], 'Input closed'],
  ])('%j fails with %s', async (argv, answers, message) => {
    expect(await main(argv as string[], ctx({}, answers as string[]))).toBe(1);
    expect(err).toContain(message);
  });

  it('reports filesystem errors', async () => {
    await fs.mkdir(file, { recursive: true });
    expect(await main(['add', 'app'], ctx())).toBe(1);
    expect(err).toMatch(/^Error: /);
  });
});

describe('list / remove / edit', () => {
  async function seed(text: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { mode: 0o600 });
  }

  it('lists profiles without passwords, with problems and warnings', async () => {
    expect(await main(['list'], ctx())).toBe(0);
    expect(out).toContain('No credentials file yet');
    await seed('APP_URL=app.test\nAPP_USERNAME=qa\nAPP_PASSWORD=TopSecret\nBROKEN_URL=x.test\nNOPE=1\n');
    out = '';
    expect(await main(['list'], ctx())).toBe(0);
    expect(out).toContain('app      app.test  qa');
    expect(out).toContain('broken   x.test  -  ! BROKEN_USERNAME is missing');
    expect(out).not.toContain('TopSecret');
    expect(err).toContain('Ignoring NOPE');
    await fs.chmod(file, 0o644);
    await main(['list'], ctx());
    expect(err).toContain('chmod 600');
  });

  it('says when there are no profiles', async () => {
    await seed('# empty\n');
    await main(['list'], ctx());
    expect(out).toContain('No profiles yet');
    await seed('BROKEN_USERNAME=x\n');
    await main(['list'], ctx());
    expect(out).toContain('broken   -');
  });

  it('removes a profile after confirmation', async () => {
    await seed('# --- app ---\nAPP_URL=app.test\nAPP_USERNAME=qa\nAPP_PASSWORD=p\n');
    expect(await main(['remove'], ctx())).toBe(1);
    expect(await main(['remove', 'ghost'], ctx())).toBe(1);
    expect(await main(['remove', 'app'], ctx())).toBe(1);
    expect(await main(['remove', 'APP', '-y'], ctx())).toBe(0);
    expect(parse(await fs.readFile(file, 'utf8'))).toEqual({});
    expect(await main(['remove', 'app', '-y'], ctx())).toBe(1);
    await fs.rm(file);
    expect(await main(['remove', 'app', '-y'], ctx())).toBe(1);
  });

  it('opens the file in $EDITOR or the desktop editor', async () => {
    const editor = spawnEmitting('exit', 0);
    expect(await main(['edit'], ctx({ env: { EDITOR: 'vim' }, spawn: editor }))).toBe(0);
    expect(editor).toHaveBeenCalledWith('vim', [file], { stdio: 'inherit' });
    expect(out).toContain('Created');
    const gui = spawnEmitting('spawn');
    expect(await main(['edit'], ctx({ env: { VISUAL: ' ' }, spawn: gui }))).toBe(0);
    expect(gui).toHaveBeenCalledWith('xdg-open', [file], { detached: true, stdio: 'ignore' });
    expect(out).toContain('Opened');
  });
});
