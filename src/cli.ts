import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createExec, type ExecFn } from './exec.js';
import { install, uninstall } from './installer.js';
import { openDetached, openInEditor, type SpawnFn } from './opener.js';
import { credentialsPath, resolveClaudeDir, resolveConfigDir, type Env } from './paths.js';
import { createPrompter, InputClosedError, type PrompterFactory } from './prompt.js';
import { serve } from './serve.js';
import { appendBlock, ensureEnvFile, loadStore, permissionWarning, readText, removeProfile, renderProfile, writeSecureFile } from './store/envfile.js';
import { parseRootUrl } from './store/match.js';
import { PROFILE_NAME_RE, SETTINGS_PREFIX } from './store/profiles.js';
import { ENV_TEMPLATE } from './templates.js';
import { VERSION } from './version.js';

export interface CliContext {
  env: Env;
  home: string;
  platform: NodeJS.Platform;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  exec: ExecFn;
  spawn: SpawnFn;
  prompter: PrompterFactory;
  serve(): Promise<void>;
  guardSource: string;
}

export const USAGE = `autologin-mcp ${VERSION}: auto-login MCP for AI coding agents

Usage:
  npx autologin-mcp                    Run the MCP server on stdio (what Claude Code starts)
  npx autologin-mcp install [-y] [--dry-run] [--package <spec>]
                                       Register the MCP server, skill and guard hook in Claude Code
                                       (--package: what npx runs, e.g. a local .tgz to test a build)
  npx autologin-mcp uninstall [-y] [--dry-run] [--purge]
                                       Undo install (--purge also deletes your credentials file)
  npx autologin-mcp add [name] [--url <root-url>] [--username <user>]
                                       Add or replace a login profile (the password is asked hidden)
  npx autologin-mcp list               List profiles (passwords are never shown)
  npx autologin-mcp remove <name> [-y] Delete a profile
  npx autologin-mcp edit               Open the credentials file in $VISUAL / $EDITOR or the default editor
  npx autologin-mcp --version | --help

Credentials file: ~/.autologin-mcp/credentials.env (override the folder with AUTOLOGIN_HOME).
Run add/edit in a separate terminal, never inside an AI chat.
`;

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: { yes: boolean; dryRun: boolean; purge: boolean; help: boolean; version: boolean; url?: string; username?: string; package?: string };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = { yes: false, dryRun: false, purge: false, help: false, version: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '-y' || name === '--yes') flags.yes = true;
    else if (name === '--dry-run') flags.dryRun = true;
    else if (name === '--purge') flags.purge = true;
    else if (name === '-h' || name === '--help') flags.help = true;
    else if (name === '-v' || name === '--version') flags.version = true;
    else if (name === '--url' || name === '--username' || name === '--package') {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
      flags[name.slice(2) as 'url' | 'username' | 'package'] = value;
    } else if (name.startsWith('-')) throw new Error(`Unknown option ${name}`);
    else positionals.push(arg);
  }
  return { command: positionals.shift() ?? '', positionals, flags };
}

const line = (stream: Writable, text = ''): void => {
  stream.write(`${text}\n`);
};

async function confirmAction(ctx: CliContext, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (ctx.stdin.isTTY !== true) {
    line(ctx.stderr, 'No terminal to confirm in; re-run with -y to continue.');
    return false;
  }
  const prompter = ctx.prompter(ctx.stdin, ctx.stdout);
  try {
    return await prompter.confirm(question, true);
  } catch {
    return false;
  } finally {
    prompter.close();
  }
}

function credentialsFile(ctx: CliContext): string {
  return credentialsPath(resolveConfigDir(ctx.env, ctx.home));
}

async function addCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const file = credentialsFile(ctx);
  const prompter = ctx.prompter(ctx.stdin, ctx.stdout);
  const fail = (text: string): number => {
    line(ctx.stderr, text);
    return 1;
  };
  try {
    const store = await loadStore(file);
    const name = (args.positionals[0] ?? (await prompter.ask('Profile name (e.g. staging): '))).toLowerCase();
    if (!PROFILE_NAME_RE.test(name) || name.toUpperCase().startsWith(SETTINGS_PREFIX)) {
      return fail(`Invalid profile name "${name}": use letters, digits and _ (not starting with ${SETTINGS_PREFIX.toLowerCase()}).`);
    }
    const exists = store.profiles.some((p) => p.name === name);
    if (exists && !(await prompter.confirm(`Profile "${name}" already exists. Replace it?`, false))) return fail('Cancelled.');

    const urlInput = args.flags.url ?? (await prompter.ask('Root URL (e.g. example.com or localhost:3000): '));
    const parsed = parseRootUrl(urlInput);
    if (!parsed.ok) return fail(parsed.error);
    if (parsed.strippedPath) line(ctx.stdout, `Using the root URL ${parsed.normalized} (the path was removed).`);

    const username = args.flags.username ?? (await prompter.ask('Username: '));
    if (username === '') return fail('A username is required.');
    const password = await prompter.askHidden('Password (hidden): ');
    if (password === '') return fail('A password is required.');
    if ((await prompter.askHidden('Repeat the password: ')) !== password) return fail('The passwords do not match.');

    let block: string;
    try {
      block = renderProfile({ name, url: parsed.normalized, username, password });
    } catch (error) {
      return fail((error as Error).message);
    }
    const current = (await readText(file)) ?? ENV_TEMPLATE;
    const base = exists ? removeProfile(current, name).text : current;
    await writeSecureFile(file, appendBlock(base, block));
    line(ctx.stdout, `✓ Saved profile "${name}" (${parsed.normalized}) to ${file}`);
    line(ctx.stdout, '  The password is stored only in this file and is never shown to the AI.');
    return 0;
  } catch (error) {
    if (error instanceof InputClosedError) return fail(error.message);
    throw error;
  } finally {
    prompter.close();
  }
}

