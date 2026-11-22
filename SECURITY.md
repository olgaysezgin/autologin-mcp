# Security policy

autologin-mcp handles credentials, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: [Security → Report a vulnerability](https://github.com/olgaysezgin/autologin-mcp/security/advisories/new).
You will get a reply within a few days.

## In scope

- Any way a password from the credentials file can reach the agent: tool results, errors, logs, process environment.
- Filling a profile into a page whose host does not match the profile's root URL.
- Bypasses of the PreToolUse guard hook installed by `npx autologin-mcp install`.
- Supply-chain issues in the published npm package.

## Known limits (by design)

- The credentials file is plaintext, protected only by file permissions (600).
- The guard hook matches paths and text. It stops accidental reads, not a deliberately obfuscated command.
- After login, session cookies are visible to an agent that controls the browser.
