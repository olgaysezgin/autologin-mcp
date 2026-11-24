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

  describe('a page that is busy when the wait runs out', () => {
    /** Blocks the page's only thread, like a heavy render right after the login. */
    const busy = (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end);
    };

    it('looks once more when the form went away just before', async () => {
      app(() =>
        setTimeout(() => {
          document.querySelector('#login')!.remove();
          busy(TIMING.verifyTimeoutMs + 20);
        }, 1),
      );
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'success', url: location.href });
    });

    it('still fails when the form is back on that last look', async () => {
      app(() =>
        setTimeout(() => {
          const form = document.querySelector('#login')!;
          const parent = form.parentElement!;
          form.remove();
          busy(TIMING.verifyTimeoutMs + 20);
          setTimeout(() => parent.prepend(form), 0);
        }, 1),
      );
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'failed', reason: 'still_on_login_form' });
    });
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

  it('handles an identifier-first page that swaps in the password step', async () => {
    document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div></div><p id="err" class="error"></p>`;
    document.querySelector('#next')!.addEventListener('click', () => {
      document.body.innerHTML = `<div id="step2"><input id="pw" type="password"><div role="button" id="go">Sign in</div><p id="err" class="error"></p></div>`;
      document.querySelector('#go')!.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelector('#step2')!.remove();
      });
    });
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'success', url: location.href });
  });

  it('stops on an identifier-first page whose username is rejected', async () => {
    document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div><p id="err" class="error"></p></div>`;
    document.querySelector('#next')!.addEventListener('click', () => {
      document.querySelector('#err')!.textContent = `No account for ${CREDS.username}`;
    });
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'failed', url: location.href, reason: 'identifier_rejected', hint: `No account for ${CREDS.username}` });
  });

  it('times out when the password step never appears, and reports a navigation on the way', async () => {
    const identifier = () =>
      (document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div></div>`);
    identifier();
    expect(await bridgeLogin(autologinInpage, CREDS, { ...TIMING, detectTimeoutMs: 30 })).toMatchObject({ status: 'needs_human', reason: 'password_step_timeout' });

    identifier();
    const next = document.querySelector('#next')!;
    next.addEventListener('click', () => setTimeout(() => window.dispatchEvent(new Event('beforeunload')), 5));
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'submitted', reason: 'username_step_navigated', hint: expect.stringContaining('navigated') });
  });

  describe('identifier-first safety', () => {
    /** For tests whose page changes after a delay: room for slow CI runners; they end as soon as the page changes. */
    const ROOMY: BridgeTiming = { ...TIMING, detectTimeoutMs: 1_000 };

    /** One-page form whose password field mounts `delay` ms after the email field and the button. */
    function staggered(button: string, delay: number) {
      const seen: Array<{ username: string; password: string }> = [];
      document.body.innerHTML = `<div id="login"><input id="user" type="email"><span id="slot"></span><div role="button" id="go">${button}</div><p id="err" class="error"></p></div>`;
      setTimeout(() => (document.querySelector('#slot')!.innerHTML = '<input id="pass" type="password">'), delay);
      document.querySelector('#go')!.addEventListener('click', () => {
        const password = document.querySelector<HTMLInputElement>('#pass')?.value ?? '';
        seen.push({ username: document.querySelector<HTMLInputElement>('#user')!.value, password });
        if (password === '') showError('Password is required');
        else document.querySelector('#login')!.remove();
      });
      return seen;
    }

    it('waits for a password field that mounts after the email field and a Log in button', async () => {
      const seen = staggered('Log in', 60);
      expect(await bridgeLogin(autologinInpage, CREDS, ROOMY)).toEqual({ status: 'success', url: location.href });
      expect(seen).toEqual([{ username: CREDS.username, password: CREDS.password }]);
    });

    it('waits a moment before treating a Continue button as an identifier step', async () => {
      const seen = staggered('Continue', 20);
      expect(await bridgeLogin(autologinInpage, CREDS, ROOMY)).toEqual({ status: 'success', url: location.href });
      expect(seen).toEqual([{ username: CREDS.username, password: CREDS.password }]);
    });

    it('treats a Sign in button as an identifier step only once the password field had its time', async () => {
      document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="go">Sign in</div></div>`;
      let clickedAt = 0;
      document.querySelector('#go')!.addEventListener('click', () => {
        clickedAt = Date.now();
        document.body.innerHTML = `<div id="step2"><input id="pw" type="password"><div role="button" id="go2">Sign in</div></div>`;
        document.querySelector('#go2')!.addEventListener('click', () => document.querySelector('#step2')!.remove());
      });
      const startedAt = Date.now();
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'success', url: location.href });
      expect(clickedAt - startedAt).toBeGreaterThanOrEqual(TIMING.detectTimeoutMs - 5);
    });

    it('ignores an alert that was on the page before the username step', async () => {
      document.body.innerHTML = `<p role="alert">Your session has expired. Please sign in again.</p><div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div></div>`;
      document.querySelector('#next')!.addEventListener('click', () =>
        setTimeout(() => {
          document.querySelector('#step1')!.innerHTML = `<input id="pw" type="password"><div role="button" id="go">Sign in</div>`;
          document.querySelector('#go')!.addEventListener('click', () => document.querySelector('#step1')!.remove());
        }, 60),
      );
      expect(await bridgeLogin(autologinInpage, CREDS, ROOMY)).toEqual({ status: 'success', url: location.href });
    });

    it('still reports a username that the page rejects next to an older alert', async () => {
      document.body.innerHTML = `<p role="alert">Your session has expired.</p><div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div><p id="err" class="error"></p></div>`;
      document.querySelector('#next')!.addEventListener('click', () => {
        document.querySelector('p[role="alert"]')!.remove();
        document.querySelector('#err')!.textContent = 'No account for this email';
      });
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'failed', url: location.href, reason: 'identifier_rejected', hint: 'No account for this email' });
    });

    it('reports a page that navigates right away on the username step, as a username step only', async () => {
      document.body.innerHTML = `<form><input id="mail" type="email"><button id="next" type="button">Next</button></form>`;
      document.querySelector('#next')!.addEventListener('click', () => window.dispatchEvent(new Event('beforeunload')));
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({
        status: 'submitted',
        reason: 'username_step_navigated',
        hint: expect.stringContaining('Only the username was sent'),
      });
    });


    it('presses Enter in the username field when its button is gone by the time it submits', async () => {
      document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div></div>`;
      const mail = document.querySelector('#mail')!;
      mail.addEventListener('input', () => document.querySelector('#next')?.remove());
      mail.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key !== 'Enter') return;
        document.querySelector('#step1')!.innerHTML = `<input id="pw" type="password"><div role="button" id="go">Sign in</div>`;
        document.querySelector('#go')!.addEventListener('click', () => document.querySelector('#step1')!.remove());
      });
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toEqual({ status: 'success', url: location.href });
    });

    it('hands the login to a human, without a failure, when no password step follows the username', async () => {
      document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div></div>`;
      expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'needs_human', reason: 'password_step_timeout', hint: expect.stringContaining('single sign-on') });
    });
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

