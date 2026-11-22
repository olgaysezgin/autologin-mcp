import { parseRootUrl, type RootUrl } from './match.js';

export const PROFILE_SUFFIXES = [
  'URL',
  'USERNAME',
  'PASSWORD',
  'AUTO_LOGIN',
  'USERNAME_SELECTOR',
  'PASSWORD_SELECTOR',
  'SUBMIT_SELECTOR',
  'SUCCESS_SELECTOR',
] as const;
export type ProfileSuffix = (typeof PROFILE_SUFFIXES)[number];

const KEY_RE = new RegExp(`^([A-Z0-9][A-Z0-9_]*?)_(${PROFILE_SUFFIXES.join('|')})$`);
export const SETTINGS_PREFIX = 'AUTOLOGIN_';
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_]*$/i;

export interface Selectors {
  username?: string;
  password?: string;
  submit?: string;
  success?: string;
}

export interface Profile {
  /** Lower-case name shown to the agent, e.g. `staging`. */
  name: string;
  /** Upper-case key prefix used in the file, e.g. `STAGING`. */
  key: string;
  /** Normalized root URL, e.g. `staging.example.com` or `localhost:3000`. */
  url: string;
  root: RootUrl | null;
  username?: string;
  password?: string;
  autoLogin: boolean | null;
  selectors: Selectors;
  problems: string[];
}

export interface UsableProfile extends Profile {
  root: RootUrl;
  username: string;
  password: string;
}

export type LoginMode = 'auto' | 'bridge' | 'cdp';
export const LOGIN_MODES: readonly LoginMode[] = ['auto', 'bridge', 'cdp'];

export interface Settings {
  cdpUrl?: string;
  /** auto (default): CDP when Chrome remote debugging is available, otherwise the in-page bridge. */
  mode?: LoginMode;
}

export interface Store {
  profiles: Profile[];
  settings: Settings;
  warnings: string[];
}

export function splitKey(key: string): { prefix: string; suffix: ProfileSuffix } | null {
  const match = KEY_RE.exec(key.toUpperCase());
  return match ? { prefix: match[1]!, suffix: match[2] as ProfileSuffix } : null;
}

export function parseBoolean(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  return null;
}

export function isUsable(profile: Profile): profile is UsableProfile {
  return profile.problems.length === 0;
}

const clean = (value: string | undefined): string | undefined => (value?.trim() ? value.trim() : undefined);

function toProfile(key: string, fields: Partial<Record<ProfileSuffix, string>>): Profile {
  const problems: string[] = [];
  let url = fields.URL?.trim() ?? '';
  let root: RootUrl | null = null;
  if (url === '') {
    problems.push(`${key}_URL is missing`);
  } else {
    const parsed = parseRootUrl(url);
    if (parsed.ok) {
      root = parsed.root;
      url = parsed.normalized;
    } else {
      problems.push(`${key}_URL: ${parsed.error}`);
    }
  }
  if (!fields.USERNAME) problems.push(`${key}_USERNAME is missing`);
  if (!fields.PASSWORD) problems.push(`${key}_PASSWORD is missing`);
  let autoLogin: boolean | null = null;
  if (fields.AUTO_LOGIN !== undefined) {
    autoLogin = parseBoolean(fields.AUTO_LOGIN);
    if (autoLogin === null) problems.push(`${key}_AUTO_LOGIN must be true or false`);
  }
  return {
    name: key.toLowerCase(),
    key,
    url,
    root,
    username: fields.USERNAME || undefined,
    password: fields.PASSWORD || undefined,
    autoLogin,
    selectors: {
      username: clean(fields.USERNAME_SELECTOR),
      password: clean(fields.PASSWORD_SELECTOR),
      submit: clean(fields.SUBMIT_SELECTOR),
      success: clean(fields.SUCCESS_SELECTOR),
    },
    problems,
  };
}

/** Turns parsed `KEY=value` pairs into profiles (grouped by key prefix) and settings. */
export function buildStore(vars: Record<string, string>): Store {
  const groups = new Map<string, Partial<Record<ProfileSuffix, string>>>();
  const settings: Settings = {};
  const warnings: string[] = [];
  for (const [rawKey, value] of Object.entries(vars)) {
    const key = rawKey.toUpperCase();
    if (key.startsWith(SETTINGS_PREFIX)) {
      if (key === 'AUTOLOGIN_CDP_URL') settings.cdpUrl = clean(value);
      else if (key === 'AUTOLOGIN_MODE') {
        const mode = value.trim().toLowerCase() as LoginMode;
        if (LOGIN_MODES.includes(mode)) settings.mode = mode;
        else warnings.push(`AUTOLOGIN_MODE must be one of ${LOGIN_MODES.join(', ')}; using auto`);
      } else warnings.push(`Unknown setting ${rawKey}`);
      continue;
    }
    const parts = splitKey(key);
    if (!parts) {
      warnings.push(`Ignoring ${rawKey}: expected <PROFILE>_<FIELD> with FIELD one of ${PROFILE_SUFFIXES.join(', ')}`);
      continue;
    }
    const fields = groups.get(parts.prefix) ?? {};
    fields[parts.suffix] = value;
    groups.set(parts.prefix, fields);
  }
  const profiles = [...groups].map(([key, fields]) => toProfile(key, fields));
  return { profiles, settings, warnings };
}
