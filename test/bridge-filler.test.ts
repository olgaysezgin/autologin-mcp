// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentExpression, agentFunction, agentScript, bridgeLogin, fillerScript, type BridgeCredentials, type BridgeTiming } from '../src/bridge/filler.ts';
import { autologinInpage } from '../src/inpage.ts';

const TIMING: BridgeTiming = { detectTimeoutMs: 100, verifyTimeoutMs: 200, pollMs: 10, earlyFailAfterMs: 30 };
const CREDS: BridgeCredentials = { username: 'qa@example.com', password: `p'w"#1`, selectors: {} };

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    let size = 20;
    for (let el: Element | null = this; el; el = el.parentElement) if ((el as HTMLElement).style.display === 'none') size = 0;
    return { width: size, height: size } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

/** A React-like login: state only changes through input events; `onSubmit` decides what happens. */
function app(onSubmit: (state: { username: string; password: string }) => void, markup?: string) {
  document.body.innerHTML =
    markup ??
    `<div id="login"><input id="user" type="email"><input id="pass" type="password"><div role="button" id="go">Log in</div><p id="err" class="error"></p></div><nav id="menu" style="display:none">Me</nav>`;
  const state = { username: '', password: '' };
  document.querySelector('#user')?.addEventListener('input', (e) => (state.username = (e.target as HTMLInputElement).value));
  document.querySelector('#pass')!.addEventListener('input', (e) => (state.password = (e.target as HTMLInputElement).value));
  document.querySelector('#go')?.addEventListener('click', () => onSubmit(state));
  return state;
}

const showError = (text: string) => {
  const err = document.querySelector<HTMLElement>('#err')!;
  err.textContent = text;
};

describe('bridgeLogin', () => {
  it('fills controlled inputs through input events and succeeds when the form goes away', async () => {
    let received: unknown = null;
    app((state) => {
      received = { ...state };
      document.querySelector('#login')!.remove();
    });
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'success', url: location.href });
    expect(received).toEqual({ username: CREDS.username, password: CREDS.password });
  });

  it('succeeds on the success selector while the form stays visible', async () => {
    app(() => {
      document.querySelector<HTMLElement>('#menu')!.style.display = 'block';
    });
    expect((await bridgeLogin(autologinInpage, { ...CREDS, successSelector: '#menu' }, TIMING)).status).toBe('success');
  });

  it('fails early on a new error, scrubs the password from it and clears the field', async () => {
    app(() => setTimeout(() => showError(`Wrong password ${CREDS.password}`), 5));
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({
      status: 'failed',
      url: location.href,
      reason: 'still_on_login_form',
      hint: 'Wrong password [REDACTED]',
    });
    expect(document.querySelector<HTMLInputElement>('#pass')!.value).toBe('');
  });

  it('waits for the timeout when the error was already there, or reports a generic failure', async () => {
    app(() => undefined);
    showError('Session expired');
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'failed', hint: 'Session expired' });
    app(() => undefined);
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'failed', hint: expect.stringContaining('Still on the login form') });
  });

  it('reports that the page navigated after submitting', async () => {
    app(() => window.dispatchEvent(new Event('beforeunload')));
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'submitted', hint: expect.stringContaining('navigated') });
  });

  it('wakes up as soon as the page starts navigating while it waits', async () => {
    app(() => setTimeout(() => window.dispatchEvent(new Event('beforeunload')), 3));
    const startedAt = Date.now();
    expect((await bridgeLogin(autologinInpage, CREDS, { ...TIMING, pollMs: 1_000 })).status).toBe('submitted');
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('presses Enter when there is nothing to click and fills only the password when there is no username field', async () => {
    let received: unknown = null;
    app(() => undefined, '<input id="pass" type="password">');
    document.querySelector('#pass')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        received = (e.target as HTMLInputElement).value;
        document.querySelector('#pass')!.remove();
      }
    });
    expect((await bridgeLogin(autologinInpage, CREDS, TIMING)).status).toBe('success');
    expect(received).toBe(CREDS.password);
  });

  it('submits a form without a button', async () => {
    app(() => undefined, '<form id="f"><input id="user" type="text"><input id="pass" type="password"></form>');
    document.querySelector('#f')!.addEventListener('submit', (e) => {
      e.preventDefault();
      document.querySelector('#f')!.remove();
    });
    expect((await bridgeLogin(autologinInpage, CREDS, TIMING)).status).toBe('success');
  });

  it('waits for a form that renders late', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    setTimeout(() => app(() => document.querySelector('#login')!.remove()), 30);
    expect((await bridgeLogin(autologinInpage, CREDS, TIMING)).status).toBe('success');
  });

  it('reports pages without a login form and selectors that do not match', async () => {
    document.body.innerHTML = '<main>Dashboard</main>';
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'no_login_form', hint: 'No visible password field was found on the page.' });
    expect(await bridgeLogin(autologinInpage, { ...CREDS, selectors: { password: '#nope' } }, TIMING)).toMatchObject({
      status: 'no_login_form',
      hint: expect.stringContaining('password selector'),
    });
  });

  it('turns unexpected exceptions into scrubbed errors', async () => {
    document.body.innerHTML = '<input type="password">';
    const lying = ((action, arg) => (action === 'detect' ? { found: true, hasUsername: true, hasSubmit: false } : autologinInpage(action, arg))) as typeof autologinInpage;
    expect(await bridgeLogin(lying, CREDS, TIMING)).toMatchObject({ status: 'error', hint: expect.any(String) });
    const throwing = ((action, arg) => {
      if (action === 'submit') throw `boom ${CREDS.password}`;
      return autologinInpage(action, arg);
    }) as typeof autologinInpage;
    app(() => undefined);
    expect(await bridgeLogin(throwing, CREDS, TIMING)).toMatchObject({ status: 'error', hint: 'boom [REDACTED]' });
  });
});

