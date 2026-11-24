---
title: How it works
description: How autologin-mcp logs an AI agent's browser tab into a web app through bridge mode or Chrome DevTools Protocol (CDP) mode, without the credentials entering the model context.
---

# How it works

autologin-mcp splits a login into two parts:

- **When to log in** is decided by the agent. It sees the login form or the "session expired" message and calls the `login` tool.
- **How to log in** is done by a small deterministic program on your machine, with no AI involved. It finds the form, fills it with the credentials from your local file, submits it and reports the outcome.

The agent only ever sees the profile name, the username and the outcome. The password goes from your credentials file straight into the page.

autologin-mcp can reach the tab in two ways and picks one automatically.

## Bridge mode (default, no setup)

```text
┌─────────────┐ 1. login({url})          ┌───────────────────────────────────────┐
│ AI agent    │─────────────────────────▶│ autologin-mcp                          │
│             │◀─ 2. one-time script ────│  credentials.env · 127.0.0.1 bridge    │
└──────┬──────┘   (no secrets)           └──────────────────▲────────────────────┘
       │ 3. runs the script in the tab                      │ 4. credentials, only if the browser-set
       ▼                                                    │    Origin header matches the profile
┌───────────────────────────────────────────────────────────┴───────────────────┐
│ The tab under test: fills the form, submits, returns { status } to the agent  │
└───────────────────────────────────────────────────────────────────────────────┘
```

1. The agent calls `login` with the tab's URL. autologin-mcp picks the matching profile.
2. autologin-mcp returns `run_in_page` with a small loader script, in three forms: `script` (an expression with top-level `await`, for Claude in Chrome's `javascript_tool`), `function` (for tools that take a function, such as Playwright MCP's `browser_evaluate` and chrome-devtools-mcp's `evaluate_script`) and `expression` (a Promise expression without top-level `await`, for Puppeteer's `page.evaluate`). The loader contains only a one-time URL on `127.0.0.1` that expires after 60 seconds. It never contains a credential.
3. The agent runs the loader in the tab with the JavaScript tool it already has.
4. The page loads the form filler from `127.0.0.1`, looks for the login form, and only when it is about to type asks for the credentials. A page without a login form, or one a person has to finish (single sign-on, a passkey, a captcha), never receives them. The bridge releases them only if the request's `Origin` header belongs to the profile's root URL. Browsers set this header themselves and page scripts cannot change it, so a page on another site gets nothing.
5. The filler fills the form, submits it, waits for the outcome and returns it to the agent: `success`, `submitted`, `failed` with the page's error message, or `no_login_form`. It also reports the outcome to autologin-mcp.

If the agent's JavaScript call is cut off (the page navigated, or another extension took over the tab), the login still runs. The agent calls `login_status` to get the outcome the page reported. If the agent runs the same script again instead, it receives the first run's outcome with a note, and the credentials are not released a second time.

## CDP mode (automatic when Chrome remote debugging is on)

When Chrome's remote debugging is reachable, autologin-mcp connects to Chrome itself over the Chrome DevTools Protocol (CDP), finds the tab whose URL matches the request and fills it directly. The agent does not run anything; `login` returns the outcome.

