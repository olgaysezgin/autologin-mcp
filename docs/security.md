---
title: Security model
description: How autologin-mcp keeps login credentials out of the AI model's context - origin checks, one-time loopback bridge, redaction, guard hook - and the honest limits of the approach.
---

# Security model

autologin-mcp has one job: an AI agent can log in to the app it is testing, but the password never enters the model's context. Everything below serves that goal.

## What the agent can and cannot see

| The agent sees | The agent never sees |
|---|---|
| Profile names, root URLs and usernames (`list_profiles`) | Passwords and TOTP secrets |
| The login outcome (`success`, `failed` with the page's error message, ...) | The content of the credentials file |
| The one-time loader script (a `127.0.0.1` URL, no credential) | The credentials response of the bridge |
| After login: the app itself, including session cookies, as with any logged-in browser | |

## Protections

| Risk | What autologin-mcp does |
|---|---|
| The agent reads the credentials file with `Read`, `cat`, `grep` or a sub-agent | `install` adds a Claude Code **PreToolUse hook** that blocks every tool call touching `~/.autologin-mcp`: file tools by path, shell commands and other tools by text. Hooks also run in "skip permissions" mode. `Read`/`Edit` deny rules are a second layer. |
| A password in a tool result or an error message | Every result passes through a redactor that removes each configured password and its URL-encoded form. The in-page filler scrubs the password from any error text it returns. |
| A password in the environment | Values are parsed in memory and never copied into `process.env`. |
| A malicious or prompt-injected page asks the agent to "log in here" | A profile only fills pages whose host matches its root URL. In bridge mode the credentials are requested only after the page showed a login form to fill, so a page without one never receives them. In CDP mode the host comes from Chrome itself; in bridge mode from the `Origin` header, which the browser sets and page scripts cannot change. |
| Another program or page uses the bridge | The bridge listens on `127.0.0.1` only, on a random port. Each script carries a random 192-bit token, works once and expires after 60 seconds. A profile can be released at most 20 times in five minutes. |
| The agent re-runs a used script | It receives the first run's outcome, not the credentials. |
| A wrong password locks the account | After three failed logins in five minutes, the profile is paused (`rate_limited`). A rejected one-time code counts the same way. |
| A TOTP secret leaks to the page or the agent | The code is made on your machine; a page only gets the current code, once per login, after the password and under the same origin check. The secret and the code are redacted from every result. |
| The password stays in the page after a failed attempt | The password field is cleared. |
| A silent update of a tool that handles credentials | `install` pins the exact package version. |

## Limits

autologin-mcp prevents **accidental** exposure. It is not a sandbox against a deliberately hostile agent.

- **The hook matches paths and text.** It stops accidental reads, not an agent that deliberately hides the path (for example by encoding it). It also blocks harmless `Bash` commands that merely mention the folder. `Read`/`Write`/`Edit` are only blocked for paths inside it.
- **The credentials file is plaintext**, protected by file permissions (`600`). Other programs running as your user can read it.
- **A TOTP secret next to the password** turns two factors into one: whoever reads the file has both. Store TOTP secrets only for test accounts.
- **JavaScript in the page.** An agent that runs its own JavaScript in the tab could read the password field after it is filled, or modify the bridge script. The instructions tell the agent not to, but they cannot force it.
- **Session cookies** are visible to an agent that controls the browser once you are logged in.
- **Network inspection tools** could show the login request body.
- **The guard hook is a Claude Code feature.** In other MCP clients, use the client's own permission rules to deny access to `~/.autologin-mcp`, if it has them.

## Recommendations

- **Use dedicated test accounts** with the least privileges your tests need. Never store a personal or production administrator password.
- Run add, edit and remove in a normal terminal. Never paste a password into an AI chat.
- Prefer a separate Chrome profile for agent testing: fewer extensions see the login, and your everyday sessions stay out of reach.
- Keep the guard hook installed. Do not add allow rules for `~/.autologin-mcp`.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: [Security → Report a vulnerability](https://github.com/olgaysezgin/autologin-mcp/security/advisories/new). See [SECURITY.md](https://github.com/olgaysezgin/autologin-mcp/blob/main/SECURITY.md) for the scope.