describe('scripts', () => {
  it('builds a self-contained, valid filler script', () => {
    const script = fillerScript('http://127.0.0.1:1234', 'TOKEN123', TIMING);
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('const inpage = function autologinInpage');
    expect(script).toContain('const login = async function bridgeLogin');
    expect(script).toContain('"http://127.0.0.1:1234"');
    expect(script).toContain(JSON.stringify(TIMING));
    expect(script).toContain('const noForm = null;');
    const noForm = { previous_login: { status: 'success', at: '2026-11-22T12:00:00.000Z' }, hint: 'already logged in' };
    const explained = fillerScript('http://127.0.0.1:1234', 'TOKEN123', TIMING, noForm);
    expect(() => new Function(explained)).not.toThrow();
    expect(explained).toContain(`const noForm = ${JSON.stringify(noForm)};`);
  });

  async function runAgent(trigger: (script: HTMLScriptElement) => void) {
    const fn = agentFunction('http://127.0.0.1:1234', 'TOKEN123');
    const run = (0, eval)(`(${fn})`) as () => Promise<unknown>;
    const pending = run();
    const script = document.querySelector<HTMLScriptElement>('script[src$="TOKEN123.js"]')!;
    expect(script.src).toBe('http://127.0.0.1:1234/v1/filler/TOKEN123.js');
    expect(script.crossOrigin).toBe('anonymous');
    trigger(script);
    return pending;
  }

  it('gives the agent a small loader that resolves with the page result', async () => {
    const fn = agentFunction('http://127.0.0.1:1234', 'TOKEN123');
    expect(agentScript(fn)).toBe(`await (${fn})()`);
    expect(agentExpression(fn)).toBe(`(${fn})()`);
    expect(fn).not.toContain(CREDS.password);
    const result = await runAgent(() => window.dispatchEvent(new CustomEvent('autologin-mcp:TOKEN123', { detail: { status: 'success' } })));
    expect(result).toEqual({ status: 'success' });
  });

  it('reports a blocked script and a timeout', async () => {
    expect(await runAgent((s) => s.onerror!(new Event('error')))).toMatchObject({ status: 'error', hint: expect.stringContaining('Content-Security-Policy') });
    vi.useFakeTimers();
    expect(await runAgent(() => vi.advanceTimersByTime(30_000))).toMatchObject({ status: 'error', hint: 'autologin-mcp bridge timed out' });
  });
});
