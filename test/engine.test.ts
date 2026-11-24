import { describe, expect, it, vi } from 'vitest';
import type { DetectResult, InpageAction, StateResult } from '../src/inpage.ts';
import type { CodeResult } from '../src/inpage.ts';
import { DEFAULT_TIMING, performLogin, realClock, type Clock, type ElementLike, type PageLike } from '../src/login/engine.ts';
import { buildStore, type UsableProfile } from '../src/store/profiles.ts';
import { totpCode } from '../src/totp.ts';

const profile = buildStore({ APP_URL: 'app.test', APP_USERNAME: 'qa', APP_PASSWORD: 'pw', APP_SUCCESS_SELECTOR: '#menu' })
  .profiles[0] as UsableProfile;

const FOUND: DetectResult = { found: true, hasUsername: true, hasSubmit: true };
const onForm = (errorText: string | null = null): StateResult => ({ ready: true, passwordVisible: true, success: false, errorText });
const gone: StateResult = { ready: true, passwordVisible: false, success: false, errorText: null };
const loggedIn: StateResult = { ready: true, passwordVisible: true, success: true, errorText: null };
const loading: StateResult = { ready: false, passwordVisible: false, success: false, errorText: null };

type Step<T> = T | Error;

/** A scripted page: each action returns the next value of its queue (the last one repeats). */
class FakePage implements PageLike {
  readonly calls: string[] = [];
  readonly typed: string[] = [];
  clickError: Error | null = null;
  elements = new Set(['username', 'password', 'submit']);
  bringToFrontError: unknown = null;
  submitResult: 'clicked' | 'submitted' | 'none' = 'clicked';
  insertError: unknown = null;
  currentUrl = 'https://app.test/login';
  onSubmit: (() => void) | null = null;
  onFocus: ((role: string) => void) | null = null;

  constructor(
    private readonly detects: Array<Step<DetectResult>>,
    private readonly states: Array<Step<StateResult>>,
  ) {}

  url(): string {
    return this.currentUrl;
  }

  private next<T>(queue: Array<Step<T>>): T {
    const value = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (value instanceof Error) throw value;
    return value;
  }

  async run<T>(action: InpageAction): Promise<T> {
    this.calls.push(action);
    if (action === 'detect') return this.next(this.detects) as T;
    if (action === 'state') return this.next(this.states) as T;
    if (action === 'submit') return this.submitResult as T;
    return true as T;
  }

  async element(selector: string): Promise<ElementLike | null> {
    const role = /"(\w+)"/.exec(selector)![1]!;
    if (!this.elements.has(role)) return null;
    return {
      focus: async () => {
        this.calls.push(`focus:${role}`);
        this.onFocus?.(role);
      },
      click: async () => {
        if (this.clickError) throw this.clickError;
        this.calls.push(`click:${role}`);
        if (role === 'submit') this.onSubmit?.();
      },
    };
  }

  async insertText(text: string): Promise<void> {
    if (this.insertError !== null) throw this.insertError;
    this.typed.push(text);
  }

  async press(key: string): Promise<void> {
    this.calls.push(`press:${key}`);
  }

  async bringToFront(): Promise<void> {
    if (this.bringToFrontError !== null) throw this.bringToFrontError;
  }
}

