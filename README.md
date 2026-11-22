<p align="center">
  <img src="docs/assets/logo.svg" width="112" height="112" alt="autologin-mcp logo: an asterisk, like a masked password character, inside an open ring">
</p>

<h1 align="center">autologin-mcp</h1>

<p align="center">
  <strong>Auto-login MCP server for AI coding agents.</strong><br>
  Your agent logs in to the app it is testing. Your password never reaches the model.
</p>

<p align="center">
  <a href="https://github.com/olgaysezgin/autologin-mcp/actions/workflows/ci.yml"><img src="https://github.com/olgaysezgin/autologin-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/autologin-mcp"><img src="https://img.shields.io/npm/v/autologin-mcp" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://olgaysezgin.github.io/autologin-mcp/"><img src="https://img.shields.io/badge/docs-website-4338ca" alt="Documentation website"></a>
</p>

<p align="center">
  <a href="https://olgaysezgin.github.io/autologin-mcp/">Website</a> ·
  <a href="#quick-use">Quick use</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="#faq">FAQ</a>
</p>

**autologin-mcp** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI coding agents such as **Claude Code** log in to the web app they are testing. When the agent's browser tab shows a login form, a "session expired" message, a 401/403 or a redirect to a login page, the agent calls the `login` tool, and autologin-mcp fills the form with credentials stored on your machine. The username and password never appear in the conversation, so they never reach the model. It works with **Claude in Chrome**, **Playwright MCP** and **chrome-devtools-mcp**, and needs no browser setup.

```text
You:            "Test the checkout flow on staging"
Agent:          …navigates… the session has expired, the app shows a login form
Agent:          calls autologin.login({ url })                 ← no password in the request
autologin-mcp:  returns a one-time script                      ← no password in the response
Agent:          runs it in the tab → { "status": "success" }   ← the page got the password from your machine
Agent:          continues the checkout test
```

## Quick use

