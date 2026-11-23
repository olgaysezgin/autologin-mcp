---
title: MCP tools
description: Reference for the autologin-mcp MCP tools list_profiles, login, login_status and open_config, with every login result status and what an AI agent should do next.
---

# MCP tools

autologin-mcp is a stdio MCP server named `autologin`. In Claude Code its tools appear as `mcp__autologin__<tool>`. Every tool result passes through a redactor that removes each configured password (and its URL-encoded form) before it is returned.

## `list_profiles`

Lists the configured profiles. Passwords are never returned.

```json
{
  "file": "/home/you/.autologin-mcp/credentials.env",
  "profiles": [
    { "profile": "staging", "url": "staging.example.com", "username": "qa@example.com" },
    { "profile": "local", "url": "localhost:3000", "username": "admin", "problems": ["LOCAL_PASSWORD is missing"] }
  ]
}
```

With no profiles, the result includes a `hint` that asks the user to run `npx autologin-mcp add` in a separate terminal.

## `login`

Logs the tab under test into its app.

| Argument | Type | Meaning |
|---|---|---|
| `url` | string, optional | The tab's current URL. Recommended: it selects the profile and, in CDP mode, the tab. |
| `profile` | string, optional | Profile name from `list_profiles`. Needed only when several profiles match. |

**In bridge mode** it returns `run_in_page`:

```json
{
  "status": "run_in_page",
  "profile": "staging",
  "hint": "Run `script` unchanged in the tab that shows the login form ...",
  "expires_in_s": 60,
  "script": "await (async () => ...)()",
  "function": "async () => ...",
  "expression": "(async () => ...)()"
}
```

The agent runs one of the three forms of the same loader **unchanged** in the tab:

| Field | Form | For |
|---|---|---|
| `script` | Expression with top-level `await` | Tools with REPL semantics: Claude in Chrome `javascript_tool` |
| `function` | Function source | Tools that take a function: Playwright MCP `browser_evaluate`, chrome-devtools-mcp `evaluate_script` |
| `expression` | Expression that evaluates to a Promise, without top-level `await` | Tools that evaluate a plain script and wait for its value: Puppeteer `page.evaluate`, CDP `Runtime.evaluate` with `awaitPromise` |

The value it returns is the login result below. The script works once, within 60 seconds, and only on a page of the profile's site.

**In CDP mode** it fills the tab itself and returns the login result directly.

### Login results

