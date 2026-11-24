/*
 * This function is serialized and executed inside the browser page.
 * It must stay self-contained: no imports and no references to module scope.
 */

export type InpageAction = 'detect' | 'state' | 'clear' | 'submit' | 'code';
export type FieldRole = 'username' | 'password' | 'code';

export interface InpageSelectors {
  username?: string;
  password?: string;
  submit?: string;
}

export interface InpageArg {
  selectors?: InpageSelectors;
  successSelector?: string;
  role?: FieldRole;
}

export interface DetectResult {
  found: boolean;
  hasUsername: boolean;
  hasSubmit: boolean;
  /**
   * Set when the page asks for the username first and shows the password step only after it
   * (identifier-first login: Google, Microsoft, Okta and other SPA logins).
   * `code`: no password field, but a one-time-code field: the second step of a login whose code page is a page
   * of its own (a server-rendered app that navigated after the password).
   */
  step?: 'identifier' | 'code';
  /**
   * With `step: 'identifier'`: the button says Next or Continue. A Log in / Sign in button may still
   * belong to a one-page form whose password field has not rendered yet, so callers wait longer for it.
   */
  nextButton?: boolean;
  /**
   * No password field and no username step, but the page wants something only a person can do:
   * single sign-on buttons, a passkey prompt or a captcha challenge.
   */
  blocker?: 'sso' | 'passkey' | 'captcha';
  error?: string;
}

export interface StateResult {
  ready: boolean;
  passwordVisible: boolean;
  success: boolean;
  errorText: string | null;
  /** Present (true) when a one-time-code field is visible: a second factor after the password. */
  codeVisible?: true;
}

export type SubmitResult = 'clicked' | 'submitted' | 'none';

/** The `code` action: the one-time-code field after the password, and its button, are tagged (#1). */
export interface CodeResult {
  found: boolean;
  hasSubmit: boolean;
}

export const FIELD_ATTR = 'data-autologin-mcp';

