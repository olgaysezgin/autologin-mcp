# Changelog

Every version below is the same version in `package.json`, the git tag `v<version>`, the npm package and the GitHub release. The release workflow refuses to publish when they disagree.

## 1.4.0 - 2026-11-24

- Authenticator codes (TOTP, [#1](https://github.com/olgaysezgin/autologin-mcp/issues/1), proposed by mrsarac): a profile can hold the account's TOTP secret (`<PROFILE>_TOTP_SECRET`, base32 or an `otpauth://totp/...` URI with its algorithm, digits and period). When the page asks for a one-time code after the password, autologin-mcp makes the current code on this machine (RFC 6238) and fills it, in CDP and bridge mode. The secret never leaves autologin-mcp: in bridge mode the page asks for the current code once, when it shows the code step, under the same origin check as the credentials.
- A code the page rejects returns `failed` with `reason: totp_rejected` and counts toward the rate limit; the code and password fields are cleared. When less than 3 seconds of the current code are left, autologin-mcp waits for the next one.
- A code page of its own (a server-rendered app that navigates after the password) is a code step too, within two minutes of that password step: CDP mode follows the tab there, and in bridge mode the next `login` call on that page fills just the code. Without a TOTP secret it returns `needs_human` with `reason: mfa_required` instead of `no_login_form`. Outside a login a code page is left alone as before, so a code field on a logged-in page never gets a code.
- One code per password step: in bridge mode a code page that navigates returns `submitted` with `reason: code_submitted`, and if the app asks for the code again, the next `login` call returns `failed` with `reason: totp_rejected` (counted toward the rate limit) without sending another code.
- In bridge mode only the login's own script can ask for the code: the code endpoint wants a key that comes with that script (never in a tool result), and answers no more once the login reported its outcome. A started script also gets a fresh time window, so a long login with a code step does not run out.
- `add --totp` asks for the TOTP secret hidden, or reads it as a second piped line with `--password-stdin`. A value after `--totp` is refused, so a secret cannot end up as the profile name or in the shell history. `list` and `list_profiles` show which profiles have one; the secret and the code are redacted from every result.
- Without a TOTP secret, the code step is handed to a person as before (`needs_human`, `reason: mfa_required`).

## 1.3.3 - 2026-11-24

- A login whose form went away just as the wait for the outcome ran out (a busy page, or a slow login close to the 10-second limit) was reported as `failed` with `still_on_login_form` and counted toward the rate limit. autologin-mcp now looks once more before calling it a failure, in CDP and bridge mode; a form that is back on that look still fails.
- README: autologin-mcp is also listed on Glama.

## 1.3.2 - 2026-11-24

The code is the same as 1.3.1.

- autologin-mcp is in the official MCP Registry as `io.github.olgaysezgin/autologin-mcp`: `package.json` names it with `mcpName`, `server.json` describes the entry, and the release workflow publishes it with every release.

## 1.3.1 - 2026-11-23

Documentation only; the code is the same as 1.3.0.

- npm: the package description names the agents and browser tools it works with (Claude Code, Codex, Cursor, Gemini CLI; Claude in Chrome, Playwright MCP, chrome-devtools-mcp, Puppeteer).
- README, website and `llms.txt` describe identifier-first logins, `needs_human` with its reasons, and that bridge mode asks for the credentials only once the page showed a login form.

## 1.3.0 - 2026-11-23

- Pages a person has to finish are recognised and returned as `needs_human` with a reason, instead of `no_login_form`, `failed` or a misleading `success` ([#2](https://github.com/olgaysezgin/autologin-mcp/issues/2), proposed by mrsarac): `sso` (a tab on a known single sign-on provider, or a login page with only "Sign in with ..." buttons), `passkey`, `captcha`, and `mfa_required` (a one-time-code field after the password). None of them counts toward the rate limit.
- Bridge mode asks for the credentials only when it is about to type into a form it found. A page without a login form, or one a person has to finish, never receives them. The profile's selectors (not secret) now come with the filler script.
- Signs of single sign-on, passkeys and captchas count only when the page has no password field and no username step, and only after the usual detect time, so pages that worked before are filled as before.

## 1.2.0 - 2026-11-23

- Identifier-first logins ([#4](https://github.com/olgaysezgin/autologin-mcp/pull/4), contributed by mrsarac): when a page asks for the email or username first and swaps in the password field after Next, Continue or Sign in, the login now fills both steps in CDP and bridge mode. A page that rejects the username returns `failed` with `reason: identifier_rejected`.
- Only real username steps are used: the field must say it is a login identifier (`autocomplete="username"`, or a name or id such as `username`, `email`, `login`, `identifier`), be the only field to type into in its form or small container, and come before a Continue / Next / Sign in button there. Signup, checkout and newsletter forms, and invite forms with more than one field, are left alone; a form with only an email field named `email` and a Next button looks exactly like a username step.
- Normal one-page forms are not affected: the username is sent alone only after a Next / Continue step stayed for half the detect time (2.5 s), or a Log in / Sign in step for the whole detect time, so a form whose password field renders late is still filled in one submit. A message that was on the page before the username step (such as "Your session has expired") is not taken as a rejection.
- New status `needs_human`: no password field followed the username step (`reason: password_step_timeout`), or in CDP mode the tab left the profile's site (`reason: left_profile_site`), typically for single sign-on. The site is checked before each step and again right before typing, so nothing is typed into a page of another site; the result does not count toward the rate limit, and the agent is told to hand over to the user instead of retrying.
- Bridge mode: a navigation right after the username step returns `submitted` with `reason: username_step_navigated` and is not taken as a login that went through. A re-run of a used script now waits up to 25 s for the first run's result.

## 1.1.0 - 2026-11-23

- Bridge mode: `run_in_page` also returns `expression`, the loader as a Promise expression without top-level `await`, for tools that evaluate a plain script such as Puppeteer's `page.evaluate`. There, `script` failed with "await is not defined".
- `add --password-stdin` reads the password from a pipe and asks nothing, for scripts and CI (`printf '%s' "$PASSWORD" | npx autologin-mcp add staging --url … --username … --password-stdin -y`). `-y` now also replaces an existing profile without asking in the interactive `add`. A `--password <value>` option is refused, since it would leave the password in the shell history.
- `print-config [--client json|claude-desktop|cursor|vscode|gemini|codex|hermes]` prints the MCP server entry for agents other than Claude Code, with their own add command where they have one, and a note that the guard hook is Claude Code only.
- `open_config` and `edit` no longer report an editor as opened when there is no desktop (SSH, CI, Linux containers) or the opener fails right away. `open_config` then returns `opened: false` with the file's path; `edit` prints the path and exits with code 1.

## 1.0.1 - 2026-11-22

- README: an animated demo of Claude Code logging in with autologin-mcp, npm download and Node.js badges, and a feature overview.
- Releases: `scripts/release.mjs` keeps `package.json`, git tags, npm, `CHANGELOG.md`, the docs and the website on one version. Only the release workflow can publish, and every release gets a GitHub release with its changelog section.

## 1.0.0 - 2026-11-22

First release.

- MCP tools `list_profiles`, `login`, `login_status` and `open_config`.
- Bridge mode with no browser setup: a one-time script with a 60-second `127.0.0.1` URL; credentials are released only to the profile's origin.
- CDP mode through Chrome remote debugging (`chrome://inspect/#remote-debugging` auto-connect or `AUTOLOGIN_CDP_URL`).
- Form detection for React, Vue and Angular forms, outcome detection with the page's own error message, and `previous_login` context when a page has no login form.
- CLI: `install`, `uninstall`, `add`, `list`, `remove` and `edit`, with a global credentials file outside your projects.
- Claude Code skill, PreToolUse guard hook and deny rules that keep the agent away from the credentials folder.
- Redacted tool results and a limit of three failed logins per five minutes per profile.
