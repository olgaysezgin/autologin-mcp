import type { StateResult } from '../inpage.js';
import type { LoginResult, LoginStatus, PageLike } from '../login/engine.js';
import { hostOf, matchesUrl } from '../store/match.js';
import type { UsableProfile } from '../store/profiles.js';
import type { TargetLike } from './adapter.js';

export interface SelectArgs {
  profile?: string;
  url?: string;
}

export type Selection = { ok: true; page: PageLike; profile: UsableProfile } | { ok: false; result: LoginResult };

const MAX_CANDIDATES = 10;
const stripHash = (url: string): string => url.split('#')[0]!;

function fail(status: LoginStatus, hint: string, candidates?: string[]): Selection {
  return { ok: false, result: { status, hint, ...(candidates ? { candidates: candidates.slice(0, MAX_CANDIDATES) } : {}) } };
}

async function showsPassword(tab: TargetLike): Promise<boolean> {
  try {
    const page = await tab.page();
    return page !== null && (await page.run<StateResult>('state', {})).passwordVisible;
  } catch {
    return false;
  }
}

/**
 * Picks the tab to log in and the profile to use. The tab URL comes from Chrome itself,
 * so a profile is only ever used on a page whose host matches the profile's root URL.
 */
export async function selectTarget(targets: TargetLike[], profiles: UsableProfile[], args: SelectArgs): Promise<Selection> {
  let tabs = targets.filter((t) => t.type() === 'page' && /^https?:\/\//i.test(t.url()));

  if (args.url) {
    const wanted = args.url;
    const exact = tabs.filter((t) => stripHash(t.url()) === stripHash(wanted));
    const matched = exact.length > 0 ? exact : tabs.filter((t) => t.url().startsWith(wanted));
    if (matched.length === 0) return fail('no_matching_tab', `No open tab has the URL ${wanted}.`, tabs.map((t) => t.url()));
    tabs = matched;
  }

  const wantedProfile = args.profile?.toLowerCase();
  const pool = wantedProfile ? profiles.filter((p) => p.name === wantedProfile) : profiles;
  const matching = tabs
    .map((tab) => ({ tab, profiles: pool.filter((p) => matchesUrl(p.root, tab.url())) }))
    .filter((entry) => entry.profiles.length > 0);

  if (matching.length === 0) {
    if (args.url) {
      const which = wantedProfile ? `profile "${wantedProfile}"` : 'any profile';
      return fail('origin_mismatch', `${hostOf(tabs[0]!.url())} does not match ${which}. Ask the user to add a profile with "npx autologin-mcp add".`);
    }
    const which = wantedProfile ? `profile "${wantedProfile}" (${pool[0]?.url ?? 'unknown'})` : 'any profile';
    return fail('no_matching_tab', `No open tab matches ${which}.`, tabs.map((t) => t.url()));
  }

  let chosen = matching;
  if (chosen.length > 1) {
    const withForm: typeof matching = [];
    for (const entry of chosen) if (await showsPassword(entry.tab)) withForm.push(entry);
    if (withForm.length !== 1) {
      const list = withForm.length > 1 ? withForm : chosen;
      return fail('ambiguous_tab', 'Several open tabs match; call login again with the exact url of the tab to sign in.', list.map((e) => e.tab.url()));
    }
    chosen = withForm;
  }

  const { tab, profiles: candidates } = chosen[0]!;
  if (candidates.length > 1) {
    return fail(
      'ambiguous_profile',
      `Several profiles match ${hostOf(tab.url())}; call login again with one of these profile names.`,
      candidates.map((p) => p.name),
    );
  }
  const page = await tab.page();
  if (page === null) return fail('no_matching_tab', `The tab ${tab.url()} is no longer available.`);
  return { ok: true, page, profile: candidates[0]! };
}
