import { describe, expect, it } from 'vitest';
import { alreadyLoggedInHint, RECENT_MS, ResultLog, USERNAME_STEP_NAVIGATED } from '../src/results.ts';
import { CODE_STEP_MS, CODE_SUBMITTED } from '../src/results.ts';

describe('ResultLog', () => {
  it('keeps the latest result per profile', () => {
    let now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const log = new ResultLog(() => now);
    log.record('app', { status: 'failed', hint: 'Wrong password', url: 'http://localhost:3000/login' }, 'bridge');
    now += 1_000;
    log.record('app', { status: 'success' }, 'cdp');
    log.record('other', { status: 'submitted', url: 'https://x.test/' }, 'bridge');
    expect(log.get('APP')).toEqual([{ profile: 'app', status: 'success', via: 'cdp', at: '2026-11-22T12:00:01.000Z' }]);
    expect(log.get().map((r) => r.profile)).toEqual(['app', 'other']);
    expect(log.get('none')).toEqual([]);
    expect(new ResultLog().get()).toEqual([]);
  });
});

describe('ResultLog no_login_form context', () => {
  const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

  it('keeps the reason, and does not take a username step alone for a login that went through', () => {
    const log = new ResultLog(() => T0);
    log.record('app', { status: 'failed', reason: 'still_on_login_form' }, 'cdp');
    expect(log.get('app')).toEqual([expect.objectContaining({ status: 'failed', reason: 'still_on_login_form' })]);
    log.record('app', { status: 'submitted', reason: USERNAME_STEP_NAVIGATED, url: 'http://localhost:3000/verify' }, 'bridge');
    // No "already logged in" hint: only the username was sent.
    expect(log.noFormContext('app')).toEqual({
      previous_login: { status: 'submitted', reason: USERNAME_STEP_NAVIGATED, at: '2026-11-22T12:00:00.000Z', url: 'http://localhost:3000/verify' },
    });
    log.record('app', { status: 'submitted', url: 'http://localhost:3000/home' }, 'bridge');
    expect(log.noFormContext('app')).toMatchObject({ hint: expect.stringContaining('already logged in') });
  });

  it('tells an agent that logs in again that its previous login went through', () => {
    let now = T0;
    const log = new ResultLog(() => now);
    expect(log.noFormContext('app')).toBeNull();
    expect(log.record('app', { status: 'no_login_form', hint: 'No visible password field was found on the page.' }, 'bridge')).not.toHaveProperty('previous_login');

    log.record('app', { status: 'success', url: 'http://localhost:3000/dashboard' }, 'bridge');
    now += 20_000;
    const previous = { status: 'success', at: '2026-11-22T12:00:00.000Z', url: 'http://localhost:3000/dashboard' };
    expect(log.noFormContext('app')).toEqual({ previous_login: previous, hint: alreadyLoggedInHint(previous) });
    expect(alreadyLoggedInHint(previous)).toContain('already logged in');

    const entry = log.record('app', { status: 'no_login_form', hint: 'No visible password field was found on the page.', url: 'http://localhost:3000/dashboard' }, 'bridge');
    expect(entry).toEqual({
      profile: 'app',
      status: 'no_login_form',
      hint: alreadyLoggedInHint(previous),
      url: 'http://localhost:3000/dashboard',
      previous_login: previous,
      via: 'bridge',
      at: '2026-11-22T12:00:20.000Z',
    });
    expect(log.get('app')).toEqual([entry]);

    // A second retry still points at the real login, not at the first no_login_form.
    now += 20_000;
    expect(log.record('app', { status: 'no_login_form' }, 'cdp').previous_login).toEqual(previous);
  });

  it('keeps the page hint when the previous login did not go through, and forgets old logins', () => {
    let now = T0;
    const log = new ResultLog(() => now);
    log.record('app', { status: 'failed', hint: 'Invalid credentials' }, 'cdp');
    expect(log.record('app', { status: 'no_login_form', hint: 'No form' }, 'cdp')).toMatchObject({
      hint: 'No form',
      previous_login: { status: 'failed', at: '2026-11-22T12:00:00.000Z' },
    });

    log.record('app', { status: 'submitted' }, 'bridge');
    now += RECENT_MS + 1;
    expect(log.noFormContext('app')).toBeNull();
    expect(log.record('app', { status: 'no_login_form', hint: 'No form' }, 'bridge')).toMatchObject({ hint: 'No form' });
    expect(log.get('app')[0]).not.toHaveProperty('previous_login');
  });
});

describe('ResultLog code steps (#1 review)', () => {
  it('expects a code page only right after a password step that navigated', () => {
    let now = Date.UTC(2026, 10, 24, 12, 0, 0);
    const log = new ResultLog(() => now);
    expect(log.codeStep('app')).toBeNull();
    log.record('app', { status: 'submitted' }, 'bridge');
    expect(log.codeStep('app')).toBe('after_password');
    now += CODE_STEP_MS + 1;
    expect(log.codeStep('app')).toBeNull();
  });

  it('takes a code page after a code that navigated for a rejected code', () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);
    const log = new ResultLog(() => now);
    log.record('app', { status: 'submitted', reason: CODE_SUBMITTED }, 'bridge');
    expect(log.codeStep('app')).toBe('after_code');
  });

  it('expects no code page after anything else: a logged-in page with a code field is left alone', () => {
    const log = new ResultLog(() => Date.UTC(2026, 10, 24, 12, 0, 0));
    for (const result of [{ status: 'success' }, { status: 'failed', reason: 'totp_rejected' }, { status: 'submitted', reason: USERNAME_STEP_NAVIGATED }, { status: 'needs_human', reason: 'mfa_required' }]) {
      log.record('app', result, 'bridge');
      expect(log.codeStep('app')).toBeNull();
    }
  });
});

describe('ResultLog code steps: through no_login_form (#1 review 3)', () => {
  it('keeps the context when a no_login_form came in between', () => {
    const log = new ResultLog(() => Date.UTC(2026, 10, 24, 12, 0, 0));
    log.record('app', { status: 'submitted' }, 'bridge');
    log.record('app', { status: 'no_login_form' }, 'bridge');
    expect(log.codeStep('app')).toBe('after_password');
  });
});