describe('bridgeLogin: credentials only when there is a form to fill (#2)', () => {
  const lazy = () => {
    const load = vi.fn(async () => ({ username: CREDS.username, password: CREDS.password }));
    return { creds: { selectors: {}, load }, load };
  };

  it('never asks for the credentials on a page without a login form, or on one a person has to finish', async () => {
    document.body.innerHTML = `<p>Dashboard</p>`;
    let { creds, load } = lazy();
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toMatchObject({ status: 'no_login_form' });
    expect(load).not.toHaveBeenCalled();
    document.body.innerHTML = `<main><button>Sign in with Google</button></main>`;
    ({ creds, load } = lazy());
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toMatchObject({ status: 'needs_human', reason: 'sso' });
    expect(load).not.toHaveBeenCalled();
  });

  it('asks for the credentials once, right before typing', async () => {
    let received: unknown = null;
    app((state) => {
      received = { ...state };
      document.querySelector('#login')!.remove();
    });
    const { creds, load } = lazy();
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toEqual({ status: 'success', url: location.href });
    expect(load).toHaveBeenCalledOnce();
    expect(received).toEqual({ username: CREDS.username, password: CREDS.password });
  });

  it('types nothing when the credentials are refused', async () => {
    app(() => undefined);
    const creds = { selectors: {}, load: vi.fn(async () => Promise.reject(new Error('refused'))) };
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toMatchObject({ status: 'error', hint: 'refused' });
    expect(document.querySelector<HTMLInputElement>('#user')!.value).toBe('');
  });

  it('reports a one-time-code step after the password as mfa_required', async () => {
    app(() => (document.querySelector('#login')!.innerHTML = '<input id="otp" autocomplete="one-time-code" inputmode="numeric">'));
    expect(await bridgeLogin(autologinInpage, CREDS, TIMING)).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
  });
});

