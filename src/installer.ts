import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecFn } from './exec.js';
import { credentialsPath } from './paths.js';
import { ensureEnvFile } from './store/envfile.js';
import { SKILL_MD } from './templates.js';

export const SERVER_NAME = 'autologin';
export const GUARD_FILE = 'autologin-guard.mjs';
const GUARD_MARKER = 'autologin-guard';

export interface InstallContext {
  home: string;
  claudeDir: string;
  configDir: string;
  /** What `npx -y` runs: `autologin-mcp@<version>`, or a local .tgz / git ref to test unpublished builds. */
  packageSpec: string;
  /** Compiled guard hook (dist/hooks/guard.js) copied into Claude's hooks directory. */
  guardSource: string;
  exec: ExecFn;
  log(line: string): void;
}

type Json = Record<string, unknown>;
interface ClaudeSettings extends Json {
  hooks?: Record<string, unknown[]>;
  permissions?: Json & { deny?: string[] };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mcpAddArgs(packageSpec: string): string[] {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', 'npx', '-y', packageSpec];
}

export const MCP_REMOVE_ARGS = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];

export function guardCommand(hookPath: string, configDir: string): string {
  return `node "${hookPath}" --dir "${configDir}"`;
}

/** Claude Code permission rules: `~/` is relative to home, `//` is an absolute path. */
export function denyRules(configDir: string, home: string): string[] {
  const rel = path.relative(home, configDir);
  const inHome = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const pattern = inHome ? `~/${rel.split(path.sep).join('/')}/**` : `/${configDir.split(path.sep).join('/')}/**`;
  return [`Read(${pattern})`, `Edit(${pattern})`];
}

const isOurs = (entry: unknown): boolean => JSON.stringify(entry).includes(GUARD_MARKER);

export function addToSettings(settings: ClaudeSettings, command: string, rules: string[]): ClaudeSettings {
  const next = structuredClone(settings);
  const hooks = (next.hooks ??= {});
  const pre = (hooks.PreToolUse ?? []).filter((entry) => !isOurs(entry));
  pre.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] });
  hooks.PreToolUse = pre;
  const permissions = (next.permissions ??= {});
  const deny = permissions.deny ?? [];
  permissions.deny = [...deny, ...rules.filter((rule) => !deny.includes(rule))];
  return next;
}

export function removeFromSettings(settings: ClaudeSettings, rules: string[]): ClaudeSettings {
  const next = structuredClone(settings);
  const pre = next.hooks?.PreToolUse;
  if (pre) {
    const kept = pre.filter((entry) => !isOurs(entry));
    if (kept.length > 0) next.hooks!.PreToolUse = kept;
    else delete next.hooks!.PreToolUse;
  }
  const deny = next.permissions?.deny;
  if (deny) next.permissions!.deny = deny.filter((rule) => !rules.includes(rule));
  return next;
}

