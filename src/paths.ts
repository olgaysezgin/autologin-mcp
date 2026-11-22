import os from 'node:os';
import path from 'node:path';

export type Env = Record<string, string | undefined>;

export const DEFAULT_DIR_NAME = '.autologin-mcp';

/** Directory that holds the credentials file. `AUTOLOGIN_HOME` overrides the default `~/.autologin-mcp`. */
export function resolveConfigDir(env: Env = process.env, home: string = os.homedir()): string {
  const override = env.AUTOLOGIN_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, DEFAULT_DIR_NAME);
}

export function credentialsPath(configDir: string): string {
  return path.join(configDir, 'credentials.env');
}

/** Claude Code's config directory. `CLAUDE_CONFIG_DIR` overrides the default `~/.claude`. */
export function resolveClaudeDir(env: Env = process.env, home: string = os.homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : path.join(home, '.claude');
}
