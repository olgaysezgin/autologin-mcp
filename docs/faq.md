---
title: FAQ
description: Frequently asked questions about autologin-mcp - letting AI coding agents like Claude Code log in to web apps during testing without sharing passwords with the model.
---

# Frequently asked questions

## How do I let Claude Code log in to my web app without giving it my password?

Install autologin-mcp (`npx autologin-mcp install`) and add a login profile for your app in a normal terminal (`npx autologin-mcp add`). When Claude Code's browser tab shows a login form, Claude calls the `login` tool, and autologin-mcp fills the form with the credentials stored on your machine. Claude only sees the outcome, never the password.

## What happens when my session expires while an AI agent is testing my app?

Without autologin-mcp the agent stops, or asks you for the password. With autologin-mcp it notices the login form, "session expired" message, 401/403 or redirect to a login page, calls `login`, and continues the task where it left off.

## Does the password ever reach the AI model?

No. The password goes from `~/.autologin-mcp/credentials.env` directly into the page, either over a one-time `127.0.0.1` bridge that checks the page's origin, or through the Chrome DevTools Protocol. Tool results are redacted, and a guard hook blocks the agent from reading the credentials file. The agent can see the username and, after login, the session cookies. See the [security model](security.md) for the limits.

## Why not just put the password in the prompt or in a `.env` file in my project?

Everything in the conversation, including files the agent reads, is sent to the model provider and can end up in transcripts, logs and context summaries. A project `.env` can also end up in git. autologin-mcp keeps credentials in one global file outside your projects that the agent is blocked from reading.

## Which agents and browser tools does it work with?

It is built and tested for Claude Code with Claude in Chrome. It also works with Playwright MCP (`browser_evaluate`), chrome-devtools-mcp (`evaluate_script`) and Puppeteer (`page.evaluate`). Other agents such as Codex CLI, Gemini CLI, Cursor, VS Code, Claude Desktop and Hermes Agent can run the server: `npx autologin-mcp print-config --client <name>` prints their configuration. The installer, skill and guard hook are Claude Code features today. See [Agents and browser tools](clients.md).

## Do I need to enable Chrome remote debugging?

No. The default bridge mode needs no browser setup. Remote debugging (`chrome://inspect/#remote-debugging`, Chrome 144+) enables CDP mode, which is useful when the app's Content-Security-Policy blocks the bridge.

## Can a malicious web page trick the agent into sending my credentials to it?

A profile only fills pages whose host matches its root URL. In bridge mode, the check uses the `Origin` header that the browser sets and page scripts cannot fake; in CDP mode, the tab's URL comes from Chrome. A page on another site receives nothing, even if a prompt injection tells the agent to log in there.

## Does it support SSO, OAuth, two-factor authentication or multi-step logins?

Not yet. It handles the common username + password form on the app's own page, including React, Vue and Angular forms. Multi-step logins (username, then password), iframes, SSO login hosts and TOTP codes are on the [roadmap](https://github.com/olgaysezgin/autologin-mcp#roadmap).

## Can I use several accounts for the same app?

Yes. Add one profile per account with the same root URL, for example `admin` and `viewer`. The agent picks one by name, or you tell it which one to use.

## Is it safe to use with production accounts?

Use dedicated test accounts. autologin-mcp prevents accidental exposure of the password, but an agent that controls the browser can use the logged-in session, and the credentials file is plaintext protected by file permissions.

## Does it work on Windows, macOS and Linux?

macOS and Linux are tested in continuous integration. Windows is supported in the code (Chrome profile paths, editor launch) but not tested yet.

## Is it free?

Yes. autologin-mcp is open source under the MIT license.

## How is autologin-mcp different from a password manager?

A password manager fills forms for you, in your browser. autologin-mcp fills forms for an AI agent, at the moment the agent asks, and tells the agent only whether it worked. It is built for automated testing sessions, not for your personal accounts.
