import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserLike } from './browser/adapter.js';
import { selectTarget } from './browser/tabs.js';
import type { BridgeTicket } from './bridge/server.js';
import type { LoginResult, PageLike } from './login/engine.js';
import type { FailureLimiter } from './ratelimit.js';
import { createRedactor } from './redact.js';
import type { CodeStep, ResultLog } from './results.js';
import type { LoadedStore } from './store/envfile.js';
import { hostOf, matchesUrl } from './store/match.js';
import { isUsable, type UsableProfile } from './store/profiles.js';
import { ssoProvider } from './sso.js';
import { secretForms } from './totp.js';

export const ADD_HINT =
  'Ask the user to run "npx autologin-mcp add" in a separate terminal (never in this chat), or call open_config so they can edit the credentials file.';

export const RUN_IN_PAGE_HINT =
  'Run `script` unchanged in the tab that shows the login form, with your browser tool\'s JavaScript evaluation (Claude in Chrome: javascript_tool). ' +
  'Tools that take a function (Playwright MCP browser_evaluate, chrome-devtools-mcp evaluate_script) take `function` instead; ' +
  'tools that evaluate a plain script without top-level await (Puppeteer page.evaluate) take `expression`. ' +
  'The value it returns is the login result (success, submitted, failed, ...). It works once, within the expiry, and only on a page of this profile\'s site. ' +
  'If the call itself fails or returns nothing (the page navigated, the browser tool lost the tab), call `login_status` to get the result the page reported.';

export const INSTRUCTIONS = [
  "autologin-mcp signs the browser tab you are testing into its app with credentials that stay on the user's machine; you never see them.",
  '- When a page under test shows a login form, a "session expired" message, a 401/403, or redirects to a login URL, call `login`, then continue the task. Pass `url` (the tab URL) and, when several accounts exist for the app, `profile`.',
  `- If \`login\` returns \`run_in_page\`: ${RUN_IN_PAGE_HINT} On \`submitted\`, check the page: if it now asks for a one-time code, call \`login\` again; otherwise confirm you are logged in.`,
  '- On `needs_human`, the page wants something only a person can do (single sign-on, a passkey, a captcha, or a second factor the profile has no TOTP secret for): tell the user the hint and do not retry.',
  '- `list_profiles` shows which apps (root URLs) and usernames are configured; `login_status` shows the latest login outcome per profile.',
  '- Never ask the user for a password, never type credentials into a page yourself, never read files under ~/.autologin-mcp, never modify the login script, and do not inspect the login request body in network logs or read password field values.',
  `- If no profile matches: ${ADD_HINT}`,
].join('\n');

export interface BridgeLike {
  issue(profile: UsableProfile): Promise<BridgeTicket>;
}

export interface ServerDeps {
  version: string;
  configFile: string;
  loadStore(): Promise<LoadedStore>;
  getBrowser(): Promise<BrowserLike>;
  /** `codeStep`: whether a page that asks only for a one-time code is a step of a login in progress. */
  login(page: PageLike, profile: UsableProfile, codeStep: CodeStep): Promise<LoginResult>;
  bridge: BridgeLike;
  /** Creates the credentials file if needed and opens it in the user's editor. */
  openConfig(): Promise<{ created: boolean }>;
  limiter: FailureLimiter;
  results: ResultLog;
}

export interface LoginArgs {
  profile?: string;
  url?: string;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A redactor for every secret of every profile: passwords and TOTP secrets (#1). */
const redactorFor = (store: LoadedStore | null) =>
  createRedactor((store?.profiles ?? []).flatMap((p) => [p.password, ...(p.totpSecret === undefined ? [] : secretForms(p.totpSecret))]));

function reply(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError };
}

const rateLimited = (profile: string): LoginResult => ({
  status: 'rate_limited',
  profile,
  hint: 'Several login attempts for this profile failed in the last 5 minutes. Ask the user to check the credentials before trying again.',
});

/** CDP mode: autologin-mcp finds the tab in Chrome and fills it itself. */
async function loginViaCdp(deps: ServerDeps, usable: UsableProfile[], args: LoginArgs): Promise<LoginResult> {
  let browser: BrowserLike;
  try {
    browser = await deps.getBrowser();
  } catch (error) {
    return { status: 'browser_not_connected', hint: message(error) };
  }
  const selection = await selectTarget(browser.targets(), usable, args);
  if (!selection.ok) return selection.result;
  const { page, profile } = selection;
  if (deps.limiter.isBlocked(profile.name)) return rateLimited(profile.name);
  const result = await deps.login(page, profile, deps.results.codeStep(profile.name));
  if (result.status === 'failed' || result.status === 'error') deps.limiter.recordFailure(profile.name);
  const logged = deps.results.record(profile.name, result, 'cdp');
  return logged.previous_login === undefined ? result : { ...result, hint: logged.hint, previous_login: logged.previous_login };
}

/** Bridge mode: picks the profile from the arguments; the page itself proves its origin later. */
function chooseProfile(usable: UsableProfile[], args: LoginArgs): { ok: true; profile: UsableProfile } | { ok: false; result: LoginResult } {
  let candidates = usable;
  if (args.profile) candidates = usable.filter((p) => p.name === args.profile!.toLowerCase());
  if (args.url) {
    const url = args.url;
    candidates = candidates.filter((p) => matchesUrl(p.root, url));
    if (candidates.length === 0) {
      const which = args.profile ? `profile "${args.profile.toLowerCase()}"` : 'any profile';
      return { ok: false, result: { status: 'origin_mismatch', hint: `${hostOf(url)} does not match ${which}. ${ADD_HINT}` } };
    }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      result: {
        status: 'ambiguous_profile',
        hint: 'Several profiles could match; call login again with the tab url, or with one of these profile names.',
        candidates: candidates.map((p) => p.name),
      },
    };
  }
  return { ok: true, profile: candidates[0]! };
}

