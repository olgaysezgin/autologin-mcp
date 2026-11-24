import type { CodeStep, NoFormContext } from '../results.js';
import { autologinInpage, type CodeResult, type DetectResult, type InpageSelectors, type StateResult, type SubmitResult } from '../inpage.js';

export interface BridgeCredentials {
  username: string;
  password: string;
  selectors: InpageSelectors;
  successSelector?: string;
  /** A TOTP profile: the current one-time code, asked for only when the page shows the code step (#1). */
  code?: (codeOnly: boolean) => Promise<string>;
  /** Whether a page that asks only for a one-time code is a step of a login in progress (ResultLog.codeStep). */
  codeStep?: CodeStep;
}

/**
 * What the page knows before any credential is released: the profile's selectors, and how to ask for the
 * credentials. bridgeLogin asks only when it is about to type into a form it found, so a page without one
 * (or one a person has to finish: SSO, passkey, captcha) never receives them.
 */
export interface LazyBridgeCredentials {
  selectors: InpageSelectors;
  successSelector?: string;
  load(): Promise<{ username: string; password: string }>;
  code?: (codeOnly: boolean) => Promise<string>;
  codeStep?: CodeStep;
}

export interface BridgeTiming {
  detectTimeoutMs: number;
  verifyTimeoutMs: number;
  pollMs: number;
  earlyFailAfterMs: number;
}

export type BridgeStatus = 'success' | 'submitted' | 'failed' | 'no_login_form' | 'needs_human' | 'error';

export interface BridgeResult {
  status: BridgeStatus;
  url: string;
  reason?: string;
  hint?: string;
}

/**
 * sessionStorage key the password step's run sets when the page navigates (#1 review): a page that asks only for a
 * one-time code is filled only when it is the document loaded right after that navigation, in the same tab.
 */
export const PASSWORD_STEP_KEY = 'autologin-mcp:password-step';

/*
 * Bridge-mode login engine. Serialized and executed inside the page, so it must stay
 * self-contained: it only uses its arguments (`inpage` is autologinInpage) and browser globals.
 * The password never leaves the page: results are scrubbed before they are returned.
 */
