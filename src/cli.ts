import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { clientConfig, CLIENTS } from './clients.js';
import { createExec, type ExecFn } from './exec.js';
import { install, uninstall } from './installer.js';
import { openDetached, openInEditor, type SpawnFn } from './opener.js';
import { credentialsPath, resolveClaudeDir, resolveConfigDir, type Env } from './paths.js';
import { createPrompter, InputClosedError, type PrompterFactory } from './prompt.js';
import { serve } from './serve.js';
import { appendBlock, ensureEnvFile, loadStore, permissionWarning, readText, removeProfile, renderProfile, writeSecureFile } from './store/envfile.js';
import { parseRootUrl } from './store/match.js';
import { PROFILE_NAME_RE, SETTINGS_PREFIX } from './store/profiles.js';
import { parseTotpSecret } from './totp.js';
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
  npx autologin-mcp add [name] [--url <root-url>] [--username <user>] [--totp] [-y]
                                       Add or replace a login profile (the password is asked hidden;
                                       --totp also asks for a TOTP secret, for one-time codes)
  npx autologin-mcp add <name> --url <root-url> --username <user> --password-stdin [--totp] [-y]
                                       Same, with the password piped in (scripts, CI); with --totp,
                                       pipe two lines: the password, then the TOTP secret
  npx autologin-mcp list               List profiles (passwords are never shown)
  npx autologin-mcp remove <name> [-y] Delete a profile
  npx autologin-mcp edit               Open the credentials file in $VISUAL / $EDITOR or the default editor
  npx autologin-mcp print-config [--client <name>] [--package <spec>]
                                       Print the MCP server config for another agent: json (default),
                                       claude-desktop, cursor, vscode, gemini, codex or hermes
  npx autologin-mcp --version | --help

