import type { NoFormContext } from '../results.js';
import { autologinInpage, type DetectResult, type InpageSelectors, type StateResult, type SubmitResult } from '../inpage.js';

export interface BridgeCredentials {
  username: string;
  password: string;
  selectors: InpageSelectors;
  successSelector?: string;
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
  const scrub = (text: string): string => (secret === null ? text : text.split(secret.password).join('[REDACTED]'));
  // Same words as NEEDS_HUMAN_HINTS in src/login/engine.ts (this function runs in the page and cannot import).
  const NEEDS_HUMAN_HINTS = {
    sso: "This page signs in through single sign-on (another provider), so a human has to finish this login. autologin-mcp only fills the app's own username and password form.",
    passkey: "This page asks for a passkey or security key, which needs the user's device, so a human has to finish this login.",
    captcha: 'This page shows a captcha. A human has to solve it; autologin-mcp does not.',
    mfa_required: 'The page now asks for a one-time code (a second factor) after the password, so a human has to enter it.',
  };
  const finish = (status: BridgeStatus, extra: { reason?: string; hint?: string } = {}): BridgeResult => ({ status, url: location.href, ...extra });
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  let leaving = false;
  let wake = (): void => undefined;
  const onLeave = (): void => {
    leaving = true;
    wake();
  };

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
      if (detected.found || detected.error) break;
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
    if (!detected.found) {
      if (detected.step !== 'identifier' || !detected.hasUsername) {
        if (detected.blocker) return finish('needs_human', { reason: detected.blocker, hint: NEEDS_HUMAN_HINTS[detected.blocker] });
        return finish('no_login_form', { hint: detected.error ?? 'No visible password field was found on the page.' });
      }
      // Identifier-first login: send the username, then wait for the password step.
      // A message already on the page (say "Your session has expired") is not an answer to the username.
      const beforeStep = inpage('state', { successSelector: creds.successSelector }) as StateResult;
      const stepField = document.querySelector<HTMLInputElement>(`[${ATTR}="username"]`)!;
      window.addEventListener('beforeunload', onLeave, { once: true });
      const { username } = await credentials();
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
    const fill = (role: string, value: string): void => {
      const field = document.querySelector<HTMLInputElement>(`[${ATTR}="${role}"]`)!;
      field.focus();
      // The native setter plus input/change events is what React, Vue and Angular listen to.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const { username, password } = await credentials();
    if (detected.hasUsername) fill('username', username);
    fill('password', password);

    window.addEventListener('beforeunload', onLeave, { once: true });
    if ((inpage('submit', {}) as SubmitResult) === 'none') {
      const field = document.querySelector(`[${ATTR}="password"]`)!;
      for (const type of ['keydown', 'keypress', 'keyup']) {
        field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    }

    const submittedAt = Date.now();
    let goneStreak = 0;
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
        return finish('submitted', { hint: 'The page navigated after the login form was submitted; check that the app now shows you as logged in.' });
      }
      const current = inpage('state', { successSelector: creds.successSelector }) as StateResult;
      last = current;
      if (current.success) return finish('success');
      if (current.codeVisible && !current.passwordVisible) return finish('needs_human', { reason: 'mfa_required', hint: NEEDS_HUMAN_HINTS.mfa_required });
      if (!current.passwordVisible) {
        goneStreak += 1;
        if (goneStreak >= 2) return finish('success');
      } else {
        goneStreak = 0;
        const newError = current.errorText !== null && current.errorText !== before.errorText;
        if (newError && Date.now() - submittedAt >= timing.earlyFailAfterMs) break;
      }
      if (Date.now() - submittedAt >= timing.verifyTimeoutMs) break;
    }
    inpage('clear', { role: 'password' });
    return finish('failed', {
      reason: 'still_on_login_form',
      hint: scrub(last.errorText ?? 'Still on the login form after submitting. Check the credentials, or set selectors for this profile.'),
    });
  } catch (error) {
    inpage('clear', { role: 'password' });
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
  hints: { selectors: InpageSelectors; successSelector?: string } = { selectors: {} },
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
    `login(inpage, Object.assign(${JSON.stringify(hints)}, { load }), ${JSON.stringify(timing)})`,
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