export function autologinInpage(action: InpageAction, arg: InpageArg): DetectResult | StateResult | SubmitResult | CodeResult | boolean {
  const ATTR = 'data-autologin-mcp';
  const SUBMIT_TEXT =
    /^(log ?-?in|sign ?-?in|login|signin|submit|continue|giri[sş]( yap)?|oturum a[cç]|anmelden|connexion|entrar|iniciar sesi[oó]n)$/i;
  // The button that moves an identifier-first page to its password step: Next / Continue, or a
  // Log in / Sign in button (which may also belong to a one-page form still rendering its password field).
  // "Submit" is deliberately absent: a comment or contact form has a username field and a Submit
  // button, and typing a login there is worse than reporting that no login form was found.
  const NEXT_TEXT = /^(continue|next|weiter|suivant|siguiente|continuar|devam( et)?|ileri)$/i;
  const IDENTIFIER_TEXT = /^(log ?-?in|sign ?-?in|login|signin|giri[sş]( yap)?|oturum a[cç]|anmelden|connexion|entrar|iniciar sesi[oó]n)$/i;
  // Field names and ids of login identifiers (Google, Microsoft "loginfmt", Okta "identifier", most in-house forms).
  const LOGIN_FIELD = /^(user(_?name|_?id)?|login(_?(id|name))?|loginfmt|identifier|e-?mail|mail|email_?address|account(_?name)?)$/i;
  // Most specific first. Labels and field wrappers (e.g. MUI's red "Password *" label) are skipped below.
  const ERROR_SELECTORS = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '.invalid-feedback',
    '.error-message',
    '.alert-danger',
    '.error',
    '[class*="error"]',
    '[class*="Error"]',
  ];

  const visible = (el: Element | null): el is HTMLElement => {
    if (el === null || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const usable = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement && visible(el) && !el.disabled && !el.readOnly;
  const find = (selector: string | undefined): Element | null => {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };
  const tagged = (role: string): HTMLElement | null => document.querySelector<HTMLElement>(`[${ATTR}="${role}"]`);
  const precedes = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const text = (el: Element): string => el.textContent!.replace(/\s+/g, ' ').trim();
  /** What a button says: an input's value, or an element's text. */
  const label = (el: Element): string => (el instanceof HTMLInputElement ? el.value.trim() : text(el));
  // A field for a one-time code (an authenticator app, SMS or email code): a second factor.
  // Only clear names: a bare "code" or "securityCode" is as likely a promo code or a card's CVV after login.
  // The last part of a name counts: Devise's user[otp_attempt], django-two-factor's token-otp_token.
  const CODE_FIELD = /(^|[[-])(otp|totp|one[-_]?time[-_]?(code|password)|verification[-_]?code|(otp|totp|mfa|2fa|two[-_]?factor)[-_]?(code|token|attempt))\]?$/i;
  const codeField = (el: Element): el is HTMLInputElement =>
    usable(el) &&
    el.type !== 'password' &&
    ((el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).includes('one-time-code') || [el.name, el.id].some((word) => CODE_FIELD.test(word)));
  // Controls a person types into or picks from. Hidden fields, checkboxes and buttons do not count.
  const NOT_TYPED = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset'];
  const typedControls = (controls: Element[]): number =>
    controls.filter(
      (el) =>
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
        visible(el) &&
        !el.disabled &&
        !(el instanceof HTMLInputElement && NOT_TYPED.includes(el.type)),
    ).length;
  const CODE_BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="image"]';
  // A code field on a page that turns something off or removes it ("Disable two-factor authentication") is a
  // logged-in settings form, not a login step: it never gets a code (#1 review).
  const OFF_TEXT = /\b(disable|deactivate|turn off|switch off|remove|delete|revoke|reset|unlink)\b|devre d[ıi][sş][ıi]|kald[ıi]r|\bsil\b|deaktivieren|ausschalten|d[ée]sactiver|supprimer|desactivar|eliminar/i;
  /**
   * The step a one-time-code field belongs to: the code is the one field to type in its form, or in its small
   * container, and nothing there turns something off. Returns that form or container, or null.
   */
  const codeStepOf = (field: HTMLInputElement): Element | null => {
    // The login's own fields (tagged by detect, still there on a one-form page) and read-only ones do not count.
    const others = (controls: Element[]): number =>
      typedControls(controls.filter((el) => !['username', 'password'].includes(el.getAttribute(ATTR) ?? '') && !(el as HTMLInputElement).readOnly));
    const scopes: Element[] = [];
    if (field.form !== null) {
      if (others(Array.from(field.form.elements)) !== 1) return null;
      scopes.push(field.form);
    } else {
      let node = field.parentElement;
      for (let depth = 0; depth < 2 && node !== null && node !== document.documentElement; depth += 1, node = node.parentElement) {
        if (others(Array.from(node.querySelectorAll('input, textarea, select'))) !== 1) return null;
        scopes.push(node);
      }
    }
    const scope = scopes.at(-1) ?? document.body;
    return Array.from(scope.querySelectorAll(CODE_BUTTONS)).some((el) => visible(el) && OFF_TEXT.test(label(el))) ? null : scope;
  };

  if (action === 'state') {
    const findError = (): string | null => {
      // 1. The message an invalid field points to (aria-errormessage / aria-describedby).
      for (const field of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
        if (!visible(field)) continue;
        const ids = `${field.getAttribute('aria-errormessage') ?? ''} ${field.getAttribute('aria-describedby') ?? ''}`.split(/\s+/);
        for (const id of ids) {
          const message = id === '' ? null : document.getElementById(id);
          if (message !== null && visible(message) && text(message) !== '') return text(message);
        }
      }
      // 2. Alerts and error-looking elements that are not labels or field wrappers.
      for (const selector of ERROR_SELECTORS) {
        const match = Array.from(document.querySelectorAll(selector)).find(
          (el) => visible(el) && text(el) !== '' && el.closest('label, legend') === null && el.querySelector('input, select, textarea') === null,
        );
        if (match) return text(match);
      }
      return null;
    };
    const errorText = findError();
    const codeVisible = Array.from(document.querySelectorAll('input')).some(codeField);
    return {
      ready: document.readyState !== 'loading',
      passwordVisible: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
      success: visible(find(arg.successSelector)),
      errorText: errorText === null ? null : errorText.slice(0, 200),
      ...(codeVisible ? { codeVisible: true as const } : {}),
    };
  }

  if (action === 'clear') {
    const field = tagged(String(arg.role));
    if (!(field instanceof HTMLInputElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (action === 'submit') {
    const button = tagged('submit');
    if (button) {
      button.click();
      return 'clicked';
    }
    const form = ((tagged('code') ?? tagged('password') ?? tagged('username')) as HTMLInputElement | null)?.form;
    if (form) {
      form.requestSubmit();
      return 'submitted';
    }
    return 'none';
  }

  if (action === 'code') {
    // Earlier code and button tags would point at the wrong elements. The password tag stays: a failed code
    // step still clears the password field, also when the page only hid it.
    document.querySelectorAll(`[${ATTR}="code"], [${ATTR}="submit"]`).forEach((el) => el.removeAttribute(ATTR));
    const field = Array.from(document.querySelectorAll('input')).find(codeField);
    if (field === undefined || codeStepOf(field) === null) return { found: false, hasSubmit: false };
    field.setAttribute(ATTR, 'code');
    // The form's own submit button, or a Verify / Continue button after the field in its container:
    // never "Resend code" or "Cancel", and never a button before the field.
    // A form with no such button is submitted as a whole instead (requestSubmit, with no submitter).
    const VERIFY_TEXT =
      /^((verify|confirm|submit|check)( (the )?code)?|continue|next|done|ok|(log|sign) ?-?in|login|signin|do[gğ]rula|onayla|g[oö]nder|devam( et)?|giri[sş]( yap)?|best[aä]tigen|weiter|v[ée]rifier|valider|continuer|verificar|confirmar|continuar)$/i;
    const enabled = (el: Element): boolean => visible(el) && !(el as HTMLButtonElement).disabled;
    let button: Element | null =
      (field.form &&
        Array.from(field.form.querySelectorAll('button, input[type="submit"], input[type="image"]')).find(
          (el) => enabled(el) && (el.tagName !== 'BUTTON' || (el as HTMLButtonElement).type === 'submit') && VERIFY_TEXT.test(label(el)),
        )) ||
      null;
    for (let node = field.parentElement, depth = 0; button === null && node !== null && depth < 4; node = node.parentElement, depth += 1) {
      button =
        Array.from(node.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')).find(
          (el) => enabled(el) && precedes(field, el) && VERIFY_TEXT.test(label(el)),
        ) ?? null;
    }
    button?.setAttribute(ATTR, 'submit');
    return { found: true, hasSubmit: button !== null };
  }

  // detect: find the login form and tag its fields; tags from an earlier step would point at the wrong fields.
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  const selectors = arg.selectors ?? {};
  const notFound = (field: string): DetectResult => ({
    found: false,
    hasUsername: false,
    hasSubmit: false,
    error: `The ${field} selector did not match a visible field.`,
  });
  // A page that asks only for a one-time code (codeStepOf). An email + code form (a passwordless login) is not one.
  // Whether it is a step of a login at all is for the caller to know (#1).
  const codePage = (): boolean => {
    const field = Array.from(document.querySelectorAll('input')).find(codeField);
    return field !== undefined && codeStepOf(field) !== null;
  };

  let password: HTMLInputElement;
  if (selectors.password) {
    const el = find(selectors.password);
    if (!usable(el)) return codePage() ? { ...notFound('password'), step: 'code' } : notFound('password');
    password = el;
  } else {
    const el = Array.from(document.querySelectorAll('input[type="password"]')).find(usable);
    if (!el) {
      // Identifier-first login: a username step before the password one. Only the heuristic path
      // does this: an explicit password selector means the caller expects that field to exist.
      const textLike = (el: Element | null): el is HTMLInputElement => usable(el) && ['text', 'email', 'tel'].includes(el.type);
      // A login identifier says so: autocomplete="username", or a name / id that is exactly a login word.
      // `type="email"` alone is not enough: invite, share and newsletter fields are email fields too.
      const loginField = (el: HTMLInputElement): boolean =>
        (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).includes('username') ||
        [el.name, el.id].some((word) => LOGIN_FIELD.test(word));
      const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"]';
      // A button after the field that means "continue", and not, say, "Subscribe" or "Invite".
      const continueButton = (buttons: Element[], field: HTMLInputElement): Element | null =>
        buttons.find(
          (el) => visible(el) && !(el as HTMLButtonElement).disabled && precedes(field, el) && (NEXT_TEXT.test(label(el)) || IDENTIFIER_TEXT.test(label(el))),
        ) ?? null;
      // A username step is a form, or a small container, whose only typed field is the username: not a signup,
      // checkout or invite form with more fields, and never a button far away (a header "Sign in" next to a
      // footer newsletter field).
      const buttonFor = (field: HTMLInputElement): Element | null => {
        if (selectors.submit) return find(selectors.submit);
        const form = field.form;
        if (form !== null) {
          // form.elements also holds controls outside the element that point at it with form="…".
          if (typedControls(Array.from(form.elements)) !== 1) return null;
          return continueButton([...Array.from(form.querySelectorAll(BUTTONS)), ...Array.from(form.elements)], field);
        }
        let node = field.parentElement;
        for (let depth = 0; depth < 3 && node !== null && node !== document.documentElement; depth += 1, node = node.parentElement) {
          if (typedControls(Array.from(node.querySelectorAll('input, textarea, select'))) !== 1) return null;
          const button = continueButton(Array.from(node.querySelectorAll(BUTTONS)), field);
          if (button !== null) return button;
        }
        return null;
      };
      const candidates = selectors.username
        ? [find(selectors.username)].filter(textLike)
        : Array.from(document.querySelectorAll('input')).filter((el) => textLike(el) && loginField(el));
      for (const field of candidates) {
        const button = buttonFor(field);
        if (!visible(button)) continue;
        field.setAttribute(ATTR, 'username');
        button.setAttribute(ATTR, 'submit');
        return { found: false, hasUsername: true, hasSubmit: true, step: 'identifier', nextButton: NEXT_TEXT.test(label(button)) };
      }
      // No form to fill. Does the page want something only a person can do? Only checked here, without a
      // password field or a username step: SSO buttons, passkeys and invisible captchas sit on many normal
      // login pages and block nothing there.
      const CAPTCHA_FRAME = /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/i;
      const SSO_TEXT =
        /^((sign|log) ?in|login|continue|sign up) (with|using|via) (google|microsoft|apple|github|gitlab|okta|azure( ad)?|facebook|linkedin|slack|saml|sso|single sign-on|your (company|organi[sz]ation)( account)?)$|^(single sign-on|sso|use sso|enterprise sso)$|^(google|microsoft|apple|github|sso) ile (giri[sş] yap|oturum a[cç]|devam et)$/i;
      // Sign-in actions only: "Add a passkey" in a logged-in app's settings is not a login.
      const PASSKEY_TEXT =
        /^((sign|log) ?in|login|continue) with (a |your )?(passkey|security key|face id|touch id|windows hello)$|^use (a |your )?(passkey|security key|face id|touch id|windows hello)$|^(ge[cç]i[sş] anahtar[ıi]|passkey) ile (giri[sş] yap|oturum a[cç])$/i;
      // A page that also offers email, a username or a password still leads to a form: open it and log in again.
      const FORM_PATH = /^((sign|log) ?in|login|continue|sign up) with (email|e-mail|username|(a |your )?password)$|^use (a |your )?(password|email|username)( instead)?$|^(e-?posta|şifre|parola) ile/i;
      const captcha =
        Array.from(document.querySelectorAll('iframe')).some((frame) => visible(frame) && CAPTCHA_FRAME.test(frame.src) && !/[?&]size=invisible/.test(frame.src)) ||
        visible(document.querySelector('#challenge-form, #challenge-stage, #cf-challenge-running'));
      const actions = Array.from(document.querySelectorAll(`${BUTTONS}, a`)).filter(visible).map(label);
      const formPath = actions.some((t) => FORM_PATH.test(t));
      const blocker = captcha
        ? 'captcha'
        : formPath
          ? null
          : actions.some((t) => SSO_TEXT.test(t))
            ? 'sso'
            : actions.some((t) => PASSKEY_TEXT.test(t))
              ? 'passkey'
              : null;
      if (blocker !== null) return { found: false, hasUsername: false, hasSubmit: false, blocker };
      return codePage() ? { found: false, hasUsername: false, hasSubmit: false, step: 'code' } : { found: false, hasUsername: false, hasSubmit: false };
    }
    password = el as HTMLInputElement;
  }

  let username: Element | null = null;
  if (selectors.username) {
    username = find(selectors.username);
    if (!usable(username)) return notFound('username');
  } else {
    const score = (el: HTMLInputElement): number => {
      const auto = (el.getAttribute('autocomplete') ?? '').toLowerCase();
      if (/username|email/.test(auto)) return 3;
      if (el.type === 'email') return 2;
      if (/user|e-?mail|login|account/i.test(`${el.name} ${el.id}`)) return 1;
      return 0;
    };
    const scope: ParentNode = password.form ?? document;
    const candidates = Array.from(scope.querySelectorAll('input')).filter(
      (el) => ['text', 'email', 'tel'].includes(el.type) && usable(el) && precedes(el, password),
    );
    let best: HTMLInputElement | null = null;
    for (const el of candidates) if (best === null || score(el) >= score(best)) best = el;
    username = best;
  }

  let submit: Element | null = null;
  if (selectors.submit) {
    submit = find(selectors.submit);
    if (!visible(submit)) return notFound('submit');
  } else {
    const inForm = password.form
      ? Array.from(password.form.querySelectorAll('button, input[type="submit"], input[type="image"]')).filter(
          (el) => visible(el) && !(el as HTMLButtonElement).disabled && (el.tagName !== 'BUTTON' || (el as HTMLButtonElement).type === 'submit'),
        )
      : [];
    submit = inForm[0] ?? null;
    if (submit === null) {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')).filter(
        (el) => visible(el) && SUBMIT_TEXT.test(el instanceof HTMLInputElement ? el.value.trim() : text(el)),
      );
      submit = buttons.find((el) => precedes(password, el)) ?? buttons[0] ?? null;
    }
  }

  username?.setAttribute(ATTR, 'username');
  password.setAttribute(ATTR, 'password');
  submit?.setAttribute(ATTR, 'submit');
  return { found: true, hasUsername: username !== null, hasSubmit: submit !== null };
}
