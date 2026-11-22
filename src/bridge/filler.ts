import type { NoFormContext } from '../results.js';
import { autologinInpage, type DetectResult, type InpageSelectors, type StateResult, type SubmitResult } from '../inpage.js';

export interface BridgeCredentials {
  username: string;
  password: string;
  selectors: InpageSelectors;
  successSelector?: string;
}

export interface BridgeTiming {
  detectTimeoutMs: number;
  verifyTimeoutMs: number;
  pollMs: number;
  earlyFailAfterMs: number;
}

export type BridgeStatus = 'success' | 'submitted' | 'failed' | 'no_login_form' | 'error';

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
export async function bridgeLogin(inpage: typeof autologinInpage, creds: BridgeCredentials, timing: BridgeTiming): Promise<BridgeResult> {
  const ATTR = 'data-autologin-mcp';
  const scrub = (text: string): string => text.split(creds.password).join('[REDACTED]');
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
    let detected = inpage('detect', { selectors: creds.selectors }) as DetectResult;
    while (!detected.found && !detected.error && Date.now() - startedAt < timing.detectTimeoutMs) {
      await sleep(timing.pollMs);
      detected = inpage('detect', { selectors: creds.selectors }) as DetectResult;
    }
    if (!detected.found) return finish('no_login_form', { hint: detected.error ?? 'No visible password field was found on the page.' });

    const before = inpage('state', { successSelector: creds.successSelector }) as StateResult;
    const fill = (role: string, value: string): void => {
      const field = document.querySelector<HTMLInputElement>(`[${ATTR}="${role}"]`)!;
      field.focus();
      // The native setter plus input/change events is what React, Vue and Angular listen to.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (detected.hasUsername) fill('username', creds.username);
    fill('password', creds.password);

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
export function fillerScript(base: string, token: string, timing: BridgeTiming, noForm: NoFormContext | null = null): string {
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
    "fetch(base + '/v1/credentials/' + token, { method: 'POST' })",
    `  .then(async (res) => { const body = await res.json(); if (res.ok) return report(explain(await login(inpage, body, ${JSON.stringify(timing)}))); return body.result ? Object.assign({}, body.result, { note: ${JSON.stringify(REUSED_NOTE)} }) : body; })`,
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

/** Expression form, for REPL-style tools such as Claude in Chrome's javascript_tool. */
export const agentScript = (fn: string): string => `await (${fn})()`;
