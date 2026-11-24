import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FailureLimiter } from '../ratelimit.js';
import type { CodeStep, NoFormContext } from '../results.js';
import { matchesUrl } from '../store/match.js';
import type { UsableProfile } from '../store/profiles.js';
import { freshTotpCode } from '../totp.js';
import { agentExpression, agentFunction, agentScript, fillerScript, REUSED_NOTE, type BridgeResult, type BridgeTiming } from './filler.js';

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
  /** Whether a page that asks only for a one-time code is a step of a login in progress (ResultLog.codeStep). */
  codeStepContext?: (profile: string) => CodeStep;
  /** Called when a page that asks only for the code got one: that password step is used up (serve.ts records it). */
  onCodeOnly?: (profile: string) => void;
  /** One-time codes per profile per 5 minutes until a login goes through (a guard against a wrong secret in a loop). */
  maxCodes?: number;
  /** Waits before handing out a one-time code that is about to expire (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
}

interface Ticket {
  profile: UsableProfile;
  expiresAt: number;
  /** The filler was served: the script ran (or started to). A second run only gets the first run's outcome. */
  started: boolean;
  released: boolean;
  /** The one-time code for this login was handed out (a TOTP profile gets one code per login). */
  codeReleased: boolean;
  /**
   * A TOTP profile: a key that comes only with the run's filler script, never in a tool result. The code endpoint
   * answers only to it, so holding the token (as the agent does) is not enough to ask for a code.
   */
  codeNonce: string | null;
  /** Set when the filler is served: what a code page of its own means for this run. */
  codeStep: CodeStep;
  result: BridgeResult | null;
  waiters: Array<(result: BridgeResult | null) => void>;
}

const sameSecret = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

const REUSED_UNKNOWN = { status: 'expired', hint: 'This login script was already used and its outcome is unknown; call login_status, or login again.' };

const TOKEN_PATH = /^\/v1\/(filler|credentials|code|result)\/([A-Za-z0-9_-]{16,})(?:\.js)?$/;
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
  private readonly codes: FailureLimiter;
  private readonly ttlMs: number;
  private readonly timing: BridgeTiming;
  private readonly now: () => number;
  private readonly reuseWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BridgeOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.timing = options.timing ?? BRIDGE_TIMING;
    this.now = options.now ?? Date.now;
    this.reuseWaitMs = options.reuseWaitMs ?? 25_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.releases = new FailureLimiter(options.maxReleases ?? 20, 5 * 60_000, this.now);
    this.codes = new FailureLimiter(options.maxCodes ?? 3, 5 * 60_000, this.now);
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
    const codeNonce = profile.totp === undefined ? null : randomBytes(24).toString('base64url');
    this.tickets.set(token, { profile, expiresAt: now + this.ttlMs, started: false, released: false, codeReleased: false, codeNonce, codeStep: null, result: null, waiters: [] });
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
    const [, kind, token] = match as unknown as [string, 'filler' | 'credentials' | 'code' | 'result', string];
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
      const answer = (detail: unknown): string => `window.dispatchEvent(new CustomEvent(${JSON.stringify(`autologin-mcp:${token}`)}, { detail: ${JSON.stringify(detail)} }));`;
      if (!allowed) return send(200, answer(mismatch), 'text/javascript');
      // One run per script, also when the first run found no form and never asked for the credentials:
      // a re-run (a browser tool retrying after losing the tab) only gets the first run's outcome.
      if (ticket.started) {
        const first = await this.firstRunResult(ticket);
        return send(200, answer(first === null ? REUSED_UNKNOWN : { ...first, note: REUSED_NOTE }), 'text/javascript');
      }
      ticket.started = true;
      // The run gets its own time window: a long login (a code step after the password) may outlast the
      // window that was left for running the script.
      ticket.expiresAt = Math.max(ticket.expiresAt, this.now() + this.ttlMs);
      ticket.codeStep = this.options.codeStepContext?.(profile.name) ?? null;
      const script = fillerScript(
        base,
        token,
        this.timing,
        this.options.noFormContext?.(profile.name) ?? null,
        {
          selectors: { username: profile.selectors.username, password: profile.selectors.password, submit: profile.selectors.submit },
          successSelector: profile.selectors.success,
          totp: profile.totp !== undefined,
          codeStep: ticket.codeStep,
        },
        ticket.codeNonce,
      );
      return send(200, script, 'text/javascript');
    }

    if (req.method !== 'POST') return send(405, { status: 'error', hint: 'Use POST.' });

    if (kind === 'code') {
      // The current one-time code, never the TOTP secret: once per login, to the run's own filler script on the
      // profile's site, while the run is still going.
      if (!allowed) return send(403, mismatch);
      if (profile.totp === undefined || ticket.codeNonce === null) return send(404, { status: 'no_totp', hint: `Profile "${profile.name}" has no TOTP secret.` });
      type CodeRequest = { nonce?: unknown; codeOnly?: unknown } | null;
      let body: CodeRequest = null;
      try {
        body = JSON.parse(await readBody(req)) as CodeRequest;
      } catch {
        // no or malformed body: refused below
      }
      const nonce = body?.nonce;
      if (typeof nonce !== 'string' || !sameSecret(nonce, ticket.codeNonce)) {
        return send(403, { status: 'refused', hint: 'Only the login script of this ticket can ask for its one-time code.' });
      }
      if (ticket.result !== null) return send(410, { status: 'finished', hint: 'This login already reported its outcome; call login again.' });
      // A page that asks only for the code gets one only right after this profile's password step, judged now: an
      // earlier script may have used that step up meanwhile (#1 review).
      const codeOnly = body?.codeOnly === true;
      if (codeOnly && (this.options.codeStepContext?.(profile.name) ?? null) !== 'after_password') {
        return send(409, { status: 'refused', hint: 'There is no login of this profile in progress that waits for a code on a page of its own.' });
      }
      if (ticket.codeReleased) return send(409, { status: 'already_used', hint: 'This login already got its one-time code.' });
      if (this.codes.isBlocked(profile.name)) {
        return send(429, {
          status: 'rate_limited',
          hint: 'Three one-time codes went out for this profile in the last 5 minutes without a login that went through. Check the profile\'s TOTP secret and this computer\'s clock before trying again.',
        });
      }
      ticket.codeReleased = true;
      this.codes.recordFailure(profile.name);
      if (codeOnly) this.options.onCodeOnly?.(profile.name);
      return send(200, { code: await freshTotpCode(profile.totp, { now: this.now, sleep: this.sleep }) });
    }

    if (kind === 'credentials') {
      if (!allowed) return send(403, mismatch);
      if (ticket.released) {
        // A browser tool may re-run the script (e.g. after losing the tab mid-call): answer with the first run's outcome.
        const first = await this.firstRunResult(ticket);
        return first === null ? send(410, REUSED_UNKNOWN) : send(409, { status: 'already_used', result: first });
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
      if (ticket.result.status === 'success') this.codes.reset(profile.name);
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
