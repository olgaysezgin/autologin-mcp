import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { ENV_TEMPLATE } from '../templates.js';
import { buildStore, splitKey, type Store } from './profiles.js';

export interface LoadedStore extends Store {
  file: string;
  exists: boolean;
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Parses the credentials file. Values are returned in memory only; they are never
 * copied into `process.env`, so child processes and `ps e` cannot see them.
 */
export async function loadStore(file: string): Promise<LoadedStore> {
  const text = await readText(file);
  const store = buildStore(text === null ? {} : parse(text));
  return { ...store, file, exists: text !== null };
}

/** Quotes a value so dotenv reads it back verbatim. */
export function quoteValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Values must fit on a single line.');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/.test(value)) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new Error('The value contains \', " and ` characters; edit the credentials file by hand.');
}

export const profileMarker = (name: string): string => `# --- ${name.toLowerCase()} ---`;

export function renderProfile(profile: { name: string; url: string; username: string; password: string; totpSecret?: string }): string {
  const key = profile.name.toUpperCase();
  return [
    profileMarker(profile.name),
    `${key}_URL=${profile.url}`,
    `${key}_USERNAME=${quoteValue(profile.username)}`,
    `${key}_PASSWORD=${quoteValue(profile.password)}`,
    ...(profile.totpSecret === undefined ? [] : [`${key}_TOTP_SECRET=${quoteValue(profile.totpSecret)}`]),
    '',
  ].join('\n');
}

export function appendBlock(text: string, block: string): string {
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  const separator = base === '' || base.endsWith('\n\n') ? '' : '\n';
  return `${base}${separator}${block}`;
}

const LINE_KEY_RE = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=/;

/** Removes every `<NAME>_<FIELD>=` line (and the marker comment) of one profile. */
export function removeProfile(text: string, name: string): { text: string; removed: number } {
  const key = name.toUpperCase();
  const marker = profileMarker(name);
  let removed = 0;
  const kept = text.split('\n').filter((line) => {
    if (line.trim() === marker) return false;
    const match = LINE_KEY_RE.exec(line);
    if (match && splitKey(match[1]!)?.prefix === key) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}

/** Atomically writes a file readable only by its owner (dir 700, file 600). */
export async function writeSecureFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

/** Creates the credentials file from the template when it does not exist yet. */
export async function ensureEnvFile(file: string): Promise<boolean> {
  if ((await readText(file)) !== null) return false;
  await writeSecureFile(file, ENV_TEMPLATE);
  return true;
}

export async function permissionWarning(file: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32') return null;
  try {
    const stat = await fs.stat(file);
    return (stat.mode & 0o077) === 0 ? null : `${file} is readable by other users; run: chmod 600 "${file}"`;
  } catch {
    return null;
  }
}
