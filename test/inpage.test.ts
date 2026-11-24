// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autologinInpage, FIELD_ATTR, type DetectResult, type StateResult } from '../src/inpage.ts';

// jsdom has no layout engine: give every element a size unless it (or an ancestor) is display:none or data-zero.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    let size = 20;
    for (let el: Element | null = this; el; el = el.parentElement) {
      if ((el as HTMLElement).style.display === 'none' || el.hasAttribute('data-zero')) size = 0;
    }
    return { width: size, height: size } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const detect = (arg = {}) => autologinInpage('detect', arg) as DetectResult;
const state = (arg = {}) => autologinInpage('state', arg) as StateResult;
const roleOf = (selector: string) => document.querySelector(selector)?.getAttribute(FIELD_ATTR) ?? null;

describe('detect', () => {
  it('finds a classic form and tags its fields', () => {
    document.body.innerHTML = `
      <input id="search" type="search">
      <form>
        <input id="email" type="email">
        <input id="pw" type="password">
        <button id="show" type="button">Show</button>
        <button id="go">Sign in</button>
      </form>`;
    expect(detect()).toEqual({ found: true, hasUsername: true, hasSubmit: true });
    expect(roleOf('#email')).toBe('username');
    expect(roleOf('#pw')).toBe('password');
    expect(roleOf('#go')).toBe('submit');
    expect(roleOf('#show')).toBeNull();
  });

  it('finds an identifier-first step and tags its field and continue button', () => {
    document.body.innerHTML = `<form><input id="email" type="email" name="email"><button id="next">Next</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: true, hasSubmit: true, step: 'identifier', nextButton: true });
    expect(roleOf('#email')).toBe('username');
    expect(roleOf('#next')).toBe('submit');
  });

  it('does not take an identifier step when an explicit username selector matches nothing usable', () => {
    document.body.innerHTML = `<form><input id="email" type="email"><button>Next</button></form>`;
    expect(detect({ selectors: { username: '#missing' } })).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('tells a Next / Continue button from a Log in button on an identifier step', () => {
    document.body.innerHTML = `<form><input type="email" autocomplete="username"><input type="submit" value="Devam et"></form>`;
    expect(detect()).toMatchObject({ step: 'identifier', nextButton: true });
    document.body.innerHTML = `<form><input type="text" name="loginfmt"><button>Log in</button></form>`;
    expect(detect()).toMatchObject({ step: 'identifier', nextButton: false });
  });

  it('only takes fields that say they are a login identifier', () => {
    // An invite form on a logged-in page: an email field and a Next button, but not a login.
    document.body.innerHTML = `<form><input type="email" name="invite_email"><button>Next</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    document.body.innerHTML = `<form><input type="email" placeholder="Email"><button>Next</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    document.body.innerHTML = `<form><input id="identifier" type="text"><button>Next</button></form>`;
    expect(detect()).toMatchObject({ step: 'identifier' });
  });

  it('pairs the field with its own button: a form-less newsletter field never borrows the login button', () => {
    document.body.innerHTML = `
      <div><input id="news" type="email" name="email"><button>Subscribe</button></div>
      <form><input id="login" name="username" autocomplete="username"><button id="next">Next</button></form>`;
    expect(detect()).toMatchObject({ step: 'identifier', hasUsername: true });
    expect(roleOf('#news')).toBeNull();
    expect(roleOf('#login')).toBe('username');
    expect(roleOf('#next')).toBe('submit');
    // A form-less field still pairs with a button in its own container.
    document.body.innerHTML = `<main><div id="step"><input id="who" name="email"><div role="button" id="go">Continue</div></div></main>`;
    expect(detect()).toMatchObject({ step: 'identifier', nextButton: true });
    expect(roleOf('#who')).toBe('username');
    // A lone form-less field with no button anywhere is not a username step.
    document.body.innerHTML = `<main><div><input name="email"></div></main>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('takes only a form or container whose one text field is the username', () => {
    // A signup or checkout step: an email field among other fields, with Continue.
    document.body.innerHTML = `<form><input name="fullname"><input type="email" name="email"><input name="company"><button>Continue</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    document.body.innerHTML = `<form><input type="email" name="email"><select name="plan"><option>Pro</option></select><button>Next</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    // Checkboxes and hidden fields do not count.
    document.body.innerHTML = `<form><input type="hidden" name="csrf" value="x"><input type="email" name="email"><input type="checkbox" name="remember"><button>Next</button></form>`;
    expect(detect()).toMatchObject({ step: 'identifier' });
  });

  it('never pairs a field with a button that comes before it or far above it', () => {
    // A footer newsletter field and a header Sign in button.
    document.body.innerHTML = `<header><button>Sign in</button></header><main><p>News</p></main><footer><div><input type="email" name="email"></div></footer>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    document.body.innerHTML = `<div><div><div><div><input name="username"></div></div></div><button>Next</button></div>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('pairs a field with a button of its form that sits outside the form element', () => {
    document.body.innerHTML = `<form id="f"><input name="username" id="u"></form><footer><button form="f" id="go">Next</button></footer>`;
    expect(detect()).toMatchObject({ step: 'identifier', nextButton: true });
    expect(roleOf('#u')).toBe('username');
    expect(roleOf('#go')).toBe('submit');
  });

  it('does not mistake a newsletter form for an identifier-first login', () => {
    document.body.innerHTML = `<form><input type="email" name="email"><button type="submit">Subscribe</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('does not treat a comment form with a Submit button as an identifier-first login', () => {
    document.body.innerHTML = `<form><input id="nick" name="username" type="text"><button type="submit">Submit</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('honours explicit selectors on the identifier step and stays strict about a missing password selector', () => {
    document.body.innerHTML = `<input id="who" type="text"><a id="go">Continue</a>`;
    expect(detect({ selectors: { username: '#who', submit: '#go' } })).toMatchObject({ step: 'identifier', hasUsername: true, hasSubmit: true });
    expect(roleOf('#who')).toBe('username');
    expect(roleOf('#go')).toBe('submit');
    expect(detect({ selectors: { password: '#pw' } })).toMatchObject({ found: false, error: 'The password selector did not match a visible field.' });
  });

  it('reports no form when the identifier field or its button is not visible', () => {
    document.body.innerHTML = `<form><input type="email" data-zero><button>Next</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    document.body.innerHTML = `<form><input type="email"><button data-zero>Next</button></form>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('reports pages without a usable password field', () => {
    document.body.innerHTML = `
      <input type="password" style="display:none">
      <input type="password" disabled>
      <input type="password" readonly>
      <input type="password" data-zero>
      <input type="password" style="visibility:hidden">`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('skips hidden decoys and uses the visible password field', () => {
    document.body.innerHTML = `<form style="display:none"><input type="password" id="decoy"></form><form><input type="password" id="real"></form>`;
    expect(detect()).toMatchObject({ found: true, hasUsername: false, hasSubmit: false });
    expect(roleOf('#real')).toBe('password');
    expect(roleOf('#decoy')).toBeNull();
  });

  it('scores username candidates: autocomplete > email > name/id > nearest', () => {
    const page = (inputs: string) => {
      document.body.innerHTML = `<form>${inputs}<input type="password" id="pw"><input id="after" type="text"></form>`;
      detect();
      return document.querySelector(`[${FIELD_ATTR}="username"]`)?.id;
    };
    expect(page('<input id="a" autocomplete="username"><input id="b" type="email"><input id="c">')).toBe('a');
    expect(page('<input id="a" name="userName"><input id="b" type="email"><input id="c">')).toBe('b');
    expect(page('<input id="login-id"><input id="c">')).toBe('login-id');
    expect(page('<input id="first"><input id="second" type="tel">')).toBe('second');
    expect(page('<input id="a" type="checkbox">')).toBeUndefined();
  });

  it('works without a <form> and prefers a matching button after the password', () => {
    document.body.innerHTML = `
      <div role="button" id="early">Log in</div>
      <input id="user" type="text">
      <input id="pw" type="password">
      <a id="link" href="#">Giriş Yap</a>
      <input id="btn" type="button" value=" Sign in ">`;
    expect(detect()).toEqual({ found: true, hasUsername: true, hasSubmit: true });
    expect(roleOf('#link')).toBe('submit');
  });

  it('falls back to a matching button before the password, or none', () => {
    document.body.innerHTML = `<input id="btn" type="submit" value="Login"><input type="password">`;
    detect();
    expect(roleOf('#btn')).toBe('submit');
    document.body.innerHTML = `<input type="password"><button>Sign in with Google</button><button disabled>x</button>`;
    expect(detect().hasSubmit).toBe(false);
  });

  it('looks outside the form when the form has no submit button', () => {
    document.body.innerHTML = `<form><input type="password"><button type="button">Eye</button><button disabled>Go</button></form><button id="out">Continue</button>`;
    detect();
    expect(roleOf('#out')).toBe('submit');
  });

  it('uses explicit selectors and reports the ones that do not match', () => {
    document.body.innerHTML = `<input id="p" type="password"><input id="u" type="text"><span id="s">→</span><span id="hidden" style="display:none">x</span>`;
    expect(detect({ selectors: { username: '#u', password: '#p', submit: '#s' } })).toEqual({ found: true, hasUsername: true, hasSubmit: true });
    expect(roleOf('#u')).toBe('username');
    expect(detect({ selectors: { password: '#missing' } })).toMatchObject({ found: false, error: expect.stringContaining('password selector') });
    expect(detect({ selectors: { password: '###' } })).toMatchObject({ found: false, error: expect.stringContaining('password selector') });
    expect(detect({ selectors: { username: '#s' } })).toMatchObject({ found: false, error: expect.stringContaining('username selector') });
    expect(detect({ selectors: { submit: '#hidden' } })).toMatchObject({ found: false, error: expect.stringContaining('submit selector') });
  });

  it('removes tags from a previous detection', () => {
    document.body.innerHTML = `<span id="old" ${FIELD_ATTR}="password"></span><input id="pw" type="password">`;
    detect();
    expect(roleOf('#old')).toBeNull();
    expect(roleOf('#pw')).toBe('password');
  });
});

describe('state', () => {
  it('reports password visibility, success selector and visible error text', () => {
    document.body.innerHTML = `
      <p class="error"> </p>
      <p class="error" style="display:none">Hidden error</p>
      <div role="alert">  Invalid
        password  </div>
      <input type="password">
      <nav id="menu">Me</nav>`;
    expect(state({ successSelector: '#menu' })).toEqual({ ready: true, passwordVisible: true, success: true, errorText: 'Invalid password' });
    expect(state({ successSelector: '#nope' }).success).toBe(false);
    expect(state().success).toBe(false);
  });

  it('prefers the message an invalid field points to over red labels (MUI)', () => {
    document.body.innerHTML = `
      <label class="MuiInputLabel-root Mui-error">Password *</label>
      <div class="MuiInputBase-root Mui-error">
        <input id="pw" type="password" aria-invalid="true" aria-describedby="missing  pw-empty pw-hidden pw-helper">
        <fieldset><legend><span class="error">Password *</span></legend></fieldset>
      </div>
      <p id="pw-empty"> </p>
      <p id="pw-hidden" style="display:none">hidden</p>
      <p id="pw-helper" class="MuiFormHelperText-root Mui-error">Password must be at least 8 characters</p>`;
    expect(state().errorText).toBe('Password must be at least 8 characters');
  });

  it('uses aria-errormessage, skips hidden invalid fields, and falls back to error elements that are not labels', () => {
    document.body.innerHTML = `
      <input type="text" aria-invalid="true" aria-errormessage="e1" style="display:none"><p id="e1">hidden field</p>
      <input type="email" aria-invalid="true" aria-errormessage="e2"><p id="e2">Enter a valid e-mail</p>`;
    expect(state().errorText).toBe('Enter a valid e-mail');
    document.body.innerHTML = `
      <label class="Mui-error">Password *</label>
      <div class="Mui-error"><input type="password" aria-invalid="true"></div>
      <legend><span class="error">Password *</span></legend>
      <p class="MuiFormHelperText-root Mui-error">Too short</p>`;
    expect(state().errorText).toBe('Too short');
  });

  it('truncates long errors and handles pages without errors or passwords', () => {
    document.body.innerHTML = `<div class="alert-danger">${'x'.repeat(300)}</div>`;
    expect(state().errorText).toHaveLength(200);
    document.body.innerHTML = '<main>Dashboard</main>';
    expect(state()).toEqual({ ready: true, passwordVisible: false, success: false, errorText: null });
  });
});

describe('clear', () => {
  it('empties a tagged input and fires input/change events', () => {
    document.body.innerHTML = `<input id="pw" type="password" ${FIELD_ATTR}="password" value="typed">`;
    const field = document.querySelector<HTMLInputElement>('#pw')!;
    const events: string[] = [];
    field.addEventListener('input', () => events.push('input'));
    field.addEventListener('change', () => events.push('change'));
    expect(autologinInpage('clear', { role: 'password' })).toBe(true);
    expect(field.value).toBe('');
    expect(events).toEqual(['input', 'change']);
  });

  it('returns false when the tagged element is missing or not an input', () => {
    document.body.innerHTML = `<div ${FIELD_ATTR}="username"></div>`;
    expect(autologinInpage('clear', { role: 'username' })).toBe(false);
    expect(autologinInpage('clear', { role: 'password' })).toBe(false);
  });
});

describe('submit', () => {
  it('clicks the tagged submit element', () => {
    document.body.innerHTML = `<button ${FIELD_ATTR}="submit">Go</button>`;
    const click = vi.fn();
    document.querySelector('button')!.addEventListener('click', click);
    expect(autologinInpage('submit', {})).toBe('clicked');
    expect(click).toHaveBeenCalledOnce();
  });

  it('submits the username form of an identifier-first page', () => {
    document.body.innerHTML = `<form><input type="email" ${FIELD_ATTR}="username"></form>`;
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);
    expect(autologinInpage('submit', {})).toBe('submitted');
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('submits the password form, or reports that nothing could be submitted', () => {
    document.body.innerHTML = `<form><input type="password" ${FIELD_ATTR}="password"></form>`;
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);
    expect(autologinInpage('submit', {})).toBe('submitted');
    expect(onSubmit).toHaveBeenCalledOnce();
    document.body.innerHTML = `<input type="password" ${FIELD_ATTR}="password">`;
    expect(autologinInpage('submit', {})).toBe('none');
    document.body.innerHTML = '';
    expect(autologinInpage('submit', {})).toBe('none');
  });
});

describe('pages a person has to finish (#2)', () => {
  it('reports single sign-on, passkey and captcha pages that have no password field', () => {
    document.body.innerHTML = `<main><h1>Welcome back</h1><button>Sign in with Google</button><a href="#">Continue with Microsoft</a></main>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false, blocker: 'sso' });
    document.body.innerHTML = `<main><a href="/sso">Sign in with SSO</a></main>`;
    expect(detect()).toMatchObject({ blocker: 'sso' });
    document.body.innerHTML = `<main><button>Sign in with a passkey</button></main>`;
    expect(detect()).toMatchObject({ blocker: 'passkey' });
    document.body.innerHTML = `<main><button>Use a security key</button></main>`;
    expect(detect()).toMatchObject({ blocker: 'passkey' });
    document.body.innerHTML = `<main><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"></iframe></main>`;
    expect(detect()).toMatchObject({ blocker: 'captcha' });
    document.body.innerHTML = `<main><iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox"></iframe></main>`;
    expect(detect()).toMatchObject({ blocker: 'captcha' });
    document.body.innerHTML = `<div id="challenge-form"><p>Checking your browser</p></div>`;
    expect(detect()).toMatchObject({ blocker: 'captcha' });
  });

  it('ignores those signs when the page has a form to fill, or when they are hidden or invisible', () => {
    document.body.innerHTML = `
      <form><input type="email" name="email"><input type="password"><button>Sign in</button></form>
      <button>Sign in with Google</button><button>Sign in with a passkey</button>
      <iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"></iframe>`;
    expect(detect()).toEqual({ found: true, hasUsername: true, hasSubmit: true });
    document.body.innerHTML = `<form><input name="username"><button>Next</button></form><button>Sign in with Google</button>`;
    expect(detect()).toEqual({ found: false, hasUsername: true, hasSubmit: true, step: 'identifier', nextButton: true });
    document.body.innerHTML = `<p>Dashboard</p><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible"></iframe>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    document.body.innerHTML = `<p>Dashboard</p><button style="display:none">Sign in with Google</button><p>Read more about Google sign-in</p>`;
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('reports a one-time-code field in the state', () => {
    for (const markup of ['<input autocomplete="one-time-code">', '<input name="otp">', '<input id="verification_code">', '<input name="totp">']) {
      document.body.innerHTML = markup;
      expect(state()).toEqual({ ready: true, passwordVisible: false, success: false, errorText: null, codeVisible: true });
    }
    for (const markup of ['<input name="promo_code">', '<input name="zipcode">', '<input autocomplete="one-time-code" style="display:none">']) {
      document.body.innerHTML = markup;
      expect(state()).toEqual({ ready: true, passwordVisible: false, success: false, errorText: null });
    }
  });
});

describe('code: the one-time-code step after the password (#1)', () => {
  const code = () => autologinInpage('code', {});

  it('tags the code field and the submit button of its form', () => {
    document.body.innerHTML = `<form><input name="otp" inputmode="numeric"><button type="button">Resend code</button><button type="submit">Verify</button></form>`;
    expect(code()).toEqual({ found: true, hasSubmit: true });
    expect(roleOf('input')).toBe('code');
    expect(document.querySelector(`[${FIELD_ATTR}="submit"]`)!.textContent).toBe('Verify');
  });

  it('finds the Verify button next to a field outside any form, and never one before the field', () => {
    document.body.innerHTML = `<div id="step"><button>Continue</button><label>Code from your authenticator app <input id="otp" autocomplete="one-time-code"></label><button>Cancel</button><button>Verify</button></div>`;
    expect(code()).toEqual({ found: true, hasSubmit: true });
    expect(document.querySelector(`[${FIELD_ATTR}="submit"]`)!.textContent).toBe('Verify');
  });

  it('reports a code field without a button, and submits its form instead', () => {
    document.body.innerHTML = `<form><input name="totp"></form>`;
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);
    expect(code()).toEqual({ found: true, hasSubmit: false });
    expect(autologinInpage('submit', {})).toBe('submitted');
    expect(onSubmit).toHaveBeenCalledOnce();
    document.body.innerHTML = `<input autocomplete="one-time-code"><a href="/help">Help</a>`;
    expect(code()).toEqual({ found: true, hasSubmit: false });
    expect(autologinInpage('submit', {})).toBe('none');
  });

  it('finds nothing without a clear one-time-code field, and drops tags from earlier steps', () => {
    document.body.innerHTML = `<input name="promo_code" ${FIELD_ATTR}="password"><input autocomplete="one-time-code" style="display:none"><button>Verify</button>`;
    expect(code()).toEqual({ found: false, hasSubmit: false });
    expect(document.querySelectorAll(`[${FIELD_ATTR}]`)).toHaveLength(0);
  });

  it('clears the code field like the others', () => {
    document.body.innerHTML = `<input name="otp" value="123456">`;
    code();
    expect(autologinInpage('clear', { role: 'code' })).toBe(true);
    expect(document.querySelector('input')!.value).toBe('');
  });
});

describe('pages a person has to finish: no false alarms (#2 review)', () => {
  it('does not take a passkey settings link on a logged-in page for a passkey login', () => {
    for (const markup of ['<nav><a href="/settings">Security: add a passkey</a></nav><p>Dashboard</p>', '<p>Welcome</p><button>Create a passkey</button>']) {
      document.body.innerHTML = markup;
      expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    }
    document.body.innerHTML = '<main><button>Use a passkey</button></main>';
    expect(detect()).toMatchObject({ blocker: 'passkey' });
  });

  it('does not take a sign-in chooser that also offers email or a password for single sign-on', () => {
    for (const other of ['Continue with email', 'Sign in with email', 'Use a password', 'Log in with username']) {
      document.body.innerHTML = `<main><button>Continue with Google</button><button>${other}</button></main>`;
      expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
    }
    document.body.innerHTML = '<main><button>Use a passkey</button><a href="#">Use your password instead</a></main>';
    expect(detect()).toEqual({ found: false, hasUsername: false, hasSubmit: false });
  });

  it('only takes clear one-time-code fields for a second factor', () => {
    for (const markup of ['<input name="code">', '<input id="securityCode">', '<input name="promo_code">', '<input name="security_code">']) {
      document.body.innerHTML = markup;
      expect(state()).toEqual({ ready: true, passwordVisible: false, success: false, errorText: null });
    }
    for (const markup of ['<input name="otp">', '<input id="totp_code">', '<input name="mfaCode">', '<input name="one_time_code">', '<input autocomplete="one-time-code" name="c">', '<input name="user[otp_attempt]">', '<input name="token-otp_token">']) {
      document.body.innerHTML = markup;
      expect(state()).toMatchObject({ codeVisible: true });
    }
  });
});