function fakeClock(): Clock & { t: number } {
  const clock = { t: 0, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
  return clock;
}

const timing = { detectTimeoutMs: 1_000, verifyTimeoutMs: 3_000, pollMs: 250, earlyFailAfterMs: 1_000 };

describe('performLogin', () => {
  it('retries detection until the form appears, types both fields and succeeds on the success selector', async () => {
    const page = new FakePage([new Error('navigating'), { found: false, hasUsername: false, hasSubmit: false }, FOUND], [onForm(), loggedIn]);
    const result = await performLogin(page, profile, timing, fakeClock());
    expect(result).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/login' });
    expect(page.typed).toEqual(['qa', 'pw']);
    expect(page.calls).toContain('click:submit');
    expect(page.calls).not.toContain('submit');
  });

  it('returns no_login_form immediately when a selector does not match', async () => {
    const clock = fakeClock();
    const page = new FakePage([{ found: false, hasUsername: false, hasSubmit: false, error: 'The password selector did not match a visible field.' }], [onForm()]);
    expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'no_login_form', hint: expect.stringContaining('password selector') });
    expect(clock.t).toBe(0);
  });

  it('returns no_login_form after the detect timeout', async () => {
    const page = new FakePage([{ found: false, hasUsername: false, hasSubmit: false }], [onForm()]);
    const clock = fakeClock();
    expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'no_login_form', hint: 'No visible password field was found on the page.' });
    expect(clock.t).toBe(1_000);
  });

  it('succeeds once the password field stays gone, ignoring loading states and flickers', async () => {
    const page = new FakePage([FOUND], [onForm(), loading, gone, onForm(), gone, gone]);
    expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'success' });
  });

  it('fails early on a new error message, then clears the password field', async () => {
    const clock = fakeClock();
    const page = new FakePage([FOUND], [onForm(), onForm('Wrong password')]);
    expect(await performLogin(page, profile, timing, clock)).toEqual({
      status: 'failed',
      profile: 'app',
      url: 'https://app.test/login',
      reason: 'still_on_login_form',
      hint: 'Wrong password',
    });
    expect(clock.t).toBe(1_000);
    expect(page.calls.at(-1)).toBe('clear');
  });

  it('looks once more when the password field goes away just as the wait runs out', async () => {
    const clock = fakeClock();
    const page = new FakePage([FOUND], [onForm(), ...Array<StateResult>(11).fill(onForm()), gone]);
    expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'success' });
    expect(clock.t).toBe(3_250);
  });

  it('still fails when that last look finds the password field back, or the page loading', async () => {
    for (const last of [onForm(), loading]) {
      const clock = fakeClock();
      const page = new FakePage([FOUND], [onForm(), ...Array<StateResult>(11).fill(onForm()), gone, last]);
      expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'failed', reason: 'still_on_login_form' });
      expect(clock.t).toBe(3_250);
    }
  });

  it('waits for the full timeout when the error was already shown before submitting', async () => {
    const clock = fakeClock();
    const page = new FakePage([FOUND], [onForm('Session expired')]);
    expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'failed', hint: 'Session expired' });
    expect(clock.t).toBe(3_000);
  });

  it('uses a generic hint when the page state cannot be read', async () => {
    const page = new FakePage([FOUND], [new Error('context destroyed')]);
    expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'failed', hint: expect.stringContaining('Still on the login form') });
  });

  it('types only the password when there is no username field and presses Enter when nothing can be submitted', async () => {
    const page = new FakePage([{ found: true, hasUsername: false, hasSubmit: false }], [onForm(), gone, gone]);
    page.submitResult = 'none';
    page.bringToFrontError = new Error('no window');
    expect((await performLogin(page, profile, timing, fakeClock())).status).toBe('success');
    expect(page.typed).toEqual(['pw']);
    expect(page.calls).toContain('press:Enter');
  });

  it('submits the form in-page when there is no button', async () => {
    const page = new FakePage([{ found: true, hasUsername: true, hasSubmit: false }], [onForm(), gone, gone]);
    page.submitResult = 'submitted';
    await performLogin(page, profile, timing, fakeClock());
    expect(page.calls).toContain('submit');
    expect(page.calls).not.toContain('press:Enter');
  });

  it('falls back to an in-page submit when clicking fails or the button vanished', async () => {
    const page = new FakePage([FOUND], [onForm(), gone, gone]);
    page.clickError = new Error('not clickable');
    await performLogin(page, profile, timing, fakeClock());
    expect(page.calls).toContain('submit');

    const vanished = new FakePage([FOUND], [onForm(), gone, gone]);
    vanished.elements.delete('submit');
    await performLogin(vanished, profile, timing, fakeClock());
    expect(vanished.calls).toContain('submit');
  });

  it('returns error (without the password) when a field disappears or typing fails', async () => {
    const page = new FakePage([FOUND], [onForm()]);
    page.elements.delete('username');
    expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'error', hint: 'The username field disappeared before it could be filled.' });
    expect(page.calls.at(-1)).toBe('clear');

    const broken = new FakePage([FOUND], [onForm()]);
    broken.insertError = 'raw failure';
    expect(await performLogin(broken, profile, timing, fakeClock())).toMatchObject({ status: 'error', hint: 'raw failure' });
  });

  /** An identifier step with a Next button, seen long enough (5 polls of 250 ms) to act on. */
  const identifierSettled = (): DetectResult[] =>
    Array.from({ length: 5 }, () => ({ found: false, hasUsername: true, hasSubmit: true, step: 'identifier', nextButton: true }) as DetectResult);

  it('handles an identifier-first page: username first, then the password step', async () => {
    const page = new FakePage([...identifierSettled(), FOUND], [onForm(), loggedIn]);
    expect(await performLogin(page, profile, timing, fakeClock())).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/login' });
    expect(page.typed).toEqual(['qa', 'qa', 'pw']);
    expect(page.calls).toContain('click:submit');
  });

  it('fills the username again when the password step repeats it', async () => {
    const withUsername: DetectResult = { found: true, hasUsername: true, hasSubmit: true };
    const page = new FakePage([...identifierSettled(), withUsername], [onForm(), loggedIn]);
    expect((await performLogin(page, profile, timing, fakeClock())).status).toBe('success');
    expect(page.typed).toEqual(['qa', 'qa', 'pw']);
  });

  it('stops when the identifier step shows an error', async () => {
    const identifier: DetectResult = { found: false, hasUsername: true, hasSubmit: true, step: 'identifier' };
    const page = new FakePage([identifier], [onForm(), onForm('We could not find your account')]);
    expect(await performLogin(page, profile, timing, fakeClock())).toEqual({
      status: 'failed',
      profile: 'app',
      url: 'https://app.test/login',
      reason: 'identifier_rejected',
      hint: 'We could not find your account',
    });
    expect(page.typed).toEqual(['qa']);
  });

  it('reports a timeout when the password step never appears', async () => {
    const page = new FakePage(identifierSettled(), [onForm()]);
    const clock = fakeClock();
    expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'needs_human', reason: 'password_step_timeout', hint: expect.stringContaining('single sign-on') });
    expect(clock.t).toBe(2_000); // 1 s settle + 1 s for the password step
  });

  describe('identifier-first safety', () => {
    const next: DetectResult = { found: false, hasUsername: true, hasSubmit: true, step: 'identifier', nextButton: true };
    const final: DetectResult = { found: false, hasUsername: true, hasSubmit: true, step: 'identifier', nextButton: false };
    const repeat = <T,>(value: T, n: number): T[] => Array.from({ length: n }, () => value);

    it('waits for a password field that shows up within the detect time instead of sending the username alone', async () => {
      const page = new FakePage([final, final, final, FOUND], [onForm(), loggedIn]);
      expect(await performLogin(page, profile, timing, fakeClock())).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/login' });
      expect(page.typed).toEqual(['qa', 'pw']);
      expect(page.calls.filter((c) => c === 'click:submit')).toHaveLength(1);
    });

    it('acts on a Next button only after it stayed for the settle time', async () => {
      const page = new FakePage([next, next, FOUND], [onForm(), loggedIn]);
      expect((await performLogin(page, profile, timing, fakeClock())).status).toBe('success');
      expect(page.typed).toEqual(['qa', 'pw']);
    });

    it('treats a final-looking button as an identifier step once the detect time is over', async () => {
      const clock = fakeClock();
      const page = new FakePage([...repeat(final, 5), FOUND], [onForm(), onForm(), loggedIn]);
      expect((await performLogin(page, profile, timing, clock)).status).toBe('success');
      expect(page.typed).toEqual(['qa', 'qa', 'pw']);
    });

    it('ignores an error that was on the page before the username step', async () => {
      const expired = onForm('Your session has expired');
      const page = new FakePage([...repeat(next, 5), next, FOUND], [expired, expired, expired, loggedIn]);
      expect(await performLogin(page, profile, timing, fakeClock())).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/login' });
    });

    it('still reports a new error after the username step', async () => {
      const page = new FakePage([...repeat(next, 5), next], [onForm('Your session has expired'), onForm('No account for this email')]);
      expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'failed', reason: 'identifier_rejected', hint: 'No account for this email' });
    });

    it('goes on with the username step when the tab cannot be brought to the front', async () => {
      const page = new FakePage([...repeat(next, 5), FOUND], [onForm(), loggedIn]);
      page.bringToFrontError = new Error('no window');
      expect((await performLogin(page, profile, timing, fakeClock())).status).toBe('success');
      expect(page.typed).toEqual(['qa', 'qa', 'pw']);
    });

    it('types nothing into another site when the username step leads there (single sign-on)', async () => {
      const page = new FakePage([...repeat(next, 5), next, FOUND], [onForm(), onForm(), loggedIn]);
      page.onSubmit = () => (page.currentUrl = 'https://login.idp.test/authorize?client=app');
      expect(await performLogin(page, profile, timing, fakeClock())).toEqual({
        status: 'needs_human',
        profile: 'app',
        url: 'https://login.idp.test/authorize?client=app',
        reason: 'left_profile_site',
        hint: expect.stringContaining('login.idp.test, which is not part of profile "app"'),
      });
      expect(page.typed).toEqual(['qa']);
    });

    it('reports a message on the other site as left_profile_site, not as a rejected username', async () => {
      const page = new FakePage([...repeat(next, 5), next], [onForm(), onForm('Enter your password for Contoso')]);
      page.onSubmit = () => (page.currentUrl = 'https://login.idp.test/');
      expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'left_profile_site' });
    });

    it('checks the site again between focusing the password field and typing', async () => {
      const page = new FakePage([FOUND], [onForm(), loggedIn]);
      page.onFocus = (role) => {
        if (role === 'password') page.currentUrl = 'https://login.idp.test/';
      };
      expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'left_profile_site', url: 'https://login.idp.test/' });
      expect(page.typed).toEqual(['qa']);
      expect(page.calls).not.toContain('click:submit');
    });

    it('types nothing when the tab is on another site before it starts', async () => {
      const page = new FakePage([...repeat(next, 5)], [onForm()]);
      page.currentUrl = 'https://elsewhere.test/login';
      expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'left_profile_site' });
      const onePage = new FakePage([FOUND], [onForm()]);
      onePage.currentUrl = 'https://elsewhere.test/login';
      expect(await performLogin(onePage, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'left_profile_site' });
      expect([...page.typed, ...onePage.typed]).toEqual([]);
    });

    it('hands the login to a human, without a failure, when no password step follows', async () => {
      const page = new FakePage([next], [onForm()]);
      expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'password_step_timeout', hint: expect.stringContaining('single sign-on') });
    });
  });

  it('has sane defaults and a real clock', async () => {
    expect(DEFAULT_TIMING.verifyTimeoutMs).toBeGreaterThan(DEFAULT_TIMING.earlyFailAfterMs);
    const sleep = vi.spyOn(globalThis, 'setTimeout');
    const before = realClock.now();
    await realClock.sleep(1);
    expect(realClock.now()).toBeGreaterThanOrEqual(before);
    expect(sleep).toHaveBeenCalled();
    sleep.mockRestore();
  });
});

