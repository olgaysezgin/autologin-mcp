import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFn } from '../src/exec.ts';
import {
  addToSettings,
  denyRules,
  guardCommand,
  install,
  mcpAddArgs,
  readSettings,
  removeFromSettings,
  uninstall,
  type InstallContext,
} from '../src/installer.ts';
import { SKILL_MD } from '../src/templates.ts';

let home: string;
let logs: string[];
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'autologin-install-'));
  logs = [];
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function context(exec: ExecFn = async () => ({ code: 0, stdout: '', stderr: '' })): InstallContext & { exec: ReturnType<typeof vi.fn> } {
  const guardSource = path.join(home, 'guard.js');
  return {
    home,
    claudeDir: path.join(home, '.claude'),
    configDir: path.join(home, '.autologin-mcp'),
    packageSpec: 'autologin-mcp@1.2.3',
    guardSource,
    exec: vi.fn(exec),
    log: (line) => logs.push(line),
  };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe('settings helpers', () => {
  const command = guardCommand('/h/.claude/hooks/autologin-guard.mjs', '/h/.autologin-mcp');
  const rules = denyRules('/h/.autologin-mcp', '/h');

  it('builds commands and rules', () => {
    expect(mcpAddArgs('autologin-mcp@1.2.3')).toEqual(['mcp', 'add', '--scope', 'user', 'autologin', '--', 'npx', '-y', 'autologin-mcp@1.2.3']);
    expect(command).toBe('node "/h/.claude/hooks/autologin-guard.mjs" --dir "/h/.autologin-mcp"');
    expect(rules).toEqual(['Read(~/.autologin-mcp/**)', 'Edit(~/.autologin-mcp/**)']);
    expect(denyRules('/srv/creds', '/h')).toEqual(['Read(//srv/creds/**)', 'Edit(//srv/creds/**)']);
    expect(denyRules('/h', '/h')).toEqual(['Read(//h/**)', 'Edit(//h/**)']);
  });

  it('adds the hook and rules idempotently, keeping existing settings', () => {
    const existing = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Grep', hooks: [{ type: 'command', command: 'other' }] }], Stop: [] },
      permissions: { deny: ['Read(./.env)'], defaultMode: 'auto' },
    };
    const once = addToSettings(existing, command, rules);
    const twice = addToSettings(once, command, rules);
    expect(twice).toEqual(once);
    expect(once.model).toBe('opus');
    expect(once.hooks!.PreToolUse).toHaveLength(2);
    expect(once.hooks!.PreToolUse![1]).toEqual({ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] });
    expect(once.permissions).toEqual({ deny: ['Read(./.env)', ...rules], defaultMode: 'auto' });
    expect(existing.hooks.PreToolUse).toHaveLength(1);
    expect(addToSettings({}, command, rules)).toEqual({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }] },
      permissions: { deny: rules },
    });
  });

  it('removes only what install added', () => {
    const installed = addToSettings({ hooks: { PreToolUse: [{ matcher: 'Grep', hooks: [] }] }, permissions: { deny: ['Read(./.env)'] } }, command, rules);
    expect(removeFromSettings(installed, rules)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Grep', hooks: [] }] }, permissions: { deny: ['Read(./.env)'] } });
    expect(removeFromSettings(addToSettings({}, command, rules), rules)).toEqual({ hooks: {}, permissions: { deny: [] } });
    expect(removeFromSettings({ theme: 'dark' }, rules)).toEqual({ theme: 'dark' });
  });

  it('reads settings safely', async () => {
    const file = path.join(home, 'settings.json');
    expect(await readSettings(file)).toBeNull();
    await fs.writeFile(file, '{"a":1}');
    expect(await readSettings(file)).toEqual({ a: 1 });
    await fs.writeFile(file, '{oops');
    await expect(readSettings(file)).rejects.toThrow(/is not valid JSON/);
    await fs.writeFile(file, '[1]');
    await expect(readSettings(file)).rejects.toThrow(/not a JSON object/);
    await expect(readSettings(home)).rejects.toThrow();
  });
});