async function loginViaBridge(deps: ServerDeps, usable: UsableProfile[], args: LoginArgs): Promise<LoginResult> {
  const choice = chooseProfile(usable, args);
  if (!choice.ok) return choice.result;
  const { profile } = choice;
  if (deps.limiter.isBlocked(profile.name)) return rateLimited(profile.name);
  const ticket = await deps.bridge.issue(profile);
  return {
    status: 'run_in_page',
    profile: profile.name,
    hint: RUN_IN_PAGE_HINT,
    expires_in_s: ticket.expiresInSeconds,
    script: ticket.script,
    function: ticket.function,
    expression: ticket.expression,
  };
}

export async function runLogin(deps: ServerDeps, store: LoadedStore, args: LoginArgs): Promise<LoginResult> {
  if (args.profile) {
    const wanted = args.profile.toLowerCase();
    const profile = store.profiles.find((p) => p.name === wanted);
    if (!profile) return { status: 'no_profile', hint: `No profile named "${args.profile}". ${ADD_HINT}`, candidates: store.profiles.map((p) => p.name) };
    if (!isUsable(profile)) return { status: 'invalid_profile', profile: profile.name, hint: profile.problems.join('; ') };
  }
  const usable = store.profiles.filter(isUsable);
  if (usable.length === 0) return { status: 'no_profile', hint: `No usable profile is configured. ${ADD_HINT}` };

  // A tab on a single sign-on provider is not a profile's site, but "add a profile" would be the wrong advice.
  const provider = args.url === undefined || usable.some((p) => matchesUrl(p.root, args.url!)) ? null : ssoProvider(args.url);
  if (provider !== null) {
    return {
      status: 'needs_human',
      url: args.url,
      reason: 'sso',
      hint: `The tab is on ${provider}, a single sign-on provider, so a human has to finish this login. autologin-mcp only fills the app's own username and password form.`,
    };
  }

  const mode = store.settings.mode ?? 'auto';
  if (mode !== 'bridge') {
    const result = await loginViaCdp(deps, usable, args);
    const fallBack = result.status === 'browser_not_connected' || result.status === 'no_matching_tab';
    if (mode === 'cdp' || !fallBack) return result;
  }
  return loginViaBridge(deps, usable, args);
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'autologin', version: deps.version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'list_profiles',
    {
      title: 'List login profiles',
      description:
        'Lists the configured login profiles: name, root URL and username. Passwords are never returned. Use it to pick a `profile` for `login`.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const store = await deps.loadStore();
      const redact = redactorFor(store);
      return reply(
        redact({
          file: store.file,
          profiles: store.profiles.map((p) => ({
            profile: p.name,
            url: p.url,
            username: p.username ?? null,
            ...(p.totp !== undefined ? { totp: true } : {}),
            ...(p.problems.length > 0 ? { problems: p.problems } : {}),
          })),
          ...(store.profiles.length === 0 ? { hint: ADD_HINT } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'login',
    {
      title: 'Log the browser tab in',
      description:
        'Logs the browser tab under test into its app with a locally stored profile, without revealing the credentials. ' +
        'Call it whenever the app shows a login form or the session expired. With Chrome remote debugging it fills the tab itself; ' +
        'otherwise it returns `run_in_page` with a one-time script for you to run in the tab.',
      inputSchema: {
        profile: z.string().optional().describe('Profile name from list_profiles. Needed only when several profiles match.'),
        url: z.string().optional().describe('Current URL of the tab to log in. Recommended; required when several profiles or tabs exist.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      let store: LoadedStore | null = null;
      try {
        store = await deps.loadStore();
        const result = await runLogin(deps, store, args);
        return reply(redactorFor(store)(result), result.status === 'error');
      } catch (error) {
        return reply(redactorFor(store)({ status: 'error', hint: message(error) }), true);
      }
    },
  );

  server.registerTool(
    'login_status',
    {
      title: 'Latest login outcome',
      description:
        'Returns the latest login outcome per profile (as reported by the page in bridge mode). Use it when running the `run_in_page` script failed or returned nothing.',
      inputSchema: { profile: z.string().optional().describe('Only this profile.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const store = await deps.loadStore();
      const results = deps.results.get(args.profile);
      const body = results.length > 0 ? { results } : { results, hint: 'No login result has been reported yet. Run the `run_in_page` script, or call login again.' };
      return reply(redactorFor(store)(body));
    },
  );

  server.registerTool(
    'open_config',
    {
      title: 'Open the credentials file',
      description:
        "Opens the credentials file in the user's text editor so they can add or change profiles themselves. The file content is never returned.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const { created } = await deps.openConfig();
        return reply({
          file: deps.configFile,
          created,
          opened: true,
          note: "The file is open in the user's editor. Ask them to add or edit profiles there and save. Do not read this file.",
        });
      } catch (error) {
        // No desktop (SSH, CI, a container) is a normal situation, not a tool error: tell the agent where the file is.
        return reply({
          file: deps.configFile,
          opened: false,
          hint:
            `Could not open an editor here (${message(error)}). Ask the user to run "npx autologin-mcp add" in a separate terminal (never in this chat), ` +
            'or to open this file in a text editor there. Do not read this file.',
        });
      }
    },
  );

  return server;
}