- **Auto-connect:** turn on `chrome://inspect/#remote-debugging` (Chrome 144+). autologin-mcp finds the browser through the `DevToolsActivePort` file in Chrome's profile folder. Chrome asks you to *Allow* the connection once per session.
- **Dedicated browser:** start a separate Chrome with `--remote-debugging-port=9222` and set `AUTOLOGIN_CDP_URL=http://127.0.0.1:9222` in the credentials file. See [Configuration](configuration.md#use-a-dedicated-debug-chrome).
- The tab's URL is read from Chrome, not taken from the agent, so a page cannot pretend to be another site.

CDP mode also works for apps whose Content-Security-Policy blocks scripts from `127.0.0.1`, where bridge mode cannot.

## How the mode is chosen

| `AUTOLOGIN_MODE` | Behavior |
|---|---|
| `auto` (default) | Try CDP. If Chrome is not reachable (`browser_not_connected`) or the tab is not in that Chrome (`no_matching_tab`), fall back to the bridge. |
| `bridge` | Always use the bridge. autologin-mcp never touches Chrome directly. |
| `cdp` | Always use CDP. Return `browser_not_connected` if Chrome is not reachable. |

## How the login form is found

The same detection code runs in both modes, inside the page:

1. **Password field:** the first visible, enabled `input[type=password]`, or the element matching `<PROFILE>_PASSWORD_SELECTOR`.
2. **Username field:** among the visible text, email and tel inputs before the password field (in the same form when there is one), the best match wins: `autocomplete="username"` or `"email"` first, then `type="email"`, then a name or id that contains user, email, login or account. `<PROFILE>_USERNAME_SELECTOR` overrides this. A form with only a password field works too.
3. **Submit button:** the form's submit button, or a visible button whose text means "log in" (for example Log in, Sign in, Continue, Giriş yap, Anmelden, Connexion, Entrar, Iniciar sesión). `<PROFILE>_SUBMIT_SELECTOR` overrides this. With no button, autologin-mcp submits the form or presses Enter in the password field.
4. **Identifier-first pages:** when there is no password field yet, autologin-mcp looks for a username step: a visible field that says it is a login identifier (`autocomplete="username"`, or a name or id such as `username`, `email`, `login` or `identifier`) that is the only field to type into in its form or small container, followed by a button that means Continue, Next, Log in or Sign in. It types the username, submits, and waits for the password field to appear on the same page (the login form is then filled as usual). So that a one-page form whose password field renders late is not mistaken for a username step, a Next / Continue step has to stay for half the detect time, and a Log in / Sign in step for the whole detect time, before the username is sent alone. Signup, checkout and newsletter forms are left alone; a form with only an email field named `email` and a Next button looks exactly like a username step (see [Troubleshooting](troubleshooting.md#the-page-asks-for-the-username-first)). When no password field follows, the result is `needs_human`: the page probably wants single sign-on, a passkey or a second factor. Nothing is ever typed into a page of another site: in CDP mode the site is checked before every keystroke batch and a username step that leads elsewhere returns `needs_human`, and in bridge mode the script ends with the page (`submitted`, `reason: username_step_navigated`). This works for single-page logins that swap the form in place; a login host of another site (Google, Microsoft, Okta) is still out of scope.
5. **Pages a person has to finish:** with no password field and no username step, the page is checked for single sign-on (only "Sign in with ..." buttons, or a tab on a known provider such as Google, Microsoft or Okta), a passkey or security-key prompt, and a captcha challenge. Such a page returns `needs_human` with that `reason` after the usual detect time, and in bridge mode it never receives the credentials.

autologin-mcp waits up to 5 seconds for a form that renders late. In bridge mode, fields are filled through the native value setter followed by `input` and `change` events, which is what React, Vue and Angular controlled inputs listen to. In CDP mode, autologin-mcp focuses each field and inserts the text through the browser's own input pipeline (`Input.insertText`), then clicks the submit button with a real mouse event.

## How the outcome is detected

After submitting, autologin-mcp watches the page for up to 10 seconds:

| What it sees | Result |
|---|---|
| The element in `<PROFILE>_SUCCESS_SELECTOR` appears | `success` |
| The password field disappears (two checks in a row; when it goes away right at the 10-second mark, one more check decides) | `success` |
| A new error message appears (the message the field points to with `aria-describedby`/`aria-errormessage`, `role="alert"`, or an error-styled element) | `failed`, with that message as `hint` |
| The password field gives way to a one-time-code field (`autocomplete="one-time-code"`, or a name such as `otp` or `totp_code`), and the profile has a TOTP secret | autologin-mcp fills the current code and submits it, then watches again: `success`, or `failed` with `reason: totp_rejected` |
| The same, without a TOTP secret | `needs_human`, `reason: mfa_required`: a person enters the code |
| The page starts navigating (bridge mode) | `submitted`: the agent should look at the page |
| Still on the form after 10 seconds | `failed` |

On `failed`, the password field is cleared and the password (and a one-time code, if one was sent) is removed from any text that is returned.

The one-time code is made on your machine from the profile's TOTP secret (RFC 6238; SHA-1, 6 digits and 30 seconds unless an `otpauth://` URI says otherwise). In CDP mode autologin-mcp types it; in bridge mode the page asks the bridge for it once, when it shows the code step, under the same origin check as the credentials. The secret itself never leaves autologin-mcp. When less than 3 seconds of the current code are left, it waits for the next one.

After three failed logins in five minutes, the profile is paused (`rate_limited`), so a wrong password cannot lock the account.

## Why not let the agent type the password?

Because then the password is part of the conversation. Everything the agent reads or writes is sent to the model provider and can end up in transcripts, logs and context summaries. A file the agent can read has the same problem. autologin-mcp keeps the password in a process the model cannot see and gives the model only the outcome.
