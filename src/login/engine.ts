import { FIELD_ATTR, type DetectResult, type FieldRole, type InpageAction, type InpageArg, type StateResult, type SubmitResult } from '../inpage.js';
import type { PreviousLogin } from '../results.js';
import type { UsableProfile } from '../store/profiles.js';

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

async function typeInto(page: PageLike, role: FieldRole, value: string): Promise<void> {
  await page.run('clear', { role });
  const field = await page.element(selectorFor(role));
  if (field === null) throw new Error(`The ${role} field disappeared before it could be filled.`);
  await field.focus();
  await page.insertText(value);
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
 * Deterministic: no AI involved. Never returns or logs the password.
 */
export async function performLogin(
  page: PageLike,
  profile: UsableProfile,
  timing: LoginTiming = DEFAULT_TIMING,
  clock: Clock = realClock,
): Promise<LoginResult> {
  const base = { profile: profile.name };
  const detect = () => attempt(() => page.run<DetectResult>('detect', { selectors: profile.selectors }));
  const state = () => attempt(() => page.run<StateResult>('state', { successSelector: profile.selectors.success }));
  const clearPassword = () => attempt(() => page.run<boolean>('clear', { role: 'password' }));

  try {
    const detectStart = clock.now();
    let detected = await detect();
    while (!detected?.found && detected?.step !== 'identifier' && !detected?.error && clock.now() - detectStart < timing.detectTimeoutMs) {
      await clock.sleep(timing.pollMs);
      detected = await detect();
    }
    if (!detected?.found) {
      if (detected?.step !== 'identifier' || !detected.hasUsername) {
        return { status: 'no_login_form', ...base, url: page.url(), hint: detected?.error ?? 'No visible password field was found on the page.' };
      }
      // Identifier-first login: send the username, then wait for the page to ask for the password.
      await page.bringToFront().catch(() => undefined);
      await typeInto(page, 'username', profile.username);
      await submitForm(page, detected.hasSubmit);
      const stepStart = clock.now();
      let next = await detect();
      while (!next?.found) {
        const current = await state();
        if (current?.errorText) {
          return { status: 'failed', ...base, url: page.url(), reason: 'identifier_rejected', hint: current.errorText };
        }
        if (clock.now() - stepStart >= timing.detectTimeoutMs) break;
        await clock.sleep(timing.pollMs);
        next = await detect();
      }
      if (!next?.found) {
        return {
          status: 'failed',
          ...base,
          url: page.url(),
          reason: 'password_step_timeout',
          hint: 'The page did not ask for a password after the username step. It may use single sign-on or a second factor, so a human has to finish this login.',
        };
      }
      detected = next;
    }

    const before = await state();
    await page.bringToFront().catch(() => undefined);
    if (detected.hasUsername) await typeInto(page, 'username', profile.username);
    await typeInto(page, 'password', profile.password);
    await submitForm(page, detected.hasSubmit);

    const submittedAt = clock.now();
    let goneStreak = 0;
    let last: StateResult | null = null;
    for (;;) {
      await clock.sleep(timing.pollMs);
      const current = await state();
      if (current?.ready) {
        last = current;
        if (current.success) return { status: 'success', ...base, url: page.url() };
        if (!current.passwordVisible) {
          goneStreak += 1;
          if (goneStreak >= 2) return { status: 'success', ...base, url: page.url() };
        } else {
          goneStreak = 0;
          const newError = current.errorText !== null && current.errorText !== before?.errorText;
          if (newError && clock.now() - submittedAt >= timing.earlyFailAfterMs) break;
        }
      }
      if (clock.now() - submittedAt >= timing.verifyTimeoutMs) break;
    }
    await clearPassword();
    return {
      status: 'failed',
      ...base,
      url: page.url(),
      reason: 'still_on_login_form',
      hint: last?.errorText ?? 'Still on the login form after submitting. Check the credentials, or set selectors for this profile.',
    };
  } catch (error) {
    await clearPassword();
    return { status: 'error', ...base, url: page.url(), hint: error instanceof Error ? error.message : String(error) };
  }
}