export async function readSettings(file: string): Promise<ClaudeSettings | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed as ClaudeSettings;
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${message(error)}); fix it first, nothing was changed.`);
  }
}

async function writeSettings(file: string, settings: ClaudeSettings, hadFile: boolean): Promise<void> {
  if (hadFile) await fs.copyFile(file, `${file}.autologin-backup`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function paths(ctx: InstallContext) {
  return {
    hook: path.join(ctx.claudeDir, 'hooks', GUARD_FILE),
    skillDir: path.join(ctx.claudeDir, 'skills', SERVER_NAME),
    settings: path.join(ctx.claudeDir, 'settings.json'),
    credentials: credentialsPath(ctx.configDir),
  };
}

async function registerMcp(ctx: InstallContext): Promise<boolean> {
  const args = mcpAddArgs(ctx.packageSpec);
  try {
    await ctx.exec('claude', MCP_REMOVE_ARGS);
    const result = await ctx.exec('claude', args);
    if (result.code === 0) {
      ctx.log(`✓ Registered MCP server "${SERVER_NAME}" for Claude Code (user scope, ${ctx.packageSpec})`);
      return true;
    }
    ctx.log(`✗ "claude mcp add" failed: ${result.stderr.trim() || result.stdout.trim()}`);
  } catch (error) {
    ctx.log(`✗ Could not run the claude CLI (${message(error)}).`);
  }
  ctx.log(`  Register it manually: claude ${args.join(' ')}`);
  return false;
}

/** Registers the MCP server, skill, guard hook and deny rules. Returns false if a step needs manual action. */
export async function install(ctx: InstallContext, options: { dryRun: boolean }): Promise<boolean> {
  const p = paths(ctx);
  if (options.dryRun) {
    ctx.log('Dry run, nothing will be changed. install would:');
    ctx.log(`  • run: claude ${mcpAddArgs(ctx.packageSpec).join(' ')}`);
    ctx.log(`  • write the skill: ${path.join(p.skillDir, 'SKILL.md')}`);
    ctx.log(`  • install the guard hook: ${p.hook}`);
    ctx.log(`  • add the hook and deny rules (${denyRules(ctx.configDir, ctx.home).join(', ')}) to ${p.settings}`);
    ctx.log(`  • create the credentials file if missing: ${p.credentials}`);
    return true;
  }

  const settings = await readSettings(p.settings);
  const registered = await registerMcp(ctx);

  await fs.mkdir(p.skillDir, { recursive: true });
  await fs.writeFile(path.join(p.skillDir, 'SKILL.md'), SKILL_MD);
  ctx.log(`✓ Wrote the skill: ${path.join(p.skillDir, 'SKILL.md')}`);

  await fs.mkdir(path.dirname(p.hook), { recursive: true });
  await fs.copyFile(ctx.guardSource, p.hook);
  await fs.chmod(p.hook, 0o755);
  const next = addToSettings(settings ?? {}, guardCommand(p.hook, ctx.configDir), denyRules(ctx.configDir, ctx.home));
  await writeSettings(p.settings, next, settings !== null);
  ctx.log(`✓ Installed the guard hook and deny rules that keep ${ctx.configDir} away from the model`);

  const created = await ensureEnvFile(p.credentials);
  ctx.log(created ? `✓ Created ${p.credentials} (permissions 600)` : `• Kept your existing ${p.credentials}`);

  ctx.log('');
  ctx.log('Next steps:');
  ctx.log('  1. In Chrome (144+) open chrome://inspect/#remote-debugging and turn remote debugging on.');
  ctx.log('  2. Add a login profile: npx autologin-mcp add');
  ctx.log('  3. Restart Claude Code so it loads the "autologin" MCP server.');
  return registered;
}

export async function uninstall(ctx: InstallContext, options: { dryRun: boolean; purge: boolean }): Promise<boolean> {
  const p = paths(ctx);
  if (options.dryRun) {
    ctx.log('Dry run, nothing will be changed. uninstall would:');
    ctx.log(`  • run: claude ${MCP_REMOVE_ARGS.join(' ')}`);
    ctx.log(`  • delete ${p.skillDir} and ${p.hook}`);
    ctx.log(`  • remove the hook and deny rules from ${p.settings}`);
    ctx.log(options.purge ? `  • delete ${ctx.configDir} (your credentials)` : `  • keep ${p.credentials}`);
    return true;
  }

  const settings = await readSettings(p.settings);
  let ok = true;
  try {
    const result = await ctx.exec('claude', MCP_REMOVE_ARGS);
    ctx.log(result.code === 0 ? `✓ Removed MCP server "${SERVER_NAME}"` : `• MCP server "${SERVER_NAME}" was not registered`);
  } catch (error) {
    ok = false;
    ctx.log(`✗ Could not run the claude CLI (${message(error)}). Remove it manually: claude ${MCP_REMOVE_ARGS.join(' ')}`);
  }
  await fs.rm(p.skillDir, { recursive: true, force: true });
  await fs.rm(p.hook, { force: true });
  if (settings !== null) await writeSettings(p.settings, removeFromSettings(settings, denyRules(ctx.configDir, ctx.home)), true);
  ctx.log('✓ Removed the skill, the guard hook and the deny rules');
  if (options.purge) {
    await fs.rm(ctx.configDir, { recursive: true, force: true });
    ctx.log(`✓ Deleted ${ctx.configDir}`);
  } else {
    ctx.log(`• Kept your credentials file ${p.credentials} (run with --purge to delete it)`);
  }
  return ok;
}
