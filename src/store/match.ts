/** A profile's root URL: only host (+ optional port) matter; scheme and path are ignored. */
export interface RootUrl {
  host: string;
  /** `null` means "default ports only" (80 / 443). */
  port: number | null;
  /** `*.example.com` also matches every subdomain. */
  wildcard: boolean;
}

export type RootUrlResult =
  | { ok: true; root: RootUrl; normalized: string; strippedPath: boolean }
  | { ok: false; error: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOST_RE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;

export function parseRootUrl(input: string): RootUrlResult {
  let rest = input.trim().toLowerCase();
  if (rest === '') return { ok: false, error: 'URL is empty' };
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const wildcard = rest.startsWith('*.');
  if (wildcard) rest = rest.slice(2);
  let strippedPath = false;
  const cut = rest.search(/[/?#]/);
  if (cut !== -1) {
    strippedPath = rest.slice(cut) !== '/';
    rest = rest.slice(0, cut);
  }
  let url: URL;
  try {
    url = new URL(`http://${rest}`);
  } catch {
    return { ok: false, error: `Invalid URL "${input}"` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'URL must not contain a username or password' };
  }
  if (!HOST_RE.test(url.hostname)) return { ok: false, error: `Invalid host in "${input}"` };
  const port = url.port === '' ? null : Number(url.port);
  const normalized = `${wildcard ? '*.' : ''}${url.hostname}${port === null ? '' : `:${port}`}`;
  return { ok: true, root: { host: url.hostname, port, wildcard }, normalized, strippedPath };
}

function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Does a browser tab URL belong to the app identified by `root`? */
export function matchesUrl(root: RootUrl, pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (root.port === null ? url.port !== '' : effectivePort(url) !== root.port) return false;
  const host = url.hostname;
  if (LOOPBACK.has(root.host)) return LOOPBACK.has(host);
  return host === root.host || host === `www.${root.host}` || (root.wildcard && host.endsWith(`.${root.host}`));
}

/** Host of a URL for messages; falls back to the raw string. */
export function hostOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).host;
  } catch {
    return pageUrl;
  }
}
