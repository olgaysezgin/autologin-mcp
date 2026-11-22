---
title: Documentation
description: Complete documentation for autologin-mcp, the open-source auto-login MCP server that signs AI coding agents into the web app they are testing without exposing the password to the model.
permalink: /docs/
---

# autologin-mcp documentation

autologin-mcp is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for AI coding agents such as Claude Code. When the agent's browser tab hits a login form or an expired session while it tests your web app, the agent calls the `login` tool, and autologin-mcp fills in the form with credentials stored on your machine. The username and password never appear in the conversation, so they never reach the model.

## Contents

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Requirements, installation, your first profile, the first automatic login, uninstalling |
| [How it works](how-it-works.md) | Bridge mode and CDP mode, how the login form is found and filled, how the outcome is detected |
| [Configuration](configuration.md) | The credentials file, profile keys, URL matching, selectors, modes and environment variables |
| [MCP tools](mcp-tools.md) | `list_profiles`, `login`, `login_status`, `open_config`, and every result status with what the agent should do |
| [CLI reference](cli.md) | `install`, `uninstall`, `add`, `list`, `remove`, `edit`, and exactly what `install` changes |
| [Security model](security.md) | What keeps the password away from the model, the threat model, and the limits |
| [Agents and browser tools](clients.md) | Claude Code with Claude in Chrome, Playwright MCP, chrome-devtools-mcp and other MCP clients |
| [Troubleshooting](troubleshooting.md) | Every common error and how to fix it |
| [FAQ](faq.md) | Short answers to the questions people ask most |

## The 30-second version

```bash
npx autologin-mcp install   # registers the MCP server, a skill and a guard hook in Claude Code
npx autologin-mcp add       # run in a normal terminal: profile name, root URL, username, hidden password
```

Restart Claude Code and test your app as usual. When a page asks for a login, the agent calls `login`, runs the one-time script it gets back in the tab, and continues with the task.

## Links

- Source code: [github.com/olgaysezgin/autologin-mcp](https://github.com/olgaysezgin/autologin-mcp)
- Website: [olgaysezgin.github.io/autologin-mcp](https://olgaysezgin.github.io/autologin-mcp/)
- Machine-readable summary for AI assistants: [llms.txt](https://olgaysezgin.github.io/autologin-mcp/llms.txt) and [llms-full.txt](https://olgaysezgin.github.io/autologin-mcp/llms-full.txt)
- Report a vulnerability: [SECURITY.md](https://github.com/olgaysezgin/autologin-mcp/blob/main/SECURITY.md)
