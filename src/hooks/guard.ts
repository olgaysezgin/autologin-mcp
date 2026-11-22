/*
 * Claude Code PreToolUse hook: blocks any tool call that would read or list the
 * credentials directory, so its content can never reach the model.
 * Installed as a standalone file (~/.claude/hooks/autologin-guard.mjs): node builtins only.
 */
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

const DEFAULT_DIR = '.autologin-mcp';
const FILE_KEYS = ['file_path', 'notebook_path', 'path'];
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS']);

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export function isInside(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Strings that identify the protected directory inside free text (shell commands, prompts, ...). */
export function needlesFor(protectedDir: string, home: string): string[] {
  const needles = new Set([protectedDir]);
  const rel = path.relative(home, protectedDir);
  if (rel !== '' && isInside(protectedDir, home)) {
    const posix = rel.split(path.sep).join('/');
    needles.add(`~/${posix}`);
    needles.add(`$HOME/${posix}`);
    needles.add(`\${HOME}/${posix}`);
  }
  if (path.basename(protectedDir) === DEFAULT_DIR) needles.add(DEFAULT_DIR);
  return [...needles];
}

/** Returns the reason to block the call, or null to allow it. */
export function checkToolCall(input: HookInput, protectedDir: string, home: string, cwd: string): string | null {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (tool.startsWith('mcp__autologin__')) return null;
  const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;
  const needles = needlesFor(protectedDir, home);
  const mentions = (text: string): boolean => needles.some((n) => text.includes(n) || text.includes(JSON.stringify(n).slice(1, -1)));
  const reason =
    `autologin-mcp blocked ${tool || 'this tool call'}: ${protectedDir} holds credentials that must never enter the model context. ` +
    'Use the autologin MCP tools (list_profiles, login, open_config) instead.';

  for (const key of FILE_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && isInside(path.resolve(cwd, expandHome(value, home)), protectedDir)) return reason;
  }
  if (tool === 'Glob' && typeof toolInput.pattern === 'string' && mentions(toolInput.pattern)) return reason;
  if (FILE_TOOLS.has(tool)) return null;
  if (tool === 'Bash') return typeof toolInput.command === 'string' && mentions(toolInput.command) ? reason : null;
  return mentions(JSON.stringify(toolInput)) ? reason : null;
}

export function parseDir(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dir' && argv[i + 1] !== undefined) return argv[i + 1]!;
    if (arg.startsWith('--dir=')) return arg.slice('--dir='.length);
  }
  return null;
}

export function runGuard(argv: string[], stdinText: string, home: string, cwd: string): { code: 0 | 2; message?: string } {
  let input: unknown;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return { code: 0 };
  }
  if (typeof input !== 'object' || input === null) return { code: 0 };
  const hookInput = input as HookInput;
  const dir = path.resolve(expandHome(parseDir(argv) ?? path.join(home, DEFAULT_DIR), home));
  const effectiveCwd = typeof hookInput.cwd === 'string' ? hookInput.cwd : cwd;
  const reason = checkToolCall(hookInput, dir, home, effectiveCwd);
  return reason === null ? { code: 0 } : { code: 2, message: reason };
}

export interface GuardIo {
  stdin: NodeJS.ReadableStream;
  stderr: NodeJS.WritableStream;
  exit(code: number): void;
  argv: string[];
  home: string;
  cwd: string;
}

export function main(io: GuardIo): void {
  let data = '';
  io.stdin.setEncoding('utf8');
  io.stdin.on('data', (chunk: string) => {
    data += chunk;
  });
  io.stdin.on('end', () => {
    const result = runGuard(io.argv, data, io.home, io.cwd);
    if (result.message) io.stderr.write(`${result.message}\n`);
    io.exit(result.code);
  });
}

export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  main({
    stdin: process.stdin,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
    argv: process.argv.slice(2),
    home: os.homedir(),
    cwd: process.cwd(),
  });
}