describe('pages a person has to finish (#2)', () => {
  const sso: DetectResult = { found: false, hasUsername: false, hasSubmit: false, blocker: 'sso' };
  const code: StateResult = { ready: true, passwordVisible: false, success: false, errorText: null, codeVisible: true };

  it('hands a single sign-on, passkey or captcha page to a human after the detect time, typing nothing', async () => {
    for (const blocker of ['sso', 'passkey', 'captcha'] as const) {
      const page = new FakePage([{ ...sso, blocker }], [onForm()]);
      const clock = fakeClock();
      expect(await performLogin(page, profile, timing, clock)).toMatchObject({ status: 'needs_human', reason: blocker, hint: expect.any(String) });
      expect(clock.t).toBeGreaterThanOrEqual(timing.detectTimeoutMs);
      expect(page.typed).toEqual([]);
    }
  });

  it('still fills a form that renders after the blocker signs', async () => {
    const page = new FakePage([sso, sso, FOUND], [onForm(), loggedIn]);
    expect((await performLogin(page, profile, timing, fakeClock())).status).toBe('success');
  });

  it('reports a one-time-code step after the password as mfa_required, not as success', async () => {
    const page = new FakePage([FOUND], [onForm(), code]);
    expect(await performLogin(page, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'mfa_required', hint: expect.stringContaining('one-time code') });
    expect(page.typed).toEqual(['qa', 'pw']);
  });
});