Requirements: Node.js 22.12+, [Claude Code](https://claude.com/claude-code), and a browser tool for the agent (for example Claude in Chrome).

```bash
# 1. Register the MCP server, skill and guard hook in Claude Code
npx autologin-mcp install

# 2. Add a login profile. Run this in a normal terminal, not in the AI chat.
npx autologin-mcp add
#   Profile name (e.g. staging): staging
#   Root URL (e.g. example.com or localhost:3000): staging.example.com
#   Username: qa@example.com
#   Password (hidden):
```

3. Restart Claude Code and test as usual. When the app asks for a login, the agent calls `login` by itself.
4. Optional: turn on `chrome://inspect/#remote-debugging` in Chrome (144+) to let autologin-mcp fill the tab directly (CDP mode).

Upgrade with `npx autologin-mcp@latest install`, remove with `npx autologin-mcp uninstall`. Step-by-step guide: [Getting started](docs/getting-started.md).

## Why

- **Sessions expire in the middle of long agent runs.** The agent stops, or asks you for the password.
- **A password pasted into the chat becomes part of the conversation.** It is sent to the model provider and ends up in transcripts, logs and context summaries.
- **A password in a file the agent can read** (a project `.env`, a prompt file) has the same problem, and can end up in git.

autologin-mcp splits the work: the agent decides **when** to log in; a small deterministic program on your machine does the **how**, with no AI involved. It finds the login form, fills it, submits it and reports only the outcome.

## Documentation

The full documentation is in [`docs/`](docs/README.md) and on the [website](https://olgaysezgin.github.io/autologin-mcp/). The essentials:

### How it works

- **Bridge mode (default, zero setup).** `login` returns a one-time loader script containing only a 60-second URL on `127.0.0.1`. The agent runs it in the tab with the JavaScript tool it already has (`javascript_tool`, `browser_evaluate` or `evaluate_script`). The page then fetches the credentials from your machine, and they are released only if the page's browser-set `Origin` header belongs to the profile's site.
- **CDP mode (automatic when Chrome remote debugging is on).** autologin-mcp connects to Chrome over the DevTools Protocol and fills the tab itself; the agent runs nothing.
- The filler works with React, Vue and Angular forms, waits for the outcome, and returns `success`, `submitted`, or `failed` with the page's error message.

More: [How it works](docs/how-it-works.md).

### The credentials file

`npx autologin-mcp add` writes `~/.autologin-mcp/credentials.env` (permissions `600`). It is global, outside your projects, so it never ends up in git. Edit it with `npx autologin-mcp edit`:

```env
STAGING_URL=staging.example.com
STAGING_USERNAME=qa@example.com
STAGING_PASSWORD='p@ss w0rd#1'      # quote values that contain spaces or #

LOCAL_URL=localhost:3000
LOCAL_USERNAME=admin
LOCAL_PASSWORD=admin
LOCAL_SUBMIT_SELECTOR=button[type=submit]   # optional, for unusual forms
```

A profile only fills pages whose host matches its root URL (`example.com`, `*.example.com`, `localhost:3000`). Several accounts for the same app are fine. More: [Configuration](docs/configuration.md).

### MCP tools

| Tool | What the agent gets back |
|---|---|
| `list_profiles` | Profile name, root URL and username for each profile. Never passwords. |
| `login({ url?, profile? })` | Bridge mode: `run_in_page` with a one-time `script`/`function` to run in the tab. CDP mode: the result directly (`success`, `submitted`, `failed`, `no_login_form`, `rate_limited`, …). |
| `login_status({ profile? })` | The latest outcome per profile, for when the agent's JavaScript call was cut off. |
| `open_config` | Opens the credentials file in your editor. The content is never returned. |

More: [MCP tools](docs/mcp-tools.md) and [CLI reference](docs/cli.md).

### Security in one paragraph

A Claude Code guard hook and deny rules block the agent from reading the credentials folder, also in skip-permissions mode. Every tool result is scrubbed of passwords. The bridge listens on `127.0.0.1` only, each script works once for 60 seconds, and credentials go only to the profile's origin, so a prompt-injected page on another site gets nothing. Three failed logins in five minutes pause a profile, so a wrong password cannot lock the account. autologin-mcp prevents accidental exposure, not a deliberately hostile agent: **use dedicated test accounts.** More: [Security model](docs/security.md).

### Works with

| Agent / browser tool | Status |
|---|---|
| Claude Code + Claude in Chrome | Supported and tested end to end |
| Claude Code + Playwright MCP | Supported (`browser_evaluate`, or CDP with a shared browser) |
| Claude Code + chrome-devtools-mcp | Supported (`evaluate_script`, or CDP with a shared browser) |
| Other MCP clients | The stdio server runs; installer, skill and guard hook are Claude Code only |

More: [Agents and browser tools](docs/clients.md) and [Troubleshooting](docs/troubleshooting.md).

## FAQ

**How do I let Claude Code log in to my web app without giving it my password?**
Install autologin-mcp, add a profile for your app in a normal terminal, and restart Claude Code. When the app shows a login form, Claude calls `login` and autologin-mcp fills the form with the credentials on your machine. Claude only sees the outcome.

**Does the password ever reach the AI model?**
No. It goes from the local credentials file straight into the page, through the origin-checked `127.0.0.1` bridge or the Chrome DevTools Protocol. Tool results are redacted, and a guard hook blocks reads of the credentials file.

**Do I need Chrome remote debugging?**
No. Bridge mode needs no browser setup. Remote debugging enables CDP mode, which also works when the app's Content-Security-Policy blocks the bridge.

**Does it support SSO, 2FA or multi-step logins?**
Not yet: it handles username + password forms on the app's own page. Multi-step logins, iframes, SSO hosts and TOTP are on the roadmap.

**Is it free?**
Yes, MIT licensed.

More questions: [FAQ](docs/faq.md).

## Roadmap

- [ ] Opt-in auto-login (CDP mode): watch a profile's URL and log in without the agent asking
- [ ] Multi-step logins (username → next → password), iframes, SSO login hosts
- [ ] TOTP codes
- [ ] `doctor` and `test <profile>` commands
- [ ] Installers for Codex CLI, Gemini CLI and Cursor; a Claude Code plugin

## Development

```bash
npm install
npm test            # unit tests + end-to-end tests in a headless Chrome
npm run coverage    # fails below 98% statements/branches/functions/lines
npm run build && npm run smoke
```

The end-to-end tests start a throwaway headless Chrome (set `CHROME_PATH` if Chrome is not in a standard location). See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Olgay Sezgin
