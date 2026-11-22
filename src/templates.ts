export const ENV_TEMPLATE = `# autologin-mcp credentials
# This file stays on your machine: never commit it, never paste it into a chat.
# Keep its permissions at 600 (owner read/write only).
#
# A profile is a group of keys that share a prefix:
#   <PROFILE>_URL        root URL only: example.com, staging.example.com, localhost:3000, *.example.com
#   <PROFILE>_USERNAME
#   <PROFILE>_PASSWORD   wrap the value in single quotes if it contains spaces or #
# Optional, only when the login form is not detected automatically (CSS selectors):
#   <PROFILE>_USERNAME_SELECTOR, <PROFILE>_PASSWORD_SELECTOR, <PROFILE>_SUBMIT_SELECTOR
#   <PROFILE>_SUCCESS_SELECTOR   an element that only exists after a successful login
#
# Example:
# STAGING_URL=staging.example.com
# STAGING_USERNAME=qa-admin@example.com
# STAGING_PASSWORD='change-me'
#
# Settings:
# AUTOLOGIN_MODE=auto    # auto (default): CDP if Chrome remote debugging is on, else the in-page bridge; or bridge / cdp
# AUTOLOGIN_CDP_URL=http://127.0.0.1:9222   # use a Chrome started with --remote-debugging-port instead of auto-connect

`;

export const SKILL_MD = `---
name: autologin
description: Sign the browser tab under test back into its app without ever seeing the credentials. Use when a page you are testing shows a login form, a "session expired" message, a 401/403, or redirects to a login URL.
---

# autologin-mcp

Credentials for the apps under test live in a file on the user's machine and never enter this conversation.
The \`autologin\` MCP server fills the login form for you and only tells you the outcome.

## When the app asks you to log in

1. Call \`mcp__autologin__login\` with \`url\` = the tab's current URL. Pass \`profile\` when there are several accounts for the same app (see \`mcp__autologin__list_profiles\`).
2. \`run_in_page\`: run the returned \`script\` **unchanged** in that tab with your JavaScript tool (Claude in Chrome: \`javascript_tool\`; Playwright MCP \`browser_evaluate\` / chrome-devtools-mcp \`evaluate_script\`: pass \`function\`). Its return value is the login result below. It contains a one-time URL, never a password. If that call fails or returns nothing (the page navigated, the browser tool lost the tab), call \`mcp__autologin__login_status\` to get the result the page reported.
3. \`success\`: continue the task where you left off. \`submitted\`: the page navigated; take a look to confirm you are logged in.
4. \`failed\`: tell the user the \`hint\`; do not retry more than once.
   \`no_login_form\`: the page has no login form. If it carries \`previous_login\` with \`success\` or \`submitted\`, your earlier login went through: continue the task.
5. \`no_profile\` / \`origin_mismatch\`: ask the user to run \`npx autologin-mcp add\` in a separate terminal (never in this chat), or call \`mcp__autologin__open_config\` so they can edit the file.
6. \`browser_not_connected\` (only with AUTOLOGIN_MODE=cdp): ask the user to enable chrome://inspect/#remote-debugging in Chrome.

## Never

- Ask the user for a password, or accept one pasted into the chat.
- Type credentials into a page yourself.
- Read, grep or cat anything under ~/.autologin-mcp (a hook blocks it).
- Modify the login script, read password field values, or inspect the login request body in network logs.
`;
