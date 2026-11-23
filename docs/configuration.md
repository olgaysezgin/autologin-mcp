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
| `<PROFILE>_AUTO_LOGIN` | no | Reserved for the planned opt-in auto-login (`true`/`false`). It has no effect yet. |

A profile with a missing or invalid key is listed with its `problems` by `list_profiles` and `npx autologin-mcp list`, and is not used for logins.

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