export async function bridgeLogin(
  inpage: typeof autologinInpage,
  creds: BridgeCredentials | LazyBridgeCredentials,
  timing: BridgeTiming,
): Promise<BridgeResult> {
  const ATTR = 'data-autologin-mcp';
  let secret: { username: string; password: string } | null = 'password' in creds ? { username: creds.username, password: creds.password } : null;
  const credentials = async (): Promise<{ username: string; password: string }> => (secret ??= await (creds as LazyBridgeCredentials).load());
  // The one-time code sent for this login, if any: like the password, it never appears in a result.
  let sentCode: string | null = null;
  const scrub = (text: string): string =>
    [secret?.password, sentCode].reduce<string>((acc, needle) => (needle ? acc.split(needle).join('[REDACTED]') : acc), text);
  // Same words as NEEDS_HUMAN_HINTS in src/login/engine.ts (this function runs in the page and cannot import).
  const NEEDS_HUMAN_HINTS = {
    sso: "This page signs in through single sign-on (another provider), so a human has to finish this login. autologin-mcp only fills the app's own username and password form.",
    passkey: "This page asks for a passkey or security key, which needs the user's device, so a human has to finish this login.",
    captcha: 'This page shows a captcha. A human has to solve it; autologin-mcp does not.',
    mfa_required: 'The page now asks for a one-time code (a second factor) after the password, so a human has to enter it.',
  };
  // Same words as TOTP_REJECTED_HINT and CODE_AGAIN_HINT in src/login/engine.ts.
  const TOTP_REJECTED_HINT =
    "The page did not accept the one-time code made from the profile's TOTP secret. Check the secret, and that this computer's clock is right.";
  const CODE_AGAIN_HINT =
    "The page asks for the one-time code again after the last code was submitted, so that code was not accepted. Check the profile's TOTP secret, and that this computer's clock is right. No new code was sent.";
  const codeStep = creds.codeStep ?? null;
  // The URL is scrubbed too: a GET form puts the one-time code there.
  const finish = (status: BridgeStatus, extra: { reason?: string; hint?: string } = {}): BridgeResult => ({ status, url: scrub(location.href), ...extra });
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const mfaRequired = (): BridgeResult => finish('needs_human', { reason: 'mfa_required', hint: NEEDS_HUMAN_HINTS.mfa_required });
  const fill = (role: string, value: string): void => {
    const field = document.querySelector<HTMLInputElement>(`[${ATTR}="${role}"]`)!;
    field.focus();
    // The native setter plus input/change events is what React, Vue and Angular listen to.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pressEnter = (role: string): void => {
    const field = document.querySelector(`[${ATTR}="${role}"]`)!;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  };
  const clearFields = (): void => {
    inpage('clear', { role: 'password' });
    if (sentCode !== null) inpage('clear', { role: 'code' });
  };
  /**
   * A second factor the profile has a TOTP secret for: one code per login, asked for only now (the page shows the
   * code step), typed like the password. The page may re-render while the code is on its way, so the field is
   * tagged once the code is here.
   */
  const sendCode = async (loadCode: (codeOnly: boolean) => Promise<string>, codeOnly: boolean): Promise<BridgeResult | null> => {
    const code = await loadCode(codeOnly);
    if (!(inpage('code', {}) as CodeResult).found) return mfaRequired();
    sentCode = code;
    fill('code', code);
    if ((inpage('submit', {}) as SubmitResult) === 'none') pressEnter('code');
    return null;
  };
  let leaving = false;
  let passwordSent = false;
  let wake = (): void => undefined;
  const STEP_KEY = 'autologin-mcp:password-step'; // PASSWORD_STEP_KEY
  const onLeave = (): void => {
    leaving = true;
    if (passwordSent && sentCode === null) {
      try {
        sessionStorage.setItem(STEP_KEY, String(Date.now()));
      } catch {
        // storage blocked: the code page is then left to a person
      }
    }
    wake();
  };
  const CODE_PAGE_ALONE =
    'This page asks for a one-time code, but it is not the page the last password step of this profile led to, so autologin-mcp leaves it alone.';

  try {
    const startedAt = Date.now();
    // Same rules as the CDP engine (identifierSettleMs): an identifier step with a Next button counts once it
    // has stayed for the settle time; with a Log in / Sign in button, only after the whole detect time.
    const NAVIGATED_HINT =
      'Only the username was sent: the page navigated after the username step. Call login again on the next page; if it asks for single sign-on, a passkey or a code, a human has to finish.';
    const settleMs = Math.min(timing.detectTimeoutMs, Math.max(4 * timing.pollMs, timing.detectTimeoutMs / 2));
    let identifierSince: number | null = null;
    let detected = inpage('detect', { selectors: creds.selectors }) as DetectResult;
    for (;;) {
      // A code page during a login (the app navigated after the password) needs no waiting; outside a login it is
      // not a login page at all, as before TOTP support.
      if (detected.found || detected.error || (detected.step === 'code' && codeStep !== null)) break;
      const now = Date.now();
      if (detected.step === 'identifier') {
        identifierSince ??= now;
        if (detected.nextButton && now - identifierSince >= settleMs) break;
      } else {
        identifierSince = null;
      }
      if (now - startedAt >= timing.detectTimeoutMs) break;
      await sleep(timing.pollMs);
      detected = inpage('detect', { selectors: creds.selectors }) as DetectResult;
    }
    const codePage = detected.step === 'code' && codeStep !== null;
    if (codePage && codeStep === 'after_code') {
      // A code went in and the page navigated: with an error message it asks again, which means the code was
      // rejected. Without one it may be a next step (an email check, a settings page): left alone.
      const current = inpage('state', { successSelector: creds.successSelector }) as StateResult;
      return current.errorText !== null ? finish('failed', { reason: 'totp_rejected', hint: CODE_AGAIN_HINT }) : finish('no_login_form', { hint: CODE_PAGE_ALONE });
    }
    if (codePage) {
      // The document has to be the one loaded right after this tab's password step navigated (its run left a mark),
      // so a code field the agent finds on a page it opened later (turning two-factor off) never gets a code.
      let marked = Number.NaN;
      try {
        marked = Number(sessionStorage.getItem(STEP_KEY));
        sessionStorage.removeItem(STEP_KEY);
      } catch {
        // storage blocked: not marked
      }
      const followed = marked > 0 && Date.now() - marked < 120_000 && Math.abs(performance.timeOrigin - marked) < 15_000;
      if (!followed) return finish('no_login_form', { hint: CODE_PAGE_ALONE });
      if (creds.code === undefined) return mfaRequired();
    }
    if (!detected.found && !codePage) {
      if (detected.step !== 'identifier' || !detected.hasUsername) {
        if (detected.blocker) return finish('needs_human', { reason: detected.blocker, hint: NEEDS_HUMAN_HINTS[detected.blocker] });
        return finish('no_login_form', { hint: detected.error ?? 'No visible password field was found on the page.' });
      }
      // Identifier-first login: send the username, then wait for the password step.
      // A message already on the page (say "Your session has expired") is not an answer to the username.
      const beforeStep = inpage('state', { successSelector: creds.successSelector }) as StateResult;
      const { username } = await credentials();
      // The page may have re-rendered while the credentials were on their way: tag the step again.
      inpage('detect', { selectors: creds.selectors });
      const stepField = document.querySelector<HTMLInputElement>(`[${ATTR}="username"]`);
      if (stepField === null) return finish('no_login_form', { hint: 'The username step went away while the credentials were on their way; nothing was typed.' });
      window.addEventListener('beforeunload', onLeave, { once: true });
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(stepField, username);
      stepField.dispatchEvent(new Event('input', { bubbles: true }));
      stepField.dispatchEvent(new Event('change', { bubbles: true }));
      if ((inpage('submit', {}) as SubmitResult) === 'none') {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          stepField.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
      }
      const stepStart = Date.now();
      let next = inpage('detect', { selectors: creds.selectors }) as DetectResult;
      while (!next.found) {
        if (leaving) return finish('submitted', { reason: 'username_step_navigated', hint: NAVIGATED_HINT });
        const current = inpage('state', { successSelector: creds.successSelector }) as StateResult;
        const newError = current.errorText !== null && current.errorText !== beforeStep.errorText;
        if (newError && Date.now() - stepStart >= timing.earlyFailAfterMs) return finish('failed', { reason: 'identifier_rejected', hint: scrub(current.errorText!) });
        if (Date.now() - stepStart >= timing.detectTimeoutMs) {
          // No password was sent, so this is not a failed login (and does not count toward the rate limit).
          return finish('needs_human', {
            reason: 'password_step_timeout',
            hint: 'The page did not ask for a password after the username step. It may use single sign-on, a passkey or a second factor, so a human has to finish this login.',
          });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timing.pollMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (leaving) return finish('submitted', { reason: 'username_step_navigated', hint: NAVIGATED_HINT });
        next = inpage('detect', { selectors: creds.selectors }) as DetectResult;
      }
      detected = next;
    }

    const before = inpage('state', { successSelector: creds.successSelector }) as StateResult;
    if (codePage) {
      // Only the code is asked for here: the password went in on the page before, so the credentials are not.
      window.addEventListener('beforeunload', onLeave, { once: true });
      const stopped = await sendCode(creds.code!, true);
      if (stopped !== null) return stopped;
    } else {
      const { username, password } = await credentials();
      // The page may have re-rendered while the credentials were on their way: tag the form again.
      const again = inpage('detect', { selectors: creds.selectors }) as DetectResult;
      if (!again.found) return finish('no_login_form', { hint: 'The login form went away while the credentials were on their way; nothing was typed.' });
      detected = again;
      if (detected.hasUsername) fill('username', username);
      fill('password', password);

      window.addEventListener('beforeunload', onLeave, { once: true });
      passwordSent = true;
      if ((inpage('submit', {}) as SubmitResult) === 'none') pressEnter('password');
    }

    // Each step (the password, then a one-time code) gets its own wait and its own "message before".
    let stepStart = Date.now();
    let stepBefore = before;
    let goneStreak = 0;
    let lookedAgain = false;
    let last = before;
    for (;;) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timing.pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (leaving) {
        if (sentCode !== null) {
          return finish('submitted', {
            reason: 'code_submitted',
            hint: 'The page navigated after the one-time code was submitted; check that the app now shows you as logged in. If it asks for the code again, call login again: it reports the rejected code and sends no new one.',
          });
        }
        return finish('submitted', { hint: 'The page navigated after the login form was submitted; check that the app now shows you as logged in. If it asks for a one-time code, call login again.' });
      }
      const current = inpage('state', { successSelector: creds.successSelector }) as StateResult;
      last = current;
      if (current.success) return finish('success');
      if (current.codeVisible && !current.passwordVisible) {
        goneStreak = 0;
        if (creds.code === undefined) return mfaRequired();
        if (sentCode === null) {
          const stopped = await sendCode(creds.code, false);
          if (stopped !== null) return stopped;
          stepStart = Date.now();
          stepBefore = current;
          lookedAgain = false;
          continue;
        }
        const newError = current.errorText !== null && current.errorText !== stepBefore.errorText;
        if (newError && Date.now() - stepStart >= timing.earlyFailAfterMs) break;
      } else if (!current.passwordVisible) {
        goneStreak += 1;
        if (goneStreak >= 2) return finish('success');
      } else {
        goneStreak = 0;
        const newError = current.errorText !== null && current.errorText !== stepBefore.errorText;
        if (newError && Date.now() - stepStart >= timing.earlyFailAfterMs) break;
      }
      if (Date.now() - stepStart >= timing.verifyTimeoutMs) {
        // The form was gone on the last look: look once more before calling the login failed (see engine.ts).
        if (goneStreak === 0 || lookedAgain) break;
        lookedAgain = true;
      }
    }
    clearFields();
    if (sentCode !== null && last.codeVisible) return finish('failed', { reason: 'totp_rejected', hint: scrub(last.errorText ?? TOTP_REJECTED_HINT) });
    return finish('failed', {
      reason: 'still_on_login_form',
      hint: scrub(last.errorText ?? 'Still on the login form after submitting. Check the credentials, or set selectors for this profile.'),
    });
  } catch (error) {
    clearFields();
    return finish('error', { hint: scrub(error instanceof Error ? error.message : String(error)) });
  } finally {
    window.removeEventListener('beforeunload', onLeave);
  }
}