async function listCommand(ctx: CliContext): Promise<number> {
  const file = credentialsFile(ctx);
  const store = await loadStore(file);
  if (!store.exists) {
    line(ctx.stdout, `No credentials file yet (${file}). Run "npx autologin-mcp add" to create one.`);
    return 0;
  }
  line(ctx.stdout, `Credentials file: ${file}`);
  const warning = await permissionWarning(file, ctx.platform);
  if (warning) line(ctx.stderr, `! ${warning}`);
  if (store.profiles.length === 0) line(ctx.stdout, 'No profiles yet. Run "npx autologin-mcp add".');
  const width = Math.max(7, ...store.profiles.map((p) => p.name.length));
  for (const p of store.profiles) {
    const problems = p.problems.length > 0 ? `  ! ${p.problems.join('; ')}` : '';
    line(ctx.stdout, `  ${p.name.padEnd(width)}  ${p.url || '-'}  ${p.username ?? '-'}${problems}`);
  }
  for (const warn of store.warnings) line(ctx.stderr, `! ${warn}`);
  return 0;
}

async function removeCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const name = args.positionals[0]?.toLowerCase();
  if (!name) {
    line(ctx.stderr, 'Usage: npx autologin-mcp remove <name> [-y]');
    return 1;
  }
  const file = credentialsFile(ctx);
  const text = (await readText(file)) ?? '';
  const { text: next, removed } = removeProfile(text, name);
  if (removed === 0) {
    line(ctx.stderr, `No profile named "${name}" in ${file}.`);
    return 1;
  }
  if (!(await confirmAction(ctx, args.flags.yes, `Delete profile "${name}"?`))) return 1;
  await writeSecureFile(file, next);
  line(ctx.stdout, `✓ Removed profile "${name}"`);
  return 0;
}

async function editCommand(ctx: CliContext): Promise<number> {
  const file = credentialsFile(ctx);
  if (await ensureEnvFile(file)) line(ctx.stdout, `Created ${file}`);
  const editor = ctx.env.VISUAL?.trim() || ctx.env.EDITOR?.trim();
  if (editor) return openInEditor(file, editor, ctx.spawn);
  await openDetached(file, ctx.platform, ctx.spawn);
  line(ctx.stdout, `Opened ${file} in your default editor.`);
  return 0;
}

/**
 * A local path (e.g. ./autologin-mcp-1.0.0.tgz) becomes an absolute `file:` spec:
 * npx would try to execute a bare path instead of installing it.
 */
export function packageSpec(spec: string | undefined): string {
  if (spec === undefined) return `autologin-mcp@${VERSION}`;
  return existsSync(spec) ? `file:${path.resolve(spec)}` : spec;
}

function installContext(ctx: CliContext, args: ParsedArgs) {
  return {
    home: ctx.home,
    claudeDir: resolveClaudeDir(ctx.env, ctx.home),
    configDir: resolveConfigDir(ctx.env, ctx.home),
    packageSpec: packageSpec(args.flags.package),
    guardSource: ctx.guardSource,
    exec: ctx.exec,
    log: (text: string) => line(ctx.stdout, text),
  };
}

export function defaultContext(): CliContext {
  return {
    env: process.env,
    home: os.homedir(),
    platform: process.platform,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exec: createExec(),
    spawn,
    prompter: createPrompter,
    serve: () => serve(),
    guardSource: fileURLToPath(new URL('./hooks/guard.js', import.meta.url)),
  };
}

export async function main(argv: string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx: CliContext = { ...defaultContext(), ...overrides };
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    line(ctx.stderr, `${(error as Error).message}\n`);
    line(ctx.stderr, USAGE);
    return 1;
  }
  if (args.flags.version || args.command === 'version') {
    line(ctx.stdout, VERSION);
    return 0;
  }
  if (args.flags.help || args.command === 'help') {
    line(ctx.stdout, USAGE);
    return 0;
  }
  try {
    switch (args.command) {
      case '':
      case 'serve':
        await ctx.serve();
        return 0;
      case 'install':
        if (!args.flags.dryRun && !(await confirmAction(ctx, args.flags.yes, 'Install autologin-mcp into Claude Code?'))) return 1;
        return (await install(installContext(ctx, args), { dryRun: args.flags.dryRun })) ? 0 : 1;
      case 'uninstall':
        if (!args.flags.dryRun && !(await confirmAction(ctx, args.flags.yes, 'Remove autologin-mcp from Claude Code?'))) return 1;
        return (await uninstall(installContext(ctx, args), { dryRun: args.flags.dryRun, purge: args.flags.purge })) ? 0 : 1;
      case 'add':
        return await addCommand(ctx, args);
      case 'list':
        return await listCommand(ctx);
      case 'remove':
        return await removeCommand(ctx, args);
      case 'edit':
        return await editCommand(ctx);
      default:
        line(ctx.stderr, `Unknown command "${args.command}".\n`);
        line(ctx.stderr, USAGE);
        return 1;
    }
  } catch (error) {
    line(ctx.stderr, `Error: ${(error as Error).message}`);
    return 1;
  }
}
