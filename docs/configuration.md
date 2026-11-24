---
title: Configuration
description: The autologin-mcp credentials file explained - login profiles, root URL matching, CSS selectors for unusual login forms, bridge and CDP modes, and environment variables.
---

# Configuration

All configuration lives in one file per user: `~/.autologin-mcp/credentials.env`. It is global on purpose. It sits outside your projects, so it never ends up in git, and the same profiles work in every project.

- `npx autologin-mcp add` creates the file and adds profiles for you, with permissions `600` (only your user can read it). In scripts and CI, `add --password-stdin` takes the password from a pipe (see [CLI reference](cli.md#scripts-and-ci---password-stdin)).
- `npx autologin-mcp edit` opens it in `$VISUAL`, `$EDITOR` or your default editor.
- The agent can ask you to edit it with the `open_config` tool. The tool opens the file in your editor and never returns its content. Without a desktop (SSH, CI, a container) it returns the file's path instead, for you to edit it in a terminal.

Edit the file yourself, in a terminal or an editor, never through the AI chat.

## File format

The file uses the `.env` format: one `KEY=value` per line, `#` starts a comment. Quote a value with single quotes if it contains spaces or `#`. An `export ` prefix is allowed.

```env
STAGING_URL=staging.example.com
STAGING_USERNAME=qa@example.com
STAGING_PASSWORD='p@ss w0rd#1'

LOCAL_URL=localhost:3000
LOCAL_USERNAME=admin
LOCAL_PASSWORD=admin
LOCAL_USERNAME_SELECTOR=#email
LOCAL_PASSWORD_SELECTOR=#password
LOCAL_SUBMIT_SELECTOR=button[type=submit]
LOCAL_SUCCESS_SELECTOR=[data-test=user-menu]
LOCAL_TOTP_SECRET=JBSWY3DPEHPK3PXP

AUTOLOGIN_MODE=auto
```

## Profiles

A profile is a group of keys that share a prefix. `STAGING_URL`, `STAGING_USERNAME` and `STAGING_PASSWORD` form the profile `staging`. Profile names are case-insensitive; the agent sees them in lower case.

| Key | Required | Meaning |
|---|---|---|
| `<PROFILE>_URL` | yes | Root URL of the app, for example `example.com`, `staging.example.com`, `localhost:3000` or `*.example.com` |
| `<PROFILE>_USERNAME` | yes | Username or email to log in with. The agent can see it. |
| `<PROFILE>_PASSWORD` | yes | Password. Never shown to the agent. |
| `<PROFILE>_USERNAME_SELECTOR` | no | CSS selector of the username field, when it is not detected automatically |
| `<PROFILE>_PASSWORD_SELECTOR` | no | CSS selector of the password field |
| `<PROFILE>_SUBMIT_SELECTOR` | no | CSS selector of the element to click to log in |
| `<PROFILE>_SUCCESS_SELECTOR` | no | CSS selector of an element that only exists after a successful login, for apps where the login form stays on the page |
| `<PROFILE>_TOTP_SECRET` | no | The account's authenticator secret, as base32 or an `otpauth://totp/...` URI, for the one-time code after the password. See [Authenticator codes](#authenticator-codes-totp). Never shown to the agent. |
| `<PROFILE>_AUTO_LOGIN` | no | Reserved for the planned opt-in auto-login (`true`/`false`). It has no effect yet. |

A profile with a missing or invalid key is listed with its `problems` by `list_profiles` and `npx autologin-mcp list`, and is not used for logins.

### Authenticator codes (TOTP)

When the app asks for a code from an authenticator app after the password, give the profile that account's TOTP secret, and autologin-mcp fills the code too:

```bash
npx autologin-mcp add staging --totp            # asks for the TOTP secret hidden, after the password
printf '%s\n%s' "$PASSWORD" "$TOTP_SECRET" | npx autologin-mcp add staging \
  --url staging.example.com --username qa@example.com --password-stdin --totp -y
```

- The secret is the base32 text an app offers under "Can't scan the code?", or the whole `otpauth://totp/...` URI inside the QR code. A URI may set `algorithm` (SHA1, SHA256, SHA512), `digits` (6 to 8) and `period`; the defaults are SHA-1, 6 digits and 30 seconds.
- The code is made on this machine (RFC 6238) right before it is typed. In bridge mode the page gets only the current code, once per login, and only the login's own script can ask for it. The secret and the code are redacted from every tool result.
- A code step on the login page itself is filled in the same run. When the app shows the code on a page of its own after the password, CDP mode follows the tab there; in bridge mode the first script returns `submitted`, and the next `login` call on the code page fills the code without asking for the credentials again. Such a page gets a code only when it is the document the tab loaded right after that password step, within a minute, and still at the address it loaded with (the script leaves a mark in the tab's sessionStorage when the page navigates; the next run reads and drops it). A code page the agent opens later, or reaches by routing on in a single-page app, is left alone, as before (`no_login_form`).
- A code field is filled only when it is the one field to type in its form or small container (the login's own username field aside), and never in a form with a button that turns something off or removes it ("Disable two-factor authentication", "Remove device"). A code split into one box per digit is not filled: it is handed to a person (`mfa_required`). For TOTP profiles, also set `<PROFILE>_SUCCESS_SELECTOR`: a page that shows it counts as logged in, and never gets a code.
- One code per password step. If less than 3 seconds of the current code are left, autologin-mcp waits for the next one. A rejected code returns `failed` with `reason: totp_rejected` and counts toward the rate limit. In bridge mode, when the code page navigates, the script returns `submitted` with `reason: code_submitted`; if the page right after the code is the code page again with an error message, or the app's login form, the next `login` call returns `totp_rejected` (counted) and sends no new code. A login form on any later page (logging out and in again) is a normal login. So a wrong secret sends at most one code per password step, and the rate limit stops it after three.
- A form that asks for the password and the code at the same time is not supported: the code field stays empty.
- Codes sent by SMS or email, push approvals and security keys are not covered: without a TOTP secret the code step is handed to a person (`needs_human`, `reason: mfa_required`).
- With the password and the TOTP secret in one file, the account's second factor becomes part of the first. Use this for test accounts only.

### Several accounts for the same app

Profiles may share a URL:

```env
ADMIN_URL=staging.example.com
ADMIN_USERNAME=admin@example.com
ADMIN_PASSWORD=...

VIEWER_URL=staging.example.com
VIEWER_USERNAME=viewer@example.com
VIEWER_PASSWORD=...
```

When several profiles match a tab, `login` returns `ambiguous_profile` with the candidates, and the agent calls it again with `profile`. You can also tell the agent which account to use ("log in as the viewer").

## URL matching

A profile only fills pages whose host matches its root URL. This is what stops a prompt-injected page on another site from receiving your credentials.

- **Root URL only.** Write `example.com` or `localhost:3000`. A scheme or a path is ignored.
- `example.com` matches `example.com` and `www.example.com`.
- `*.example.com` matches `example.com` and every subdomain.
- **Ports:** when the root URL has a port, the tab's port must be the same. Without a port, only the default ports 80 and 443 match.
- `localhost`, `127.0.0.1` and `[::1]` count as the same host.

## Settings

Settings are keys that start with `AUTOLOGIN_` in the same file.

| Key | Values | Meaning |
|---|---|---|
| `AUTOLOGIN_MODE` | `auto` (default), `bridge`, `cdp` | How autologin-mcp reaches the tab. See [How it works](how-it-works.md#how-the-mode-is-chosen). |
| `AUTOLOGIN_CDP_URL` | `http://127.0.0.1:9222` or a `ws://` endpoint | Use this Chrome for CDP mode instead of auto-connecting to your everyday Chrome |

### Use a dedicated debug Chrome

If you want CDP mode without turning on remote debugging in your everyday Chrome, start a separate Chrome with its own profile:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.autologin-mcp/chrome"
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.autologin-mcp/chrome"
```

Add `AUTOLOGIN_CDP_URL=http://127.0.0.1:9222` to the credentials file, and point the agent's browser tool at the same browser: Playwright MCP with `--cdp-endpoint http://127.0.0.1:9222`, chrome-devtools-mcp with `--browserUrl http://127.0.0.1:9222`.

A separate Chrome profile without password managers also avoids extensions that take over the tab after a login form is submitted.

## Environment variables

| Variable | Meaning |
|---|---|
| `AUTOLOGIN_HOME` | Use this folder instead of `~/.autologin-mcp` for the credentials file |
| `VISUAL`, `EDITOR` | Editor used by `npx autologin-mcp edit` |
| `DISPLAY`, `WAYLAND_DISPLAY` | On Linux, `edit` and `open_config` open a desktop editor only when one of these is set |
| `CHROME_PATH` | Chrome binary for the end-to-end tests (development only) |

The values in the credentials file are parsed in memory. They are never copied into `process.env`, so child processes and error reports cannot pick them up.
