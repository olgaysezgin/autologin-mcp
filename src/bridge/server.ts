import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FailureLimiter } from '../ratelimit.js';
import type { NoFormContext } from '../results.js';
import { matchesUrl } from '../store/match.js';
import type { UsableProfile } from '../store/profiles.js';
import { agentExpression, agentFunction, agentScript, fillerScript, type BridgeResult, type BridgeTiming } from './filler.js';

export const BRIDGE_TIMING: BridgeTiming = { detectTimeoutMs: 5_000, verifyTimeoutMs: 10_000, pollMs: 250, earlyFailAfterMs: 1_500 };

export interface BridgeTicket {
  profile: string;
  expiresInSeconds: number;
  /** Function form, e.g. for Playwright MCP browser_evaluate / chrome-devtools-mcp evaluate_script. */
  function: string;
  /** Expression form with top-level await, e.g. for Claude in Chrome javascript_tool. */
  script: string;
  /** Promise expression without top-level await, e.g. for Puppeteer page.evaluate. */
  expression: string;
}

export interface BridgeOptions {
  ttlMs?: number;
  timing?: BridgeTiming;
  now?: () => number;
  /** Called once per ticket with the outcome reported by the page (used for rate limiting). */
  onResult?: (profile: string, result: BridgeResult) => void;
  /** Added to a `no_login_form` outcome in the page, e.g. "the previous login went through" (see ResultLog.noFormContext). */
  noFormContext?: (profile: string) => NoFormContext | null;
  /** Credential releases allowed per profile per 5 minutes (a guard against runaway loops; failures are limited separately). */
  maxReleases?: number;
  /** How long a re-run of a used script waits for the first run's result. */
  reuseWaitMs?: number;
}

interface Ticket {
  profile: UsableProfile;
  expiresAt: number;
  released: boolean;
  result: BridgeResult | null;
  waiters: Array<(result: BridgeResult | null) => void>;
}

const TOKEN_PATH = /^\/v1\/(filler|credentials|result)\/([A-Za-z0-9_-]{16,})(?:\.js)?$/;
const MAX_BODY = 8_192;

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  // Keep consuming (so the response can still be sent) but only remember the first MAX_BODY characters.
  for await (const chunk of req) if (body.length <= MAX_BODY) body += String(chunk);
  return body.slice(0, MAX_BODY);
}

/**
 * Local one-time-token server for bridge mode. Binds to 127.0.0.1 only and hands a profile's
 * credentials to a page only once, only within the TTL, and only when the browser-set Origin
 * header belongs to the profile's root URL.
 */
export class BridgeServer {
  private listening: Promise<{ server: http.Server; base: string }> | null = null;
  private readonly tickets = new Map<string, Ticket>();
  private readonly releases: FailureLimiter;
  private readonly ttlMs: number;
  private readonly timing: BridgeTiming;
  private readonly now: () => number;
  private readonly reuseWaitMs: number;

  constructor(private readonly options: BridgeOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.timing = options.timing ?? BRIDGE_TIMING;
    this.now = options.now ?? Date.now;
    this.reuseWaitMs = options.reuseWaitMs ?? 15_000;
    this.releases = new FailureLimiter(options.maxReleases ?? 20, 5 * 60_000, this.now);
  }

  /** The first run's result, waiting for it (up to reuseWaitMs) when it is still in progress. */
  private firstRunResult(ticket: Ticket): Promise<BridgeResult | null> {
    if (ticket.result !== null) return Promise.resolve(ticket.result);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.reuseWaitMs);
      ticket.waiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  private listen(): Promise<{ server: http.Server; base: string }> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    });
    return this.listening;
  }

  async issue(profile: UsableProfile): Promise<BridgeTicket> {
    const { base } = await this.listen();
    const now = this.now();
    for (const [token, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(token);
    const token = randomBytes(24).toString('base64url');
    this.tickets.set(token, { profile, expiresAt: now + this.ttlMs, released: false, result: null, waiters: [] });
    const fn = agentFunction(base, token);
    return { profile: profile.name, expiresInSeconds: Math.round(this.ttlMs / 1000), function: fn, script: agentScript(fn), expression: agentExpression(fn) };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { base } = await this.listen();
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    const send = (status: number, body: unknown, type = 'application/json'): void => {
      res.writeHead(status, { ...cors, 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
      });
      res.end();
      return;
    }

    const match = TOKEN_PATH.exec(new URL(req.url!, base).pathname);
    if (match === null) return send(404, { status: 'error', hint: 'Unknown autologin-mcp bridge URL.' });
    const [, kind, token] = match as unknown as [string, 'filler' | 'credentials' | 'result', string];
    const ticket = this.tickets.get(token);
    if (ticket === undefined || ticket.expiresAt <= this.now()) {
      return send(410, { status: 'expired', hint: 'This login script expired; call login again.' });
    }
    const { profile } = ticket;
    const allowed = origin !== undefined && matchesUrl(profile.root, `${origin}/`);
    const mismatch = {
      status: 'origin_mismatch',
      hint: `This page (${origin ?? 'unknown origin'}) is not part of profile "${profile.name}" (${profile.url}); nothing was filled.`,
    };

    if (kind === 'filler') {
      const script = allowed
        ? fillerScript(base, token, this.timing, this.options.noFormContext?.(profile.name) ?? null)
        : `window.dispatchEvent(new CustomEvent(${JSON.stringify(`autologin-mcp:${token}`)}, { detail: ${JSON.stringify(mismatch)} }));`;
      return send(200, script, 'text/javascript');
    }

    if (req.method !== 'POST') return send(405, { status: 'error', hint: 'Use POST.' });

    if (kind === 'credentials') {
      if (!allowed) return send(403, mismatch);
      if (ticket.released) {
        // A browser tool may re-run the script (e.g. after losing the tab mid-call): answer with the first run's outcome.
        const first = await this.firstRunResult(ticket);
        return first === null
          ? send(410, { status: 'expired', hint: 'This login script was already used and its outcome is unknown; call login_status, or login again.' })
          : send(409, { status: 'already_used', result: first });
      }
      if (this.releases.isBlocked(profile.name)) {
        return send(429, { status: 'rate_limited', hint: 'Too many logins for this profile in the last 5 minutes.' });
      }
      ticket.released = true;
      this.releases.recordFailure(profile.name);
      return send(200, {
        username: profile.username,
        password: profile.password,
        selectors: { username: profile.selectors.username, password: profile.selectors.password, submit: profile.selectors.submit },
        successSelector: profile.selectors.success,
      });
    }

    let result: unknown = null;
    try {
      result = JSON.parse(await readBody(req));
    } catch {
      // ignore malformed reports
    }
    if (ticket.result === null && typeof (result as BridgeResult | null)?.status === 'string') {
      ticket.result = result as BridgeResult;
      for (const wake of ticket.waiters.splice(0)) wake(ticket.result);
      this.options.onResult?.(profile.name, ticket.result);
    }
    res.writeHead(204, cors);
    res.end();
  }

  async close(): Promise<void> {
    for (const ticket of this.tickets.values()) for (const wake of ticket.waiters.splice(0)) wake(null);
    this.tickets.clear();
    const listening = this.listening;
    this.listening = null;
    if (listening === null) return;
    const { server } = await listening;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
