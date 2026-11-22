# Changelog

Every version below is the same version in `package.json`, the git tag `v<version>`, the npm package and the GitHub release. The release workflow refuses to publish when they disagree.

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
