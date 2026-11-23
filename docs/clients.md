---
title: Agents and browser tools
description: Use autologin-mcp with Claude Code and Claude in Chrome, Playwright MCP, chrome-devtools-mcp or Puppeteer, and register it in Codex CLI, Gemini CLI, Cursor, VS Code, Claude Desktop or Hermes Agent with print-config.
---

# Agents and browser tools

autologin-mcp does not drive the browser for your tests. The agent keeps using the browser tool it already has; autologin-mcp only handles the login. Two things matter:

1. **The agent** must be an MCP client, so it can call `login`.
2. **The browser tool** must be able to run JavaScript in the tab (bridge mode), or the tab must live in a Chrome that autologin-mcp can reach over CDP (CDP mode).

## Claude Code + Claude in Chrome

This is the primary setup, tested end to end on real apps.

- `npx autologin-mcp install` registers everything: MCP server, skill and guard hook.
- In bridge mode the agent runs the `script` field with `javascript_tool`.
- Some Chrome profiles have extensions (typically password managers) that take over the tab right after a login form is submitted. `javascript_tool` then fails with `Cannot access a chrome-extension:// URL of different extension` or `Detached while handling command`. The login still runs; the server's instructions tell the agent to call `login_status` to get the outcome.

## Claude Code + Playwright MCP

- Bridge mode: the agent passes the `function` field to `browser_evaluate`.
- CDP mode with a shared browser: start Chrome with `--remote-debugging-port=9222`, run Playwright MCP with `--cdp-endpoint http://127.0.0.1:9222`, and set `AUTOLOGIN_CDP_URL=http://127.0.0.1:9222` in the credentials file. autologin-mcp then fills the tab Playwright MCP is testing.

## Claude Code + chrome-devtools-mcp

- Bridge mode: the agent passes the `function` field to `evaluate_script`.
- CDP mode with a shared browser: run chrome-devtools-mcp with `--browserUrl http://127.0.0.1:9222` against the same Chrome as above.

## Puppeteer and tools built on it

- Bridge mode: pass the `expression` field to `page.evaluate` (or to a tool that calls it, such as a Puppeteer MCP server's evaluate tool). `page.evaluate` has no top-level `await`, so the `script` field fails there with `await is not defined`, and the `function` field as a string only returns the function without calling it.
- CDP mode with a shared browser: `puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })` with `AUTOLOGIN_CDP_URL` set to the same address.

## Other MCP clients

The server itself is a standard stdio MCP server, so other agents can start it. `print-config` prints the entry for yours, pinned to the installed version:

```bash
npx autologin-mcp print-config --client codex     # json (default), claude-desktop, cursor, vscode, gemini, codex, hermes
```

| Agent | Where the entry goes | Or run |
|---|---|---|
| Codex CLI | `~/.codex/config.toml` | `codex mcp add autologin -- npx -y autologin-mcp@1.2.0` |
| Gemini CLI | `~/.gemini/settings.json` | `gemini mcp add -s user autologin npx -- -y autologin-mcp@1.2.0` |
| Hermes Agent | `~/.hermes/config.yaml` (`mcp_servers:`) | `hermes mcp add autologin --command npx --args -y autologin-mcp@1.2.0` |
| VS Code (GitHub Copilot) | `.vscode/mcp.json` or the user `mcp.json` (`servers`) | `code --add-mcp '{"name":"autologin","type":"stdio","command":"npx","args":["-y","autologin-mcp@1.2.0"]}'` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | |
| Claude Desktop | `claude_desktop_config.json` (Settings > Developer > Edit Config) | |

Most of them use the common `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "autologin": { "command": "npx", "args": ["-y", "autologin-mcp@1.2.0"] }
  }
}
```

Then add profiles with `npx autologin-mcp add`. Keep in mind:

- The `install` command, the skill and the guard hook are for Claude Code only. Other agents get the server's built-in instructions, but nothing enforces them. Deny `~/.autologin-mcp` in your agent's permission settings, if it has them.
- Agents other than Claude Code are not tested yet. Reports and pull requests are welcome.

## Browsers

- **Google Chrome** is supported and tested in both modes. Other Chromium-based browsers should work the same way.
- **Bridge mode** only needs the agent's tool to run the loader script in the page. Chrome may ask once per public site to allow access to "apps and services on this device" (Local Network Access); allow it for your test sites. Other browser engines are not tested yet.
- **CDP mode** needs Chrome with remote debugging: `chrome://inspect/#remote-debugging` (Chrome 144+) or `--remote-debugging-port`.
