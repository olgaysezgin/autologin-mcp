---
title: CLI reference
description: autologin-mcp command-line reference - install, uninstall, add (also with --password-stdin for CI), list, remove, edit and print-config for Codex, Cursor, Gemini CLI, VS Code and Hermes - and exactly what install changes in Claude Code.
---

# CLI reference

```text
npx autologin-mcp                    Run the MCP server on stdio (what Claude Code starts)
npx autologin-mcp install [-y] [--dry-run] [--package <spec>]
npx autologin-mcp uninstall [-y] [--dry-run] [--purge]
npx autologin-mcp add [name] [--url <root-url>] [--username <user>] [-y]
npx autologin-mcp add <name> --url <root-url> --username <user> --password-stdin [-y]
npx autologin-mcp list
npx autologin-mcp remove <name> [-y]
npx autologin-mcp edit
npx autologin-mcp print-config [--client <name>] [--package <spec>]
npx autologin-mcp --version | --help
```

Run `add`, `edit` and `remove` in a normal terminal, never inside an AI chat.

## `install`

Registers autologin-mcp in Claude Code.

| Step | Where |
|---|---|
| MCP server `autologin` at user scope: `claude mcp add --scope user autologin -- npx -y autologin-mcp@<version>` | Claude Code's user configuration |
| The skill that tells the agent when and how to log in | `~/.claude/skills/autologin/SKILL.md` |
| The guard hook script | `~/.claude/hooks/autologin-guard.mjs` |
| A `PreToolUse` hook entry that runs the guard, and `Read(~/.autologin-mcp/**)` / `Edit(~/.autologin-mcp/**)` deny rules | `~/.claude/settings.json` (backed up first to `settings.json.autologin-backup`) |
| An empty credentials file with permissions `600`, if none exists | `~/.autologin-mcp/credentials.env` |

| Flag | Meaning |
|---|---|
| `-y`, `--yes` | Do not ask for confirmation |
| `--dry-run` | Print the changes without applying them |
| `--package <spec>` | What `npx` should run instead of `autologin-mcp@<version>`: a local `.tgz`, a fork, or a git ref. Local paths are turned into `file:` specs. |

`install` pins the exact version, because a tool that handles credentials should not update itself silently. Upgrade with `npx autologin-mcp@latest install`. Running `install` again is safe: it replaces its own entries and leaves your other settings alone.

## `uninstall`

Removes the MCP server, the skill, the hook and the deny rules.

| Flag | Meaning |
|---|---|
| `-y`, `--yes` | Do not ask for confirmation |
| `--dry-run` | Print the changes without applying them |
| `--purge` | Also delete `~/.autologin-mcp`, including your credentials |

## `add`

Adds a profile. If a profile with the same name exists, it asks before replacing it (`-y` replaces it without asking). The password is asked with hidden input, twice.

```bash
npx autologin-mcp add                                   # asks for everything
npx autologin-mcp add staging --url staging.example.com --username qa@example.com
```

### Scripts and CI: `--password-stdin`

With `--password-stdin`, `add` asks nothing: it reads the password from a pipe, like `docker login --password-stdin`. The profile name, `--url` and `--username` are required, one trailing newline is dropped, and an existing profile is replaced only with `-y`.

```bash
printf '%s' "$STAGING_PASSWORD" | npx autologin-mcp add staging \
  --url staging.example.com --username qa@example.com --password-stdin -y
```

- Pipe the password from a secret store or an environment variable, so it never appears in the command line, your shell history or the process list. There is deliberately no `--password <value>` option.
- From a keyboard, `--password-stdin` refuses to run; leave it out to type the password hidden.
- In CI, set `AUTOLOGIN_HOME` to keep the credentials file in a throwaway folder (see [Configuration](configuration.md#environment-variables)).
- Do not let an AI agent run this with a password typed into the chat: the chat is exactly where the password must not go.

## `list`

Prints each profile's name, root URL and username, plus any problems. Passwords are never shown.

## `remove <name>`

Deletes a profile from the credentials file. `-y` skips the confirmation.

## `edit`

Opens the credentials file in `$VISUAL`, `$EDITOR`, or the operating system's default editor, creating it first if needed.

Without a desktop (over SSH, in CI or in a container on Linux) and without `$VISUAL` / `$EDITOR`, it prints the file's path and exits with code 1. Run `EDITOR=nano npx autologin-mcp edit`, or add profiles with `add`.

## `print-config`

Prints the MCP server entry for an agent other than Claude Code, pinned to this version. The configuration goes to stdout, so you can redirect it; where to put it, the client's own add command and notes go to stderr.

```bash
npx autologin-mcp print-config --client hermes
```

| `--client` | Agent | Format |
|---|---|---|
| `json` (default) | Any client with the common `mcpServers` JSON | JSON |
| `claude-desktop` | Claude Desktop | JSON, `claude_desktop_config.json` |
| `cursor` | Cursor | JSON, `~/.cursor/mcp.json` |
| `vscode` | VS Code (GitHub Copilot) | JSON `servers`, `.vscode/mcp.json`, plus a `code --add-mcp` command |
| `gemini` | Gemini CLI | JSON, `~/.gemini/settings.json`, plus a `gemini mcp add` command |
| `codex` | Codex CLI | TOML, `~/.codex/config.toml`, plus a `codex mcp add` command |
| `hermes` | Hermes Agent | YAML, `~/.hermes/config.yaml`, plus a `hermes mcp add` command |

For Claude Code use `install`: it also adds the skill, the guard hook and the deny rules. Those are Claude Code features, so with other agents nothing technically stops the agent from reading `~/.autologin-mcp`; deny that folder in the agent's own permission settings if it has them. See [Agents and browser tools](clients.md).

## Running the server

Without a command, `npx autologin-mcp` runs the MCP server on stdio. MCP clients start it this way; you do not need to run it yourself. The server stops when the client closes stdin, and releases its Chrome connection and bridge port.