describe('TOTP codes after the password (#1)', () => {
  const totpProfile = buildStore({ APP_URL: 'app.test', APP_USERNAME: 'qa', APP_PASSWORD: 'pw', APP_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })
    .profiles[0] as UsableProfile;
  const codeStep = (errorText: string | null = null): StateResult => ({ ready: true, passwordVisible: false, success: false, errorText, codeVisible: true });
  const expected = (t: number) => totpCode(totpProfile.totp!, t);

  /** A FakePage that also answers the `code` action. */
  class CodePage extends FakePage {
    codeResult: CodeResult = { found: true, hasSubmit: true };
    constructor(detects: DetectResult[], states: StateResult[]) {
      super(detects, states);
      this.elements.add('code');
    }
    override async run<T>(action: InpageAction): Promise<T> {
      if (action !== 'code') return super.run<T>(action);
      this.calls.push('code');
      return this.codeResult as T;
    }
  }

  it('fills the current code from the profile\'s secret, submits it and succeeds', async () => {
    const page = new CodePage([FOUND], [onForm(), codeStep(), gone, gone]);
    expect(await performLogin(page, totpProfile, timing, fakeClock())).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/login' });
    expect(page.typed).toEqual(['qa', 'pw', expected(250)]);
    expect(page.calls.filter((c) => c === 'click:submit')).toHaveLength(2);
    expect(page.calls).toContain('focus:code');
  });

  it('waits for the next code when the current one is about to expire', async () => {
    const page = new CodePage([FOUND], [onForm(), codeStep(), gone, gone]);
    const clock = fakeClock();
    clock.t = 27_500;
    expect((await performLogin(page, totpProfile, timing, clock)).status).toBe('success');
    expect(page.typed[2]).toBe(expected(30_050));
    expect(page.typed[2]).not.toBe(expected(27_750));
  });

  it('reports a code the page rejects as failed, with the code scrubbed from the page\'s message', async () => {
    const code = expected(250);
    const page = new CodePage([FOUND], [onForm(), codeStep(), codeStep(`Code ${code} is not valid`)]);
    const clock = fakeClock();
    expect(await performLogin(page, totpProfile, timing, clock)).toEqual({
      status: 'failed',
      profile: 'app',
      url: 'https://app.test/login',
      reason: 'totp_rejected',
      hint: 'Code [REDACTED] is not valid',
    });
    expect(clock.t).toBe(250 + timing.earlyFailAfterMs);
  });

  it('fails with a hint about the secret and the clock when the code step stays', async () => {
    const page = new CodePage([FOUND], [onForm(), codeStep()]);
    const clock = fakeClock();
    expect(await performLogin(page, totpProfile, timing, clock)).toMatchObject({ status: 'failed', reason: 'totp_rejected', hint: expect.stringContaining('clock') });
    expect(clock.t).toBe(250 + timing.verifyTimeoutMs);
  });

  it('sends one code only: a code step that comes back after the password form is a plain failure', async () => {
    const page = new CodePage([FOUND], [onForm(), codeStep(), onForm()]);
    expect(await performLogin(page, totpProfile, timing, fakeClock())).toMatchObject({ status: 'failed', reason: 'still_on_login_form' });
    expect(page.typed).toHaveLength(3);
  });

  it('hands the step to a person when the code field cannot be tagged, or the profile has no secret', async () => {
    const untagged = new CodePage([FOUND], [onForm(), codeStep()]);
    untagged.codeResult = { found: false, hasSubmit: false };
    expect(await performLogin(untagged, totpProfile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
    expect(untagged.typed).toEqual(['qa', 'pw']);
    const noSecret = new CodePage([FOUND], [onForm(), codeStep()]);
    expect(await performLogin(noSecret, profile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
    expect(noSecret.calls).not.toContain('code');
  });

  it('presses Enter when the code step has no button, and types nothing on another site', async () => {
    const enter = new CodePage([FOUND], [onForm(), codeStep(), gone, gone]);
    enter.codeResult = { found: true, hasSubmit: false };
    enter.submitResult = 'none';
    expect((await performLogin(enter, totpProfile, timing, fakeClock())).status).toBe('success');
    expect(enter.calls).toContain('press:Enter');

    const away = new CodePage([FOUND], [onForm(), codeStep()]);
    away.onSubmit = () => (away.currentUrl = 'https://mfa.other.test/verify');
    expect(await performLogin(away, totpProfile, timing, fakeClock())).toMatchObject({ status: 'needs_human', reason: 'left_profile_site' });
    expect(away.typed).toEqual(['qa', 'pw']);
  });
});

describe('TOTP codes: review fixes (#1 review)', () => {
  const totpProfile = buildStore({ APP_URL: 'app.test', APP_USERNAME: 'qa', APP_PASSWORD: 'pw', APP_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })
    .profiles[0] as UsableProfile;
  const codeStep = (errorText: string | null = null): StateResult => ({ ready: true, passwordVisible: false, success: false, errorText, codeVisible: true });
  const CODE_PAGE: DetectResult = { found: false, hasUsername: false, hasSubmit: false, step: 'code' };

  /** Records each action with its role, and when the code field was tagged. */
  class RecordingPage extends FakePage {
    taggedAt: number | null = null;
    constructor(
      detects: DetectResult[],
      states: StateResult[],
      private readonly clock?: { t: number },
    ) {
      super(detects, states);
      this.elements.add('code');
    }
    override async run<T>(action: InpageAction, arg?: { role?: string }): Promise<T> {
      if (action === 'clear') this.calls.push(`clear:${arg?.role}`);
      if (action !== 'code') return super.run<T>(action);
      this.calls.push('code');
      this.taggedAt = this.clock?.t ?? null;
      return { found: true, hasSubmit: true } as T;
    }
  }

  it('makes the code before it tags the field, so a wait for a fresh code cannot outlast the tag', async () => {
    const clock = fakeClock();
    clock.t = 27_500;
    const page = new RecordingPage([FOUND], [onForm(), codeStep(), gone, gone], clock);
    expect((await performLogin(page, totpProfile, timing, clock)).status).toBe('success');
    expect(page.taggedAt).toBeGreaterThanOrEqual(30_000);
  });

  it('fills only the code on a code page of its own, typing no password', async () => {
    const page = new RecordingPage([CODE_PAGE], [codeStep(), gone, gone]);
    const clock = fakeClock();
    expect(await performLogin(page, totpProfile, timing, clock, 'after_password')).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/login' });
    expect(page.typed).toEqual([totpCode(totpProfile.totp!, 0)]);
  });

  it('hands a code page to a person at once when the profile has no TOTP secret', async () => {
    const page = new RecordingPage([CODE_PAGE], [codeStep()]);
    const clock = fakeClock();
    expect(await performLogin(page, profile, timing, clock, 'after_password')).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
    expect(clock.t).toBe(0);
    expect(page.typed).toEqual([]);
  });

  it('hands a code page to a person when its code field goes away while the code is made', async () => {
    const page = new RecordingPage([CODE_PAGE], [codeStep()]);
    page.run = (async (action: InpageAction) => {
      if (action === 'code') return { found: false, hasSubmit: false };
      return FakePage.prototype.run.call(page, action);
    }) as typeof page.run;
    expect(await performLogin(page, totpProfile, timing, fakeClock(), 'after_password')).toMatchObject({ status: 'needs_human', reason: 'mfa_required' });
    expect(page.typed).toEqual([]);
  });

  it('keeps the code out of the result URL, as a GET form would carry it', async () => {
    const page = new RecordingPage([FOUND], [onForm(), codeStep(), gone, gone]);
    let submits = 0;
    page.onSubmit = () => {
      submits += 1;
      if (submits === 2) page.currentUrl = `https://app.test/verify?otp=${totpCode(totpProfile.totp!, 250)}`;
    };
    expect(await performLogin(page, totpProfile, timing, fakeClock())).toEqual({ status: 'success', profile: 'app', url: 'https://app.test/verify?otp=[REDACTED]' });
  });

  it('clears the code and the password after a rejected code', async () => {
    const page = new RecordingPage([FOUND], [onForm(), codeStep(), codeStep('Wrong code')]);
    expect(await performLogin(page, totpProfile, timing, fakeClock())).toMatchObject({ status: 'failed', reason: 'totp_rejected', hint: 'Wrong code' });
    // typeInto clears a field before typing, so only clears after the code was typed count here.
    const afterCode = page.calls.slice(page.calls.indexOf('focus:code'));
    expect(afterCode).toContain('clear:password');
    expect(afterCode).toContain('clear:code');
  });
});

describe('TOTP codes: only within a login (#1 review 2)', () => {
  const totpProfile = buildStore({ APP_URL: 'app.test', APP_USERNAME: 'qa', APP_PASSWORD: 'pw', APP_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' })
    .profiles[0] as UsableProfile;
  const codeStep: StateResult = { ready: true, passwordVisible: false, success: false, errorText: null, codeVisible: true };
  const CODE_PAGE: DetectResult = { found: false, hasUsername: false, hasSubmit: false, step: 'code' };

  it('leaves a code page alone when no login is in progress, as before TOTP support', async () => {
    const page = new FakePage([CODE_PAGE], [codeStep]);
    const clock = fakeClock();
    expect(await performLogin(page, totpProfile, timing, clock)).toMatchObject({ status: 'no_login_form', hint: 'No visible password field was found on the page.' });
    expect(clock.t).toBe(timing.detectTimeoutMs);
    expect(page.typed).toEqual([]);
    expect(page.calls).not.toContain('code');
    const withSelector = new FakePage([{ ...CODE_PAGE, error: 'The password selector did not match a visible field.' }], [codeStep]);
    expect(await performLogin(withSelector, totpProfile, timing, fakeClock())).toMatchObject({ status: 'no_login_form', hint: expect.stringContaining('password selector') });
  });

  it('reports a code page that comes back after a submitted code as a rejected code, sending no new one', async () => {
    const page = new FakePage([CODE_PAGE], [codeStep]);
    const clock = fakeClock();
    expect(await performLogin(page, totpProfile, timing, clock, 'after_code')).toEqual({
      status: 'failed',
      profile: 'app',
      url: 'https://app.test/login',
      reason: 'totp_rejected',
      hint: expect.stringContaining('No new code was sent'),
    });
    expect(clock.t).toBe(0);
    expect(page.typed).toEqual([]);
  });

  it('fills the code page of a profile with a password selector during a login', async () => {
    const page = new FakePage([{ ...CODE_PAGE, error: 'The password selector did not match a visible field.' }], [codeStep, gone, gone]);
    page.elements.add('code');
    const original = page.run.bind(page);
    page.run = (async <T,>(action: InpageAction) => (action === 'code' ? ({ found: true, hasSubmit: true } as T) : original<T>(action))) as typeof page.run;
    expect((await performLogin(page, totpProfile, timing, fakeClock(), 'after_password')).status).toBe('success');
    expect(page.typed).toHaveLength(1);
  });
});
