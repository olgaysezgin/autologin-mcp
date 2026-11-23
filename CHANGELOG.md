# Changelog

Every version below is the same version in `package.json`, the git tag `v<version>`, the npm package and the GitHub release. The release workflow refuses to publish when they disagree.

## 1.1.0 - 2026-11-23

- Bridge mode: `run_in_page` also returns `expression`, the loader as a Promise expression without top-level `await`, for tools that evaluate a plain script such as Puppeteer's `page.evaluate`. There, `script` failed with "await is not defined".
- `add --password-stdin` reads the password from a pipe and asks nothing, for scripts and CI (`printf '%s' "$PASSWORD" | npx autologin-mcp add staging --url … --username … --password-stdin -y`). `-y` now also replaces an existing profile without asking in the interactive `add`. A `--password <value>` option is refused, since it would leave the password in the shell history.
- `print-config [--client json|claude-desktop|cursor|vscode|gemini|codex|hermes]` prints the MCP server entry for agents other than Claude Code, with their own add command where they have one, and a note that the guard hook is Claude Code only.
- `open_config` and `edit` no longer report an editor as opened when there is no desktop (SSH, CI, Linux containers) or the opener fails right away. `open_config` then returns `opened: false` with the file's path; `edit` prints the path and exits with code 1.

## 1.0.1 - 2026-11-22

- README: an animated demo of Claude Code logging in with autologin-mcp, npm download and Node.js badges, and a feature overview.
- Releases: `scripts/release.mjs` keeps `package.json`, git tags, npm, `CHANGELOG.md`, the docs and the website on one version. Only the release workflow can publish, and every release gets a GitHub release with its changelog section.

## 1.0.0 - 2026-11-22

First release.

- MCP tools `list_profiles`, `login`, `login_status` and `open_config`.
- Bridge mode with no browser setup: a one-time script with a 60-second `127.0.0.1` URL; credentials are released only to the profile's origin.
- CDP mode through Chrome remote debugging (`chrome://inspect/#remote-debugging` auto-connect or `AUTOLOGIN_CDP_URL`).
- Form detection for React, Vue and Angular forms, outcome detection with the page's own error message, and `previous_login` context when a page has no login form.
- CLI: `install`, `uninstall`, `add`, `list`, `remove` and `edit`, with a global credentials file outside your projects.
- Claude Code skill, PreToolUse guard hook and deny rules that keep the agent away from the credentials folder.
- Redacted tool results and a limit of three failed logins per five minutes per profile.
