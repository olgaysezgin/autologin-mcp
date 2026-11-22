import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialsPath, resolveClaudeDir, resolveConfigDir } from '../src/paths.ts';

describe('paths', () => {
  it('defaults to folders in the home directory', () => {
    expect(resolveConfigDir({}, '/home/me')).toBe(path.join('/home/me', '.autologin-mcp'));
    expect(resolveClaudeDir({}, '/home/me')).toBe(path.join('/home/me', '.claude'));
    expect(resolveConfigDir()).toBe(process.env.AUTOLOGIN_HOME ? path.resolve(process.env.AUTOLOGIN_HOME) : path.join(os.homedir(), '.autologin-mcp'));
    expect(resolveClaudeDir().length).toBeGreaterThan(0);
  });

  it('honours AUTOLOGIN_HOME and CLAUDE_CONFIG_DIR (ignoring blanks)', () => {
    expect(resolveConfigDir({ AUTOLOGIN_HOME: '/srv/creds' }, '/home/me')).toBe(path.resolve('/srv/creds'));
    expect(resolveConfigDir({ AUTOLOGIN_HOME: '  ' }, '/home/me')).toBe(path.join('/home/me', '.autologin-mcp'));
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/opt/claude' }, '/home/me')).toBe(path.resolve('/opt/claude'));
    expect(credentialsPath('/x')).toBe(path.join('/x', 'credentials.env'));
  });
});
