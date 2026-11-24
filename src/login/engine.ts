import { FIELD_ATTR, type CodeResult, type DetectResult, type FieldRole, type InpageAction, type InpageArg, type StateResult, type SubmitResult } from '../inpage.js';
import { REDACTED } from '../redact.js';
import type { PreviousLogin } from '../results.js';
import { hostOf, matchesUrl } from '../store/match.js';
import type { UsableProfile } from '../store/profiles.js';
import { freshTotpCode } from '../totp.js';

export interface ElementLike {
  focus(): Promise<void>;
  click(): Promise<void>;
}

/** The slice of a browser page the login engine needs (see browser/adapter.ts). */
export interface PageLike {
  url(): string;
  run<T>(action: InpageAction, arg: InpageArg): Promise<T>;
  element(selector: string): Promise<ElementLike | null>;
  insertText(text: string): Promise<void>;
  press(key: 'Enter'): Promise<void>;
  bringToFront(): Promise<void>;
}

export type LoginStatus =
  | 'success'
  | 'submitted'
  | 'run_in_page'
  | 'failed'
  | 'no_login_form'
  | 'no_matching_tab'
  | 'ambiguous_tab'
  | 'ambiguous_profile'
  | 'no_profile'
  | 'invalid_profile'
  | 'origin_mismatch'
  | 'browser_not_connected'
  | 'rate_limited'
  | 'needs_human'
  | 'error';

export interface LoginResult {
  status: LoginStatus;
  profile?: string;
  url?: string;
  reason?: string;
  hint?: string;
  candidates?: string[];
  /** On `no_login_form`: the profile's recent real login outcome (see ResultLog.noFormContext). */
  previous_login?: PreviousLogin;
  /** Bridge mode: code for the agent to run in the tab (contains a one-time URL, never a credential). */
  script?: string;
  function?: string;
  expression?: string;
  expires_in_s?: number;
}

export interface LoginTiming {
  detectTimeoutMs: number;
  verifyTimeoutMs: number;
  pollMs: number;
  /** A new error message only counts as failure after this long (lets redirects settle). */
  earlyFailAfterMs: number;
}

export const DEFAULT_TIMING: LoginTiming = { detectTimeoutMs: 5_000, verifyTimeoutMs: 10_000, pollMs: 250, earlyFailAfterMs: 1_500 };

/**
 * How long an identifier step with a Next / Continue button must stay before the username is sent alone:
 * half the detect time (2.5 s by default), so a one-page form whose password field renders late is not split.
 */
export const identifierSettleMs = (timing: { detectTimeoutMs: number; pollMs: number }): number =>
  Math.min(timing.detectTimeoutMs, Math.max(4 * timing.pollMs, timing.detectTimeoutMs / 2));

/** Hints for `needs_human`; bridge mode (src/bridge/filler.ts) carries the same words. */
export const NEEDS_HUMAN_HINTS = {
  sso: 'This page signs in through single sign-on (another provider), so a human has to finish this login. autologin-mcp only fills the app\'s own username and password form.',
  passkey: 'This page asks for a passkey or security key, which needs the user\'s device, so a human has to finish this login.',
  captcha: 'This page shows a captcha. A human has to solve it; autologin-mcp does not.',
  mfa_required: 'The page now asks for a one-time code (a second factor) after the password, so a human has to enter it.',
} as const;

/** A one-time code from the profile's TOTP secret did not get through; bridge mode carries the same words. */
export const TOTP_REJECTED_HINT =
  "The page did not accept the one-time code made from the profile's TOTP secret. Check the secret, and that this computer's clock is right.";

export const PASSWORD_STEP_HINT =
  'The page did not ask for a password after the username step. It may use single sign-on, a passkey or a second factor, so a human has to finish this login.';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const selectorFor = (role: FieldRole | 'submit'): string => `[${FIELD_ATTR}="${role}"]`;

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Types into a tagged field; `beforeInsert` runs between focusing it and typing (the site check). */
async function typeInto(page: PageLike, role: FieldRole, value: string, beforeInsert: () => void): Promise<void> {
  await page.run('clear', { role });
  const field = await page.element(selectorFor(role));
  if (field === null) throw new Error(`The ${role} field disappeared before it could be filled.`);
  await field.focus();
  beforeInsert();
  await page.insertText(value);
}

/** Thrown when the tab left the profile's site right before something would be typed. */
class LeftSiteError extends Error {
  constructor(readonly result: LoginResult) {
    super(result.hint);
  }
}