Credentials file: ~/.autologin-mcp/credentials.env (override the folder with AUTOLOGIN_HOME).
Run add/edit in a separate terminal, never inside an AI chat.
`;

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: {
    yes: boolean;
    dryRun: boolean;
    purge: boolean;
    help: boolean;
    version: boolean;
    passwordStdin: boolean;
    /** Also store a TOTP secret: asked hidden, or the second piped line with --password-stdin (#1). */
    totp?: boolean;
    url?: string;
    username?: string;
    package?: string;
    client?: string;
  };
}

export const NO_PASSWORD_FLAG =
  '--password is not supported: it would leave the password in your shell history and the process list. Pipe it in with --password-stdin instead.';

export const NO_TOTP_VALUE =
  '--totp takes no value: a secret on the command line stays in your shell history. Put the profile name before --totp; the secret is asked hidden, or piped in as the second line with --password-stdin.';

const TOTP_STDIN = 'With --totp, pipe two lines: the password, then the TOTP secret.';

/** What is wrong with a TOTP secret typed or piped in, or null. */
function totpProblem(secret: string): string | null {
  if (secret.trim() === '') return 'A TOTP secret is required with --totp.';
  const parsed = parseTotpSecret(secret);
  return parsed.ok ? null : `The TOTP secret is not usable: ${parsed.error}`;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = { yes: false, dryRun: false, purge: false, help: false, version: false, passwordStdin: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (name === '-y' || name === '--yes') flags.yes = true;
    else if (name === '--dry-run') flags.dryRun = true;
    else if (name === '--purge') flags.purge = true;
    else if (name === '-h' || name === '--help') flags.help = true;
    else if (name === '-v' || name === '--version') flags.version = true;
    else if (name === '--password-stdin') flags.passwordStdin = true;
    else if (name === '--password') throw new Error(NO_PASSWORD_FLAG);
    else if (name === '--totp') {
      // A word right after it is most likely the secret: as a profile name it would be written to the file
      // and shown to the agent.
      const next = argv[i + 1];
      if (inline !== undefined || (next !== undefined && !next.startsWith('-'))) throw new Error(NO_TOTP_VALUE);
      flags.totp = true;
    }
    else if (name === '--url' || name === '--username' || name === '--package' || name === '--client') {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
      flags[name.slice(2) as 'url' | 'username' | 'package' | 'client'] = value;
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

const invalidName = (name: string): string | null =>
  PROFILE_NAME_RE.test(name) && !name.toUpperCase().startsWith(SETTINGS_PREFIX)
    ? null
    : `Invalid profile name "${name}": use letters, digits and _ (not starting with ${SETTINGS_PREFIX.toLowerCase()}).`;

/** Writes the profile, replacing an existing one with the same name. Returns an error message or null. */
async function saveProfile(
  ctx: CliContext,
  file: string,
  profile: { name: string; url: string; username: string; password: string; totpSecret?: string },
  exists: boolean,
): Promise<string | null> {
  let block: string;
  try {
    block = renderProfile(profile);
  } catch (error) {
    return (error as Error).message;
  }
  const current = (await readText(file)) ?? ENV_TEMPLATE;
  const base = exists ? removeProfile(current, profile.name).text : current;
  await writeSecureFile(file, appendBlock(base, block));
  line(ctx.stdout, `✓ Saved profile "${profile.name}" (${profile.url}) to ${file}`);
  line(ctx.stdout, '  The password is stored only in this file and is never shown to the AI.');
  if (profile.totpSecret !== undefined) line(ctx.stdout, '  So is the TOTP secret: autologin-mcp makes the one-time codes itself. Use it for test accounts only.');
  return null;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer | string));
  return Buffer.concat(chunks).toString('utf8');
}

export const STDIN_EXAMPLE = `printf '%s' "$PASSWORD" | npx autologin-mcp add staging --url staging.example.com --username qa@example.com --password-stdin`;

/** `add --password-stdin`: no questions, for scripts and CI (like `docker login --password-stdin`). */
async function addFromStdin(ctx: CliContext, args: ParsedArgs, file: string, fail: (text: string) => number): Promise<number> {
  const name = args.positionals[0]?.toLowerCase();
  const { url, username } = args.flags;
  if (name === undefined || url === undefined || username === undefined) {
    return fail(`--password-stdin needs the profile name, --url and --username, for example:\n  ${STDIN_EXAMPLE}`);
  }
  if (ctx.stdin.isTTY === true) return fail('--password-stdin reads the password from a pipe, not from the keyboard. Leave it out to type the password hidden.');
  const nameError = invalidName(name);
  if (nameError !== null) return fail(nameError);
  const parsed = parseRootUrl(url);
  if (!parsed.ok) return fail(parsed.error);
  if (username === '') return fail('A username is required.');
  // One trailing newline (from echo or a here-string) is not part of the password.
  const input = (await readAll(ctx.stdin)).replace(/\r?\n$/, '');
  let password = input;
  let totpSecret: string | undefined;
  if (args.flags.totp) {
    const lines = input.split(/\r?\n/);
    if (lines.length !== 2) return fail(TOTP_STDIN);
    [password, totpSecret] = lines as [string, string];
  }
  if (password === '') return fail('A password is required: nothing was piped in.');
  if (/[\r\n]/.test(password)) return fail('The password must be a single line.');
  const problem = totpSecret === undefined ? null : totpProblem(totpSecret);
  if (problem !== null) return fail(problem);
  const store = await loadStore(file);
  const exists = store.profiles.some((p) => p.name === name);
  if (exists && !args.flags.yes) return fail(`Profile "${name}" already exists. Add -y to replace it.`);
  const error = await saveProfile(ctx, file, { name, url: parsed.normalized, username, password, totpSecret: totpSecret?.trim() }, exists);
  return error === null ? 0 : fail(error);
}

async function addCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const file = credentialsFile(ctx);
  const fail = (text: string): number => {
    line(ctx.stderr, text);
    return 1;
  };
  if (args.positionals.length > 1) return fail('add takes one profile name. A password or TOTP secret is never an argument: they are asked hidden, or piped in.');
  if (args.flags.passwordStdin) return addFromStdin(ctx, args, file, fail);
  const prompter = ctx.prompter(ctx.stdin, ctx.stdout);
  try {
    const store = await loadStore(file);
    const name = (args.positionals[0] ?? (await prompter.ask('Profile name (e.g. staging): '))).toLowerCase();
    const nameError = invalidName(name);
    if (nameError !== null) return fail(nameError);
    const exists = store.profiles.some((p) => p.name === name);
    if (exists && !args.flags.yes && !(await prompter.confirm(`Profile "${name}" already exists. Replace it?`, false))) return fail('Cancelled.');

    const urlInput = args.flags.url ?? (await prompter.ask('Root URL (e.g. example.com or localhost:3000): '));
    const parsed = parseRootUrl(urlInput);
    if (!parsed.ok) return fail(parsed.error);
    if (parsed.strippedPath) line(ctx.stdout, `Using the root URL ${parsed.normalized} (the path was removed).`);

    const username = args.flags.username ?? (await prompter.ask('Username: '));
    if (username === '') return fail('A username is required.');
    const password = await prompter.askHidden('Password (hidden): ');
    if (password === '') return fail('A password is required.');
    if ((await prompter.askHidden('Repeat the password: ')) !== password) return fail('The passwords do not match.');
    let totpSecret: string | undefined;
    if (args.flags.totp) {
      totpSecret = await prompter.askHidden('TOTP secret or otpauth:// URI (hidden): ');
      const problem = totpProblem(totpSecret);
      if (problem !== null) return fail(problem);
    }

    const error = await saveProfile(ctx, file, { name, url: parsed.normalized, username, password, totpSecret: totpSecret?.trim() }, exists);
    return error === null ? 0 : fail(error);
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
    line(ctx.stdout, `  ${p.name.padEnd(width)}  ${p.url || '-'}  ${p.username ?? '-'}${p.totp !== undefined ? '  TOTP' : ''}${problems}`);
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
  try {
    await openDetached(file, ctx.platform, { spawn: ctx.spawn, env: ctx.env });
  } catch (error) {
    line(ctx.stderr, `Could not open an editor (${(error as Error).message}).`);
    line(ctx.stderr, `Set one for this command, e.g. EDITOR=nano npx autologin-mcp edit, or open ${file} yourself.`);
    line(ctx.stderr, 'To add a profile without an editor: npx autologin-mcp add');
    return 1;
  }
  line(ctx.stdout, `Opened ${file} in your default editor.`);
  return 0;
}

/** `~/...` for a path inside the home folder, for messages. */
function displayPath(target: string, home: string): string {
  const rel = path.relative(home, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : target;
}

/** Prints the MCP server entry for a client other than Claude Code: the config on stdout, the notes on stderr. */
function printConfigCommand(ctx: CliContext, args: ParsedArgs): number {
  const id = (args.flags.client ?? 'json').toLowerCase();
  const config = clientConfig(id, packageSpec(args.flags.package));
  if (config === null) {
    line(ctx.stderr, `Unknown client "${id}". Choose one of: ${CLIENTS.join(', ')}.`);
    line(ctx.stderr, 'For Claude Code, run "npx autologin-mcp install": it also adds the skill and the guard hook.');
    return 1;
  }
  ctx.stdout.write(config.snippet);
  const dir = displayPath(resolveConfigDir(ctx.env, ctx.home), ctx.home);
  line(ctx.stderr);
  line(ctx.stderr, `Add this to ${config.where}.`);
  if (config.command) line(ctx.stderr, `Or run: ${config.command}`);
  if (config.note) line(ctx.stderr, config.note);
  line(ctx.stderr, 'Then add a login profile in a terminal, never in the AI chat: npx autologin-mcp add');
  line(ctx.stderr, '');
  line(ctx.stderr, `! Only Claude Code has the guard hook that keeps the agent out of ${dir}.`);
  line(ctx.stderr, `  ${config.name === 'your MCP client' ? 'Your client' : config.name} gets the server's instruction not to read that folder, but nothing enforces it;`);
  line(ctx.stderr, "  deny the folder in the client's permission settings if it has them.");
  line(ctx.stderr, `  Tested with Claude Code; reports for other clients: ${ISSUES_URL}`);
  return 0;
}

export const ISSUES_URL = 'https://github.com/olgaysezgin/autologin-mcp/issues';

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
      case 'print-config':
        return printConfigCommand(ctx, args);
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