export const REUSED_NOTE = 'This one-time script already ran; this is the outcome of that run.';

/**
 * The script served to the page: fetches the credentials (origin-checked) and runs bridgeLogin.
 * A re-run of a used script gets the first run's outcome instead of credentials.
 * `noForm` is merged into a `no_login_form` outcome, typically "the previous login already went through".
 */
export function fillerScript(
  base: string,
  token: string,
  timing: BridgeTiming,
  noForm: NoFormContext | null = null,
  hints: { selectors: InpageSelectors; successSelector?: string; totp?: boolean; codeStep?: CodeStep } = { selectors: {} },
  codeNonce: string | null = null,
): string {
  return [
    '(() => {',
    `const inpage = ${autologinInpage.toString()};`,
    `const login = ${bridgeLogin.toString()};`,
    `const base = ${JSON.stringify(base)};`,
    `const token = ${JSON.stringify(token)};`,
    `const noForm = ${JSON.stringify(noForm)};`,
    "const explain = (result) => (noForm !== null && result.status === 'no_login_form' ? Object.assign({}, result, noForm) : result);",
    "const done = (detail) => window.dispatchEvent(new CustomEvent('autologin-mcp:' + token, { detail }));",
    "const report = (result) => { fetch(base + '/v1/result/' + token, { method: 'POST', body: JSON.stringify(result), keepalive: true }).catch(() => {}); return result; };",
    // The credentials are fetched only when the page is about to type them (see LazyBridgeCredentials).
    'let refused = null;',
    "const load = () => fetch(base + '/v1/credentials/' + token, { method: 'POST' }).then(async (res) => {",
    '  const body = await res.json();',
    '  if (res.ok) return { username: body.username, password: body.password };',
    `  refused = body.result ? Object.assign({}, body.result, { note: ${JSON.stringify(REUSED_NOTE)} }) : body;`,
    "  throw new Error(refused.hint || refused.status || 'credentials refused');",
    '});',
    // A TOTP profile's current code, fetched only when the page shows the code step (the secret stays on the machine).
    `const codeNonce = ${JSON.stringify(codeNonce)};`,
    "const loadCode = (codeOnly) => fetch(base + '/v1/code/' + token, { method: 'POST', body: JSON.stringify({ nonce: codeNonce, codeOnly: codeOnly === true }) }).then(async (res) => {",
    '  const body = await res.json();',
    '  if (res.ok) return body.code;',
    "  throw new Error(body.hint || body.status || 'one-time code refused');",
    '});',
    `const hints = ${JSON.stringify(hints)};`,
    'login(inpage, Object.assign(hints, { load }, hints.totp ? { code: loadCode } : {}), ' + `${JSON.stringify(timing)})`,
    '  .then((result) => (refused !== null ? refused : report(explain(result))))',
    "  .then(done, (error) => done({ status: 'error', url: location.href, hint: 'autologin-mcp bridge: ' + (error && error.message ? error.message : String(error)) }));",
    '})();',
  ].join('\n');
}