async function submitForm(page: PageLike, hasSubmit: boolean): Promise<void> {
  if (hasSubmit) {
    try {
      await (await page.element(selectorFor('submit')))!.click();
      return;
    } catch {
      // Not clickable (covered, detached, ...): fall back to an in-page submit.
    }
  }
  const outcome = await page.run<SubmitResult>('submit', {});
  if (outcome === 'none') await page.press('Enter');
}

/**
 * Fills and submits the login form of `page` with `profile`, then waits for the outcome.
 * Deterministic: no AI involved. Never returns or logs the password, the TOTP secret or a one-time code.
 */
export async function performLogin(
  page: PageLike,
  profile: UsableProfile,
  timing: LoginTiming = DEFAULT_TIMING,
  clock: Clock = realClock,
): Promise<LoginResult> {
  // The one-time code sent for this login, if any: like the password, it never appears in a result,
  // also not in the URL (a GET form puts it there). Every result of loginSteps carries the URL.
  const sent = { code: null as string | null };
  const result = await loginSteps(page, profile, timing, clock, (code) => (sent.code = code));
  if (sent.code === null) return result;
  const code = sent.code;
  const hide = (text: string): string => text.split(code).join(REDACTED);
  return { ...result, url: hide(result.url!), ...(result.hint === undefined ? {} : { hint: hide(result.hint) }) };
}

