/*
 * This function is serialized and executed inside the browser page.
 * It must stay self-contained: no imports and no references to module scope.
 */

export type InpageAction = 'detect' | 'state' | 'clear' | 'submit';
export type FieldRole = 'username' | 'password';

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
   */
  step?: 'identifier';
  error?: string;
}

export interface StateResult {
  ready: boolean;
  passwordVisible: boolean;
  success: boolean;
  errorText: string | null;
}

export type SubmitResult = 'clicked' | 'submitted' | 'none';

export const FIELD_ATTR = 'data-autologin-mcp';

export function autologinInpage(action: InpageAction, arg: InpageArg): DetectResult | StateResult | SubmitResult | boolean {
  const ATTR = 'data-autologin-mcp';
  const SUBMIT_TEXT =
    /^(log ?-?in|sign ?-?in|login|signin|submit|continue|giri[sş]( yap)?|oturum a[cç]|anmelden|connexion|entrar|iniciar sesi[oó]n)$/i;
  // The button that moves an identifier-first page to its password step.
  // "Submit" is deliberately absent: a comment or contact form has a username field and a Submit
  // button, and typing a login there is worse than reporting that no login form was found.
  const IDENTIFIER_TEXT =
    /^(log ?-?in|sign ?-?in|login|signin|continue|next|giri[sş]( yap)?|oturum a[cç]|anmelden|weiter|connexion|suivant|entrar|siguiente|iniciar sesi[oó]n)$/i;
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
    return {
      ready: document.readyState !== 'loading',
      passwordVisible: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
      success: visible(find(arg.successSelector)),
      errorText: errorText === null ? null : errorText.slice(0, 200),
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
    const form = ((tagged('password') ?? tagged('username')) as HTMLInputElement | null)?.form;
    if (form) {
      form.requestSubmit();
      return 'submitted';
    }
    return 'none';
  }

  // detect: find the login form and tag its fields.
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  const selectors = arg.selectors ?? {};
  const notFound = (field: string): DetectResult => ({
    found: false,
    hasUsername: false,
    hasSubmit: false,
    error: `The ${field} selector did not match a visible field.`,
  });

  let password: HTMLInputElement;
  if (selectors.password) {
    const el = find(selectors.password);
    if (!usable(el)) return notFound('password');
    password = el;
  } else {
    const el = Array.from(document.querySelectorAll('input[type="password"]')).find(usable);
    if (!el) {
      // Identifier-first login: a username step before the password one. Only the heuristic path
      // does this: an explicit password selector means the caller expects that field to exist.
      const identifier = ((): HTMLInputElement | null => {
        if (selectors.username) {
          const explicit = find(selectors.username);
          return usable(explicit) ? explicit : null;
        }
        const candidates = Array.from(document.querySelectorAll('input')).filter(
          (el) =>
            usable(el) &&
            ['text', 'email', 'tel'].includes(el.type) &&
            (el.type === 'email' ||
              /username|email/.test((el.getAttribute('autocomplete') ?? '').toLowerCase()) ||
              /user|e-?mail|login|account/i.test(`${el.name} ${el.id}`)),
        );
        return candidates[0] ?? null;
      })();
      if (identifier === null) return { found: false, hasUsername: false, hasSubmit: false };
      // A button that means "continue" and not, say, "Subscribe": a newsletter form has an email
      // field too, and typing the login into it would be worse than saying the form is missing.
      const button = selectors.submit
        ? find(selectors.submit)
        : (Array.from((identifier.form ?? document).querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')).find(
            (el) => visible(el) && !(el as HTMLButtonElement).disabled && IDENTIFIER_TEXT.test(el instanceof HTMLInputElement ? el.value.trim() : text(el)),
          ) ?? null);
      if (!visible(button)) return { found: false, hasUsername: false, hasSubmit: false };
      identifier.setAttribute(ATTR, 'username');
      button.setAttribute(ATTR, 'submit');
      return { found: false, hasUsername: true, hasSubmit: true, step: 'identifier' };
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