/**
 * What the agent runs in the tab (function form, for tools like Playwright MCP browser_evaluate).
 * It contains only a one-time URL, never a credential.
 */
export function agentFunction(base: string, token: string): string {
  const src = JSON.stringify(`${base}/v1/filler/${token}.js`);
  const event = JSON.stringify(`autologin-mcp:${token}`);
  return (
    'async () => new Promise((resolve) => { ' +
    'const done = (r) => { clearTimeout(t); resolve(r); }; ' +
    "const t = setTimeout(() => done({ status: 'error', hint: 'autologin-mcp bridge timed out' }), 30000); " +
    `window.addEventListener(${event}, (e) => done(e.detail), { once: true }); ` +
    "const s = document.createElement('script'); " +
    `s.src = ${src}; s.crossOrigin = 'anonymous'; ` +
    "s.onerror = () => done({ status: 'error', hint: 'The page blocked the autologin-mcp bridge (Content-Security-Policy?) or the MCP server stopped' }); " +
    '(document.head || document.documentElement).append(s); })'
  );
}

/** Expression form with top-level await, for REPL-style tools such as Claude in Chrome's javascript_tool. */
export const agentScript = (fn: string): string => `await (${fn})()`;

/**
 * Expression form without top-level await: it evaluates to a Promise of the result, for tools that
 * evaluate a plain script and wait for its value (Puppeteer page.evaluate, CDP Runtime.evaluate with awaitPromise).
 * There, `await (...)()` fails with "await is not defined".
 */
export const agentExpression = (fn: string): string => `(${fn})()`;