async function loginSteps(
  page: PageLike,
  profile: UsableProfile,
  timing: LoginTiming,
  clock: Clock,
  codeSent: (code: string) => void,
): Promise<LoginResult> {
  const base = { profile: profile.name };
  // The tab can leave the profile's site while we wait (a redirect, or the username step sending it to a
  // single sign-on host). Nothing is typed into a page of another site: the site is checked before each
  // step and again right between focusing a field and typing into it.
  const leftSite = (): LoginResult | null => {
    const url = page.url();
    if (matchesUrl(profile.root, url)) return null;
    return {
      status: 'needs_human',
      ...base,
      url,
      reason: 'left_profile_site',
      hint:
        `The login moved to ${hostOf(url)}, which is not part of profile "${profile.name}" (${profile.url}), so nothing was typed there. ` +
        'If it is single sign-on, a human has to finish this login. If that site belongs to the app, give the profile a root URL that covers it (for example *.example.com).',
    };
  };
  const onSite = (): void => {
    const away = leftSite();
    if (away !== null) throw new LeftSiteError(away);
  };
  const detect = () => attempt(() => page.run<DetectResult>('detect', { selectors: profile.selectors }));
  const state = () => attempt(() => page.run<StateResult>('state', { successSelector: profile.selectors.success }));
  const clearFields = async () => {
    await attempt(() => page.run<boolean>('clear', { role: 'password' }));
    if (codeSentYet) await attempt(() => page.run<boolean>('clear', { role: 'code' }));
  };
  const mfaRequired = (): LoginResult => ({ status: 'needs_human', ...base, url: page.url(), reason: 'mfa_required', hint: NEEDS_HUMAN_HINTS.mfa_required });
  let codeSentYet = false;
  /**
   * A second factor the profile has a TOTP secret for: one code per login, made here, typed like the password.
   * The code is made first (it may wait for the next one), then the field is tagged, so the tag is fresh.
   */
  const sendCode = async (totp: NonNullable<UsableProfile['totp']>): Promise<LoginResult | null> => {
    onSite();
    const code = await freshTotpCode(totp, clock);
    onSite();
    const step = await attempt(() => page.run<CodeResult>('code', {}));
    if (!step?.found) return mfaRequired();
    codeSent(code);
    codeSentYet = true;
    await typeInto(page, 'code', code, onSite);
    await submitForm(page, step.hasSubmit);
    return null;
  };

  try {
    const detectStart = clock.now();
    const settleMs = identifierSettleMs(timing);
    let identifierSince: number | null = null;
    let detected = await detect();
    // Wait for a password field. An identifier step (username + Next) counts only once it has stayed for
    // the settle time; with a Log in / Sign in button, only after the whole detect time, since a one-page
    // form may still be rendering its password field. A page that asks only for a one-time code is not a login
    // page here: CDP mode fills a code step only in the run that typed the password, following the tab to it.
    for (;;) {
      if (detected?.found || detected?.error) break;
      const now = clock.now();
      if (detected?.step === 'identifier') {
        identifierSince ??= now;
        if (detected.nextButton && now - identifierSince >= settleMs) break;
      } else {
        identifierSince = null;
      }
      if (now - detectStart >= timing.detectTimeoutMs) break;
      await clock.sleep(timing.pollMs);
      detected = await detect();
    }
    if (!detected?.found) {
      if (detected?.step !== 'identifier' || !detected.hasUsername) {
        if (detected?.blocker) return { status: 'needs_human', ...base, url: page.url(), reason: detected.blocker, hint: NEEDS_HUMAN_HINTS[detected.blocker] };
        return { status: 'no_login_form', ...base, url: page.url(), hint: detected?.error ?? 'No visible password field was found on the page.' };
      }
      // Identifier-first login: send the username, then wait for the page to ask for the password.
      // A message already on the page (say "Your session has expired") is not an answer to the username.
      onSite();
      const beforeStep = await state();
      await page.bringToFront().catch(() => undefined);
      await typeInto(page, 'username', profile.username, onSite);
      await submitForm(page, detected.hasSubmit);
      const stepStart = clock.now();
      let next = await detect();
      while (!next?.found) {
        onSite(); // a message on a single sign-on host is not a rejection of the username
        const current = await state();
        const newError = current?.errorText != null && current.errorText !== beforeStep?.errorText;
        if (newError && clock.now() - stepStart >= timing.earlyFailAfterMs) {
          return { status: 'failed', ...base, url: page.url(), reason: 'identifier_rejected', hint: current.errorText! };
        }
        if (clock.now() - stepStart >= timing.detectTimeoutMs) break;
        await clock.sleep(timing.pollMs);
        next = await detect();
      }
      if (!next?.found) {
        // No password was sent, so this is not a failed login (and does not count toward the rate limit).
        return { status: 'needs_human', ...base, url: page.url(), reason: 'password_step_timeout', hint: PASSWORD_STEP_HINT };
      }
      detected = next;
    }

    onSite();
    const before = await state();
    await page.bringToFront().catch(() => undefined);
    if (detected.hasUsername) await typeInto(page, 'username', profile.username, onSite);
    await typeInto(page, 'password', profile.password, onSite);
    await submitForm(page, detected.hasSubmit);

    // Each step (the password, then a one-time code) gets its own wait and its own "message before".
    let stepStart = clock.now();
    let stepBefore = before;
    let goneStreak = 0;
    let lookedAgain = false;
    let last: StateResult | null = null;
    for (;;) {
      await clock.sleep(timing.pollMs);
      const current = await state();
      if (current?.ready) {
        last = current;
        if (current.success) return { status: 'success', ...base, url: page.url() };
        if (current.codeVisible && !current.passwordVisible) {
          goneStreak = 0;
          if (profile.totp === undefined) return mfaRequired();
          if (!codeSentYet) {
            const stopped = await sendCode(profile.totp);
            if (stopped !== null) return stopped;
            stepStart = clock.now();
            stepBefore = current;
            lookedAgain = false;
            continue;
          }
          const newError = current.errorText !== null && current.errorText !== stepBefore?.errorText;
          if (newError && clock.now() - stepStart >= timing.earlyFailAfterMs) break;
        } else if (!current.passwordVisible) {
          goneStreak += 1;
          if (goneStreak >= 2) return { status: 'success', ...base, url: page.url() };
        } else {
          goneStreak = 0;
          const newError = current.errorText !== null && current.errorText !== stepBefore?.errorText;
          if (newError && clock.now() - stepStart >= timing.earlyFailAfterMs) break;
        }
      }
      if (clock.now() - stepStart >= timing.verifyTimeoutMs) {
        // The password field was gone on the last look: look once more before calling the login failed,
        // so a page that was busy up to the deadline is not reported (and rate-limited) as a failure.
        if (goneStreak === 0 || lookedAgain) break;
        lookedAgain = true;
      }
    }
    await clearFields();
    if (codeSentYet && last?.codeVisible) {
      return { status: 'failed', ...base, url: page.url(), reason: 'totp_rejected', hint: last.errorText ?? TOTP_REJECTED_HINT };
    }
    return {
      status: 'failed',
      ...base,
      url: page.url(),
      reason: 'still_on_login_form',
      hint: last?.errorText ?? 'Still on the login form after submitting. Check the credentials, or set selectors for this profile.',
    };
  } catch (error) {
    if (error instanceof LeftSiteError) return error.result;
    await clearFields();
    return { status: 'error', ...base, url: page.url(), hint: error instanceof Error ? error.message : String(error) };
  }
}