describe('install', () => {
  it('only describes the changes in a dry run', async () => {
    const ctx = context();
    expect(await install(ctx, { dryRun: true })).toBe(true);
    expect(ctx.exec).not.toHaveBeenCalled();
    expect(await exists(ctx.claudeDir)).toBe(false);
    expect(logs.join('\n')).toContain('claude mcp add --scope user autologin -- npx -y autologin-mcp@1.2.3');
  });

  it('registers the server, skill, hook, deny rules and credentials file', async () => {
    const ctx = context();
    await fs.writeFile(ctx.guardSource, '// guard');
    await fs.mkdir(ctx.claudeDir, { recursive: true });
    await fs.writeFile(path.join(ctx.claudeDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));

    expect(await install(ctx, { dryRun: false })).toBe(true);
    expect(ctx.exec.mock.calls).toEqual([
      ['claude', ['mcp', 'remove', '--scope', 'user', 'autologin']],
      ['claude', mcpAddArgs('autologin-mcp@1.2.3')],
    ]);
    expect(await fs.readFile(path.join(ctx.claudeDir, 'skills', 'autologin', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    const hook = path.join(ctx.claudeDir, 'hooks', 'autologin-guard.mjs');
    expect(await fs.readFile(hook, 'utf8')).toBe('// guard');
    if (process.platform !== 'win32') expect((await fs.stat(hook)).mode & 0o777).toBe(0o755);
    const settings = JSON.parse(await fs.readFile(path.join(ctx.claudeDir, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('autologin-guard.mjs');
    expect(settings.permissions.deny).toEqual(['Read(~/.autologin-mcp/**)', 'Edit(~/.autologin-mcp/**)']);
    expect(JSON.parse(await fs.readFile(path.join(ctx.claudeDir, 'settings.json.autologin-backup'), 'utf8'))).toEqual({ theme: 'dark' });
    expect(await exists(path.join(ctx.configDir, 'credentials.env'))).toBe(true);
    expect(logs).toContain(`✓ Created ${path.join(ctx.configDir, 'credentials.env')} (permissions 600)`);

    logs = [];
    await install(ctx, { dryRun: false });
    expect(logs).toContain(`• Kept your existing ${path.join(ctx.configDir, 'credentials.env')}`);
  });

  it('works without an existing settings.json', async () => {
    const ctx = context();
    await fs.writeFile(ctx.guardSource, '// guard');
    await install(ctx, { dryRun: false });
    expect(await exists(path.join(ctx.claudeDir, 'settings.json.autologin-backup'))).toBe(false);
    expect(await exists(path.join(ctx.claudeDir, 'settings.json'))).toBe(true);
  });

  it('prints the manual command when the claude CLI fails or is missing', async () => {
    for (const exec of [
      async () => ({ code: 1, stdout: '', stderr: 'boom\n' }),
      async () => ({ code: 1, stdout: 'only stdout', stderr: '' }),
      async () => Promise.reject(new Error('spawn claude ENOENT')),
      async () => Promise.reject('weird'),
    ] as ExecFn[]) {
      const ctx = context(exec);
      await fs.writeFile(ctx.guardSource, '// guard');
      expect(await install(ctx, { dryRun: false })).toBe(false);
    }
    expect(logs).toContain('✗ "claude mcp add" failed: boom');
    expect(logs).toContain('✗ "claude mcp add" failed: only stdout');
    expect(logs).toContain('✗ Could not run the claude CLI (spawn claude ENOENT).');
    expect(logs).toContain('✗ Could not run the claude CLI (weird).');
    expect(logs).toContain('  Register it manually: claude mcp add --scope user autologin -- npx -y autologin-mcp@1.2.3');
  });

  it('changes nothing when settings.json is broken', async () => {
    const ctx = context();
    await fs.mkdir(ctx.claudeDir, { recursive: true });
    await fs.writeFile(path.join(ctx.claudeDir, 'settings.json'), '{broken');
    await expect(install(ctx, { dryRun: false })).rejects.toThrow(/not valid JSON/);
    expect(ctx.exec).not.toHaveBeenCalled();
  });
});

describe('uninstall', () => {
  async function installed() {
    const ctx = context();
    await fs.writeFile(ctx.guardSource, '// guard');
    await install(ctx, { dryRun: false });
    logs = [];
    return ctx;
  }

  it('describes the changes in a dry run', async () => {
    const ctx = context();
    expect(await uninstall(ctx, { dryRun: true, purge: false })).toBe(true);
    expect(logs.join('\n')).toContain('keep');
    logs = [];
    await uninstall(ctx, { dryRun: true, purge: true });
    expect(logs.join('\n')).toContain('(your credentials)');
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('copes with a machine where nothing was installed', async () => {
    const ctx = context();
    expect(await uninstall(ctx, { dryRun: false, purge: false })).toBe(true);
    expect(await exists(path.join(ctx.claudeDir, 'settings.json'))).toBe(false);
  });

  it('removes everything install added but keeps the credentials', async () => {
    const ctx = await installed();
    expect(await uninstall(ctx, { dryRun: false, purge: false })).toBe(true);
    expect(await exists(path.join(ctx.claudeDir, 'skills', 'autologin'))).toBe(false);
    expect(await exists(path.join(ctx.claudeDir, 'hooks', 'autologin-guard.mjs'))).toBe(false);
    const settings = JSON.parse(await fs.readFile(path.join(ctx.claudeDir, 'settings.json'), 'utf8'));
    expect(settings).toEqual({ hooks: {}, permissions: { deny: [] } });
    expect(await exists(path.join(ctx.configDir, 'credentials.env'))).toBe(true);
    expect(logs[0]).toBe('✓ Removed MCP server "autologin"');
  });

  it('purges the credentials on request and copes with a missing CLI or registration', async () => {
    const ctx = await installed();
    ctx.exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'not found' });
    expect(await uninstall(ctx, { dryRun: false, purge: true })).toBe(true);
    expect(logs[0]).toBe('• MCP server "autologin" was not registered');
    expect(await exists(ctx.configDir)).toBe(false);

    const bare = context(async () => Promise.reject(new Error('ENOENT')));
    expect(await uninstall(bare, { dryRun: false, purge: false })).toBe(false);
    expect(logs.some((l) => l.startsWith('✗ Could not run the claude CLI (ENOENT)'))).toBe(true);
  });
});
