---
title: Troubleshooting
description: Fix common autologin-mcp problems - JavaScript tool errors after login, Content-Security-Policy, no_login_form, failed logins, rate limits and Chrome remote debugging.
---

# Troubleshooting

## The agent's JavaScript call fails right after the form is submitted

Claude in Chrome reports `Cannot access a chrome-extension:// URL of different extension` or `Detached while handling command`.

Another extension, typically a password manager offering to save the password, took over the tab. **The login itself still ran.** The agent should call `login_status` to get the outcome; the MCP server's instructions tell it to. Reload the tab if the browser tool keeps failing. A separate Chrome profile without password managers avoids the problem.

## `await is not defined` (Puppeteer and similar tools)

The browser tool evaluates a plain script, without top-level `await`, so it cannot run the `script` field. Run the `expression` field instead: it evaluates to a Promise of the login result, which Puppeteer's `page.evaluate` waits for. See [Agents and browser tools](clients.md#puppeteer-and-tools-built-on-it).

## `open_config` or `edit` cannot open an editor

On a machine without a desktop (over SSH, in CI, or in a Linux container), there is no window to open the file in. `open_config` then returns `opened: false` with the file's path, and `edit` prints the path and exits with code 1. Add profiles with `npx autologin-mcp add` (or `--password-stdin` in scripts), or edit the file in a terminal editor: `EDITOR=nano npx autologin-mcp edit`.

## The agent ran the script twice

That is fine. The second run returns the first run's outcome with the note "This one-time script already ran; this is the outcome of that run." The credentials are not released again.

## `no_login_form`

No visible password field was found within 5 seconds.

- If the result has `previous_login` with `success` or `submitted`, the tab is already logged in. This usually means the agent called `login` again after its JavaScript call was cut off. Nothing to fix.
- If the login form is inside an iframe, a shadow root or behind a "Log in" button, it is not supported yet. Open the form first, or see the roadmap.
- If the form is unusual, set `<PROFILE>_PASSWORD_SELECTOR` (and the other selectors) for the profile. See [Configuration](configuration.md#profiles).

## The page asks for the username first

An identifier-first login (email, then password, on the same page) is filled in two steps: autologin-mcp types the username, presses the button and waits up to 5 seconds for the password field.

Before it sends the username alone, autologin-mcp makes sure the page really is a username step, so a normal form whose password field renders a little late is still filled in one go:

- The field must say it is a login identifier: `autocomplete="username"`, or a name or id such as `username`, `email`, `login`, `loginfmt` or `identifier`. An email field alone (an invite or newsletter field) is not enough.
- The field must be the only field to type into in its form, or in a small container around it (up to three levels), and the button must come after it there. A signup, checkout or invite form with more fields is left alone, and so is a footer newsletter field next to a header "Sign in" button.
- With a **Next** or **Continue** button, the username step has to stay on the page for half the detect time (2.5 seconds).
- With a **Log in** or **Sign in** button, autologin-mcp first waits the whole detect time (5 seconds) for a password field.
- A form with nothing but an email field named `email` and a **Next** button looks exactly like a username step. The agent only calls `login` on login pages, but on such a form in a logged-in app the username would be sent.

What the results mean:

- `needs_human` with `reason: password_step_timeout`: no password field appeared after the username. The page probably uses single sign-on, a passkey or a second factor, and a person has to finish the login. No password was sent, and the result does not count toward the rate limit.
- `needs_human` with `reason: left_profile_site` (CDP mode): the username step sent the tab to another site, typically a single sign-on host. Nothing is typed there.
- `submitted` with `reason: username_step_navigated` (bridge mode): the page navigated after the username. Run `login` again on the next page.
- `failed` with `reason: identifier_rejected`: the page showed a new message after the username, for example "No account for this email"; the `hint` has it. Messages that were already on the page before, such as "Your session has expired", are ignored.
- If the continue button has unusual text, set `<PROFILE>_SUBMIT_SELECTOR`.

## `failed` although the credentials are right

- The heuristic may not find the right button. Set `<PROFILE>_SUBMIT_SELECTOR`.
- The app keeps the form on the page after logging in. Set `<PROFILE>_SUCCESS_SELECTOR` to an element that only exists when logged in.
- The app validates the password before sending it (for example a minimum length). The `hint` shows the page's message.

## `rate_limited`

Three logins for the profile failed within five minutes, so the profile is paused to protect the account from a lockout. Check the credentials with `npx autologin-mcp list` and fix them with `npx autologin-mcp edit`. The pause ends five minutes after the failures, or when the MCP server restarts.

## `origin_mismatch`

The tab's host does not match the profile's root URL. Check the port (`localhost:3000` does not match `localhost:5173`) and subdomains (`example.com` does not match `app.example.com`; use `*.example.com`). See [URL matching](configuration.md#url-matching).

## The bridge script returns `error … Content-Security-Policy`

The app's Content-Security-Policy blocks scripts from `127.0.0.1`. Turn on `chrome://inspect/#remote-debugging` so autologin-mcp uses CDP mode, which is not affected by CSP.

## Chrome asks to allow access to "apps and services on this device"

This is Chrome's Local Network Access prompt. It appears once per site when a public site (for example a staging server) loads the bridge from `127.0.0.1`. Allow it for your test sites.

## `browser_not_connected`

Only with `AUTOLOGIN_MODE=cdp`. Remote debugging is off, or Chrome's *Allow* prompt was dismissed. Enable `chrome://inspect/#remote-debugging` and retry, or set `AUTOLOGIN_CDP_URL` to a Chrome started with `--remote-debugging-port`.

## `ambiguous_profile` or `ambiguous_tab`

Several profiles or several tabs match. The agent should call `login` again with `profile`, or with the exact `url` of the tab.

## A harmless shell command is blocked by the hook

The guard hook blocks any `Bash` command that mentions the credentials folder, even `ls`. This is intentional. Edit the file yourself with `npx autologin-mcp edit`.

## The agent does not call `login`

- Restart Claude Code after `install`, and check that `claude mcp list` shows `autologin` as connected.
- Tell the agent once: "When the app asks for a login, use the autologin tool."

## A local `.tgz` build does not update

`npx` caches packages by spec. After rebuilding a `.tgz` with the same name, clear the matching entry in `~/.npm/_npx` and run `install` again.
