---
title: CLI reference
description: autologin-mcp command-line reference - install, uninstall, add, list, remove and edit - and exactly what install changes in Claude Code.
---

# CLI reference

```text
npx autologin-mcp                    Run the MCP server on stdio (what Claude Code starts)
npx autologin-mcp install [-y] [--dry-run] [--package <spec>]
npx autologin-mcp uninstall [-y] [--dry-run] [--purge]
npx autologin-mcp add [name] [--url <root-url>] [--username <user>]
npx autologin-mcp list
npx autologin-mcp remove <name> [-y]
npx autologin-mcp edit
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

Adds a profile. If a profile with the same name exists, it asks before replacing it. The password is asked with hidden input, twice.

```bash
npx autologin-mcp add                                   # asks for everything
npx autologin-mcp add staging --url staging.example.com --username qa@example.com
```

## `list`

Prints each profile's name, root URL and username, plus any problems. Passwords are never shown.

## `remove <name>`

Deletes a profile from the credentials file. `-y` skips the confirmation.

## `edit`

Opens the credentials file in `$VISUAL`, `$EDITOR`, or the operating system's default editor, creating it first if needed.

## Running the server

Without a command, `npx autologin-mcp` runs the MCP server on stdio. MCP clients start it this way; you do not need to run it yourself. The server stops when the client closes stdin, and releases its Chrome connection and bridge port.