describe('bridgeLogin: fields re-rendered while the credentials arrive (#2 review)', () => {
  it('types nothing when the username step went away meanwhile', async () => {
    document.body.innerHTML = `<div id="step1"><input id="mail" type="email"><div role="button" id="next">Next</div></div>`;
    const creds = {
      selectors: {},
      load: vi.fn(async () => {
        document.querySelector('#step1')!.remove();
        return { username: CREDS.username, password: CREDS.password };
      }),
    };
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toMatchObject({ status: 'no_login_form', hint: expect.stringContaining('nothing was typed') });
  });

  it('types nothing when the form went away meanwhile', async () => {
    app(() => undefined);
    const creds = {
      selectors: {},
      load: vi.fn(async () => {
        document.querySelector('#login')!.remove();
        return { username: CREDS.username, password: CREDS.password };
      }),
    };
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toMatchObject({ status: 'no_login_form', hint: expect.stringContaining('nothing was typed') });
  });

  it('tags the form again after the credentials came back', async () => {
    let received: unknown = null;
    const mount = () =>
      app((state) => {
        received = { ...state };
        document.querySelector('#login')!.remove();
      });
    mount();
    const creds = {
      selectors: {},
      load: vi.fn(async () => {
        mount(); // React re-renders the form while the page waits for the credentials
        return { username: CREDS.username, password: CREDS.password };
      }),
    };
    expect(await bridgeLogin(autologinInpage, creds, TIMING)).toEqual({ status: 'success', url: location.href });
    expect(received).toEqual({ username: CREDS.username, password: CREDS.password });
  });
});

describe('TOTP codes after the password (#1)', () => {
  /** The password form gives way to a code step; `onVerify` gets what was typed into the code field. */
  function codeApp(onVerify: (code: string) => void) {
    app(() => {
      document.querySelector('#login')!.innerHTML = `<input id="otp" autocomplete="one-time-code"><button id="verify">Verify</button><p id="err" class="error"></p>`;
      document.querySelector('#verify')!.addEventListener('click', () => onVerify(document.querySelector<HTMLInputElement>('#otp')!.value));
    });
  }

  it('asks for the code only at the code step, fills it, submits it and succeeds', async () => {
    const code = vi.fn(async () => '123456');
    let typed = '';
    codeApp((value) => {
      typed = value;
      document.querySelector('#login')!.remove();
    });
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code }, TIMING)).toEqual({ status: 'success', url: location.href });
    expect(typed).toBe('123456');
    expect(code).toHaveBeenCalledOnce();
  });

  it('reports a rejected code as failed, with the code scrubbed from the page message', async () => {
    codeApp(() => setTimeout(() => showError('Code 123456 is not valid'), 5));
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code: async () => '123456' }, TIMING)).toEqual({
      status: 'failed',
      url: location.href,
      reason: 'totp_rejected',
      hint: 'Code [REDACTED] is not valid',
    });
  });

  it('fails with a hint about the secret and the clock when the code step stays', async () => {
    codeApp(() => undefined);
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code: async () => '123456' }, TIMING)).toMatchObject({
      status: 'failed',
      reason: 'totp_rejected',
      hint: expect.stringContaining('clock'),
    });
  });

  it('presses Enter in a code field without a button', async () => {
    app(() => {
      const login = document.querySelector('#login')!;
      login.innerHTML = '<input id="otp" name="otp">';
      document.querySelector('#otp')!.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') login.remove();
      });
    });
    expect((await bridgeLogin(autologinInpage, { ...CREDS, code: async () => '123456' }, TIMING)).status).toBe('success');
  });

  it('types nothing when the code is refused or the code step went away meanwhile', async () => {
    codeApp(() => undefined);
    const refused = async (): Promise<string> => {
      throw new Error('This login already got its one-time code.');
    };
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code: refused }, TIMING)).toEqual({ status: 'error', url: location.href, hint: 'This login already got its one-time code.' });
    expect(document.querySelector<HTMLInputElement>('#otp')!.value).toBe('');

    codeApp(() => undefined);
    const gone = async () => {
      document.querySelector('#login')!.innerHTML = '<p>Choose another way to sign in</p><input name="otp" style="display:none">';
      return '123456';
    };
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code: gone }, TIMING)).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
  });
});

