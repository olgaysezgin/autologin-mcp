---
title: Getting started
description: Install autologin-mcp in Claude Code, add a login profile for your app, and let your AI agent log in automatically when a session expires.
---

# Getting started

This guide takes you from nothing to an agent that logs itself back in when your app shows a login form.

## Requirements

- **Node.js 22.12 or newer.**
- **[Claude Code](https://claude.com/claude-code).** The installer, skill and guard hook are written for Claude Code. Other MCP clients can run the server too, see [Agents and browser tools](clients.md).
- **A browser tool for the agent** that can run JavaScript in a tab, for example Claude in Chrome, Playwright MCP or chrome-devtools-mcp.
- **A test account for the app you are testing.** Do not use your personal or production account, see [Security model](security.md).

## 1. Install

```bash
npx autologin-mcp install
```

This one command:

1. registers the `autologin` MCP server in Claude Code at user scope, pinned to the exact version you ran;
2. writes a skill (`~/.claude/skills/autologin/SKILL.md`) that tells the agent when and how to use it;
3. adds a `PreToolUse` guard hook and `Read`/`Edit` deny rules that keep the credentials folder out of the model's reach.

Add `--dry-run` to see the changes without applying them. [CLI reference](cli.md#install) lists every change in detail.

> **To install from source** (an unreleased version, a fork, or your own change), build a package and install from it:
>
> ```bash
> git clone https://github.com/olgaysezgin/autologin-mcp.git && cd autologin-mcp
> npm install && npm run build && npm pack
> npx -y file:./autologin-mcp-1.3.3.tgz install --package ./autologin-mcp-1.3.3.tgz
> ```

## 2. Add a login profile

Run this in a **normal terminal, not inside the AI chat**, so the password never passes through the conversation:

```bash
npx autologin-mcp add
#   Profile name (e.g. staging): staging
#   Root URL (e.g. example.com or localhost:3000): staging.example.com
#   Username: qa@example.com
#   Password (hidden):
```

The profile is saved in `~/.autologin-mcp/credentials.env` with file permissions `600`. You can add as many profiles as you like, including several accounts for the same app (for example `admin` and `viewer`). [Configuration](configuration.md) describes the file format.

In a script or CI job, pipe the password in instead of typing it:

```bash
printf '%s' "$STAGING_PASSWORD" | npx autologin-mcp add staging --url staging.example.com --username qa@example.com --password-stdin -y
```

Check what the agent will see:

```bash
npx autologin-mcp list
```

## 3. Restart Claude Code and test as usual

Restart Claude Code so it starts the new MCP server. Then work as you normally would:

```text
You:    Test the checkout flow on staging.
Agent:  …opens staging.example.com → the app redirects to /login
Agent:  calls autologin.login({ url: "https://staging.example.com/login" })
Agent:  runs the returned one-time script in the tab → { "status": "success" }
Agent:  continues the checkout test
```

You do not have to mention autologin-mcp in your prompt. The MCP server's instructions and the skill tell the agent to call `login` whenever a page shows a login form, a "session expired" message, a 401/403 or a redirect to a login URL.

## 4. Optional: turn on CDP mode

By default autologin-mcp uses **bridge mode**, which needs no browser setup. If your app's Content-Security-Policy blocks the bridge, or you prefer that autologin-mcp fills the tab itself, open `chrome://inspect/#remote-debugging` in Chrome (version 144 or newer) and turn remote debugging on. autologin-mcp then switches to **CDP mode** automatically. See [How it works](how-it-works.md).

## Update

`install` pins the version, so autologin-mcp never updates silently. To upgrade:

```bash
npx autologin-mcp@latest install
```

## Uninstall

```bash
npx autologin-mcp uninstall          # keeps your credentials file
npx autologin-mcp uninstall --purge  # also deletes ~/.autologin-mcp
```

## Next steps

- [How it works](how-it-works.md): what happens between `login` and `success`.
- [Configuration](configuration.md): selectors for unusual login forms, URL matching, modes.
- [Troubleshooting](troubleshooting.md): what to do when a login does not go through.
