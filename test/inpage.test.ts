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
    expect(detect()).toEqual({ found: false, hasUsername: true, hasSubmit: true, step: 'identifier' });
    expect(roleOf('#email')).toBe('username');
    expect(roleOf('#next')).toBe('submit');
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