describe('TOTP codes: review fixes (#1 review)', () => {
  it('fills only the code on a code page of its own, never asking for the credentials', async () => {
    document.body.innerHTML = `<form id="f"><label>Code <input name="user[otp_attempt]" autocomplete="one-time-code"></label><input type="submit" value="Verify"></form>`;
    let typed = '';
    document.querySelector('#f')!.addEventListener('submit', (e) => {
      e.preventDefault();
      typed = document.querySelector<HTMLInputElement>('input[autocomplete]')!.value;
      document.querySelector('#f')!.remove();
    });
    const load = vi.fn(async () => ({ username: 'u', password: 'p' }));
    const code = vi.fn(async () => '654321');
    expect(await bridgeLogin(autologinInpage, { selectors: {}, load, code, codeStep: 'after_password' }, TIMING)).toEqual({ status: 'success', url: location.href });
    expect(typed).toBe('654321');
    expect(load).not.toHaveBeenCalled();
    expect(code).toHaveBeenCalledWith(true);
  });

  it('hands a code page to a person when its code field goes away while the code is on its way', async () => {
    document.body.innerHTML = `<input name="otp"><button>Verify</button>`;
    const gone = async () => {
      document.body.innerHTML = '<p>Choose another way to sign in</p>';
      return '123456';
    };
    expect(await bridgeLogin(autologinInpage, { selectors: {}, load: vi.fn(), code: gone, codeStep: 'after_password' }, TIMING)).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
  });

  it('hands a code page to a person at once without a TOTP secret', async () => {
    document.body.innerHTML = `<input name="otp"><button>Verify</button>`;
    const startedAt = Date.now();
    expect(await bridgeLogin(autologinInpage, { ...CREDS, codeStep: 'after_password' }, { ...TIMING, detectTimeoutMs: 2_000 })).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('keeps the code out of the result URL, as a GET form would carry it', async () => {
    const original = location.href;
    app(() => {
      document.querySelector('#login')!.innerHTML = `<input id="otp" name="otp"><button id="verify">Verify</button>`;
      document.querySelector('#verify')!.addEventListener('click', () => {
        history.replaceState(null, '', `/verify?otp=${document.querySelector<HTMLInputElement>('#otp')!.value}`);
        document.querySelector('#login')!.remove();
      });
    });
    const result = await bridgeLogin(autologinInpage, { ...CREDS, code: async () => '123456' }, TIMING);
    history.replaceState(null, '', original);
    expect(result).toEqual({ status: 'success', url: expect.stringMatching(/\/verify\?otp=\[REDACTED\]$/) });
  });

  it('clears the code and a hidden password after a rejected code', async () => {
    app(() => {
      document.querySelector<HTMLElement>('#pass')!.style.display = 'none';
      document.querySelector<HTMLElement>('#go')!.style.display = 'none';
      document.querySelector('#login')!.insertAdjacentHTML('beforeend', `<input id="otp" name="otp"><button id="verify">Verify</button>`);
      document.querySelector('#verify')!.addEventListener('click', () => showError('Wrong code'));
    });
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code: async () => '123456' }, TIMING)).toMatchObject({ status: 'failed', reason: 'totp_rejected', hint: 'Wrong code' });
    expect(document.querySelector<HTMLInputElement>('#pass')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#otp')!.value).toBe('');
  });
});

describe('TOTP codes: only within a login (#1 review 2)', () => {
  const codePage = () => (document.body.innerHTML = `<form id="f"><input name="otp" autocomplete="one-time-code"><button type="submit">Verify</button></form>`);

  it('leaves a code page alone when no login is in progress, as before TOTP support', async () => {
    codePage();
    const code = vi.fn(async () => '123456');
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code }, TIMING)).toMatchObject({ status: 'no_login_form' });
    expect(code).not.toHaveBeenCalled();
  });

  it('reports a code page after a submitted code as a rejected code, asking for no new one', async () => {
    codePage();
    const code = vi.fn(async () => '123456');
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code, codeStep: 'after_code' }, TIMING)).toEqual({
      status: 'failed',
      url: location.href,
      reason: 'totp_rejected',
      hint: expect.stringContaining('No new code was sent'),
    });
    expect(code).not.toHaveBeenCalled();
  });

  it('marks a page that navigates after the code was submitted, so the next call can tell a rejected code', async () => {
    app(() => {
      document.querySelector('#login')!.innerHTML = `<input id="otp" name="otp"><button id="verify">Verify</button>`;
      document.querySelector('#verify')!.addEventListener('click', () => window.dispatchEvent(new Event('beforeunload')));
    });
    const code = vi.fn(async () => '123456');
    expect(await bridgeLogin(autologinInpage, { ...CREDS, code }, TIMING)).toMatchObject({ status: 'submitted', reason: 'code_submitted', hint: expect.stringContaining('call login again') });
    expect(code).toHaveBeenCalledWith(false);
  });
});