| `status` | Meaning | What the agent should do |
|---|---|---|
| `success` | Logged in. `url` is the page after login. | Continue the task. |
| `submitted` | The form was submitted and the page navigated before the outcome was visible (bridge mode). With `reason: username_step_navigated`, only the username of an identifier-first page was sent before the page navigated; that is not counted as a login that went through. | Look at the page to confirm the login. With `username_step_navigated`, call `login` again on the next page. |
| `failed` | Still on the login form. `hint` carries the page's error message (password removed), `reason` the cause: `still_on_login_form`, or `identifier_rejected` (the username step of an identifier-first page refused the account). | Tell the user the `hint`. Retry at most once. |
| `needs_human` | The page wants something only a person can do; `reason` says what. `sso`: the tab is on a single sign-on provider, or the login page offers only "Sign in with ..." buttons. `passkey`: the page asks for a passkey or security key. `captcha`: a captcha challenge stands before the login. `mfa_required`: after the password, the page asks for a one-time code. `password_step_timeout`: after the username step of an identifier-first page, no password field appeared. `left_profile_site` (CDP mode): the tab moved to another site before anything was typed. Except for `mfa_required`, no password was sent; none of them counts toward the rate limit. | Tell the user the `hint`. Do not retry. |
| `no_login_form` | No visible password field was found. If `previous_login` shows a recent `success` or `submitted`, the tab is already logged in. | With `previous_login`: continue. Otherwise ask the user to set selectors for the profile. |
| `origin_mismatch` | The URL or the page's origin does not belong to any (or the requested) profile. Nothing was filled. | Ask the user to add a profile for this site. |
| `ambiguous_profile` | Several profiles match. `candidates` lists them. | Call `login` again with `profile`. |
| `ambiguous_tab` | CDP mode: several open tabs match. | Call `login` again with the exact `url` of the tab. |
| `no_matching_tab` | CDP mode: no open tab has that URL. In `auto` mode autologin-mcp falls back to the bridge instead. | Check the URL. |
| `no_profile` | No usable profile, or no profile with that name. | Ask the user to run `npx autologin-mcp add` in a separate terminal, or call `open_config`. |
| `invalid_profile` | The named profile has problems (see `hint`). | Ask the user to fix the credentials file. |
| `expired` | The one-time script expired or was already used and its outcome is unknown. | Call `login_status`, or `login` again. |
| `browser_not_connected` | `AUTOLOGIN_MODE=cdp` and Chrome is not reachable. | Ask the user to enable `chrome://inspect/#remote-debugging`. |
| `rate_limited` | Three failed logins in five minutes for this profile (or 20 credential releases in five minutes in bridge mode). | Stop and ask the user to check the credentials. |
| `error` | Something unexpected, explained in `hint` (for example the page's Content-Security-Policy blocked the bridge). | Report the `hint` to the user. |

### `previous_login`

An agent whose JavaScript call was cut off often just calls `login` again, on a page that is already logged in. That run finds no form, so its `no_login_form` result also carries the profile's last real outcome from the past five minutes:

```json
{
  "status": "no_login_form",
  "url": "https://staging.example.com/dashboard",
  "hint": "No login form on this page, and the previous login for this profile (success at 2026-01-15T09:42:10.000Z) went through: the tab is most likely already logged in. Look at the page and continue; call login again only if it shows a login form.",
  "previous_login": { "status": "success", "at": "2026-01-15T09:42:10.000Z", "url": "https://staging.example.com/dashboard" }
}
```

## `login_status`

Returns the latest outcome per profile, as reported by the page in bridge mode or by the engine in CDP mode. The agent uses it when running the `run_in_page` script failed or returned nothing, for example because the page navigated or another browser extension took over the tab.

| Argument | Type | Meaning |
|---|---|---|
| `profile` | string, optional | Only this profile |

```json
{
  "results": [
    { "profile": "staging", "status": "success", "url": "https://staging.example.com/dashboard", "via": "bridge", "at": "2026-01-15T09:30:05.000Z" }
  ]
}
```

Outcomes are kept in memory for the lifetime of the MCP server process.

## `open_config`

Creates the credentials file if needed and opens it in the user's editor, so they can add or change profiles themselves. The file content is never returned.

Where no editor can be opened (no desktop over SSH, in CI or in a Linux container, or the opener fails right away), the result says so instead of claiming success, and gives the agent the file's path to pass on:

```json
{
  "file": "/home/you/.autologin-mcp/credentials.env",
  "opened": false,
  "hint": "Could not open an editor here (there is no desktop session here ...). Ask the user to run \"npx autologin-mcp add\" in a separate terminal (never in this chat), or to open this file in a text editor there. Do not read this file."
}
```

## Server instructions

The server sends these instructions to the MCP client at startup, so even an agent with no skill or memory knows when to use it:

- When a page under test shows a login form, a "session expired" message, a 401/403, or redirects to a login URL, call `login`, then continue the task.
- If `login` returns `run_in_page`, run `script` unchanged in the tab (or `function` / `expression`, depending on the browser tool); if that call fails or returns nothing, call `login_status`.
- On `needs_human`, the page wants something only a person can do (single sign-on, a passkey, a captcha or a second factor): tell the user the hint and do not retry.
- Never ask the user for a password, never type credentials into a page, never read files under `~/.autologin-mcp`, never modify the login script, and do not inspect the login request body or read password field values.
