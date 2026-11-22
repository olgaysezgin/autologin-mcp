import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkToolCall, expandHome, isEntry, isInside, main, needlesFor, parseDir, runGuard } from '../src/hooks/guard.ts';

const HOME = '/home/me';
const DIR = '/home/me/.autologin-mcp';
const CWD = '/home/me/project';
const GUARD_PATH = fileURLToPath(new URL('../src/hooks/guard.ts', import.meta.url));

const check = (tool_name: unknown, tool_input: unknown) => checkToolCall({ tool_name, tool_input }, DIR, HOME, CWD);

describe('path helpers', () => {
  it('expands ~ and checks containment', () => {
    expect(expandHome('~', HOME)).toBe(HOME);
    expect(expandHome('~/x', HOME)).toBe('/home/me/x');
    expect(expandHome('~\\x', HOME)).toBe('/home/me/x');
    expect(expandHome('/abs', HOME)).toBe('/abs');
    expect(isInside(DIR, DIR)).toBe(true);
    expect(isInside(`${DIR}/credentials.env`, DIR)).toBe(true);
    expect(isInside('/home/me/.autologin-mcp-other', DIR)).toBe(false);
    expect(isInside('/home/me', DIR)).toBe(false);
  });

  it('derives the strings that identify the protected directory', () => {
    expect(needlesFor(DIR, HOME)).toEqual([DIR, '~/.autologin-mcp', '$HOME/.autologin-mcp', '${HOME}/.autologin-mcp', '.autologin-mcp']);
    expect(needlesFor('/srv/creds', HOME)).toEqual(['/srv/creds']);
    expect(needlesFor('/home/me/secret', HOME)).toEqual(['/home/me/secret', '~/secret', '$HOME/secret', '${HOME}/secret']);
  });
});

describe('checkToolCall', () => {
  it.each([
    ['Read', { file_path: `${DIR}/credentials.env` }],
    ['Read', { file_path: '~/.autologin-mcp/credentials.env' }],
    ['Read', { file_path: '../.autologin-mcp/credentials.env' }],
    ['Edit', { file_path: `${DIR}/credentials.env`, old_string: 'a', new_string: 'b' }],
    ['NotebookEdit', { notebook_path: `${DIR}/x.ipynb` }],
    ['Grep', { pattern: 'PASSWORD', path: DIR }],
    ['Glob', { pattern: '**/.autologin-mcp/*' }],
    ['LS', { path: DIR }],
    ['Bash', { command: 'cat ~/.autologin-mcp/credentials.env' }],
    ['Bash', { command: 'cd && grep -r PASSWORD .autologin-mcp' }],
    ['Task', { prompt: 'read $HOME/.autologin-mcp/credentials.env and summarize' }],
    ['mcp__filesystem__read_file', { path: `${DIR}/credentials.env` }],
  ])('blocks %s %j', (tool, input) => {
    expect(check(tool, input)).toContain('autologin-mcp blocked');
  });

  it.each([
    ['mcp__autologin__login', { url: 'https://app.test' }],
    ['Read', { file_path: '/home/me/project/README.md' }],
    ['Write', { file_path: '/home/me/project/README.md', content: 'Credentials live in ~/.autologin-mcp/credentials.env' }],
    ['Grep', { pattern: '.autologin-mcp', path: '/home/me/project/src' }],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Bash', { command: 'npx autologin-mcp list' }],
    ['Bash', {}],
    ['WebFetch', { url: 'https://example.com' }],
  ])('allows %s %j', (tool, input) => {
    expect(check(tool, input)).toBeNull();
  });

  it('handles malformed hook input', () => {
    expect(check(undefined, { prompt: DIR })).toContain('blocked this tool call');
    expect(check('Bash', 'not an object')).toBeNull();
    expect(check('Bash', null)).toBeNull();
  });
});

describe('runGuard', () => {
  it('parses --dir', () => {
    expect(parseDir(['--dir', '/x'])).toBe('/x');
    expect(parseDir(['--other', '--dir=/y'])).toBe('/y');
    expect(parseDir(['--dir'])).toBeNull();
    expect(parseDir([])).toBeNull();
  });

  it('exits 2 with a reason for blocked calls and 0 otherwise', () => {
    const blocked = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/srv/creds/credentials.env' } });
    expect(runGuard(['--dir', '/srv/creds'], blocked, HOME, CWD)).toMatchObject({ code: 2, message: expect.stringContaining('/srv/creds') });
    expect(runGuard([], blocked, HOME, CWD)).toEqual({ code: 0 });
    expect(runGuard(['--dir', '~/.autologin-mcp'], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: `${DIR}/x` } }), HOME, CWD).code).toBe(2);
  });

  it('resolves relative paths from the hook input cwd', () => {
    const input = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'credentials.env' }, cwd: DIR });
    expect(runGuard([], input, HOME, CWD).code).toBe(2);
  });

  it('fails open on unparsable input', () => {
    expect(runGuard([], 'not json', HOME, CWD)).toEqual({ code: 0 });
    expect(runGuard([], 'null', HOME, CWD)).toEqual({ code: 0 });
    expect(runGuard([], '42', HOME, CWD)).toEqual({ code: 0 });
  });
});

describe('main', () => {
  function io(stdinText: string) {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let errors = '';
    stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    const exit = vi.fn();
    main({ stdin, stderr, exit, argv: ['--dir', DIR], home: HOME, cwd: CWD });
    stdin.end(stdinText);
    return { exit, errors: () => errors };
  }

  it('reads the hook input from stdin and exits accordingly', async () => {
    const blocked = io(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat ~/.autologin-mcp/credentials.env' } }));
    await vi.waitFor(() => expect(blocked.exit).toHaveBeenCalledWith(2));
    expect(blocked.errors()).toContain('autologin-mcp blocked Bash');
    const allowed = io(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    await vi.waitFor(() => expect(allowed.exit).toHaveBeenCalledWith(0));
    expect(allowed.errors()).toBe('');
  });
});

describe('isEntry', () => {
  it('detects when the file is run directly', () => {
    expect(isEntry(undefined, import.meta.url)).toBe(false);
    expect(isEntry('/does/not/exist', import.meta.url)).toBe(false);
    expect(isEntry(GUARD_PATH, pathToFileURL(GUARD_PATH).href)).toBe(true);
    expect(isEntry(path.join(path.dirname(GUARD_PATH), '..', 'cli.ts'), pathToFileURL(GUARD_PATH).href)).toBe(false);
  });
});

describe('running the hook file directly', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('reads stdin and exits', async () => {
    vi.resetModules();
    const stdin = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = [argv[0]!, GUARD_PATH, '--dir', DIR];
    await import('../src/hooks/guard.ts');
    stdin.end(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: `${DIR}/credentials.env` } }));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('autologin-mcp blocked Read'));
  });
});
