export interface PreviousLogin {
  status: string;
  at: string;
  url?: string;
}

export interface LoggedResult {
  profile: string;
  status: string;
  hint?: string;
  url?: string;
  /** On `no_login_form`: the profile's recent real login outcome, which usually explains why there is no form. */
  previous_login?: PreviousLogin;
  via: 'bridge' | 'cdp';
  at: string;
}

/** What `no_login_form` adds for an agent that logs in again although its previous login already went through. */
export interface NoFormContext {
  previous_login: PreviousLogin;
  hint?: string;
}

/** How long a login outcome counts as "previous" for a later `no_login_form`. */
export const RECENT_MS = 5 * 60_000;

const WENT_THROUGH = new Set(['success', 'submitted']);

export function alreadyLoggedInHint(previous: PreviousLogin): string {
  return (
    `No login form on this page, and the previous login for this profile (${previous.status} at ${previous.at}) went through: ` +
    'the tab is most likely already logged in. Look at the page and continue; call login again only if it shows a login form.'
  );
}

/**
 * Latest login outcome per profile. In bridge mode the page reports its result to autologin-mcp,
 * so the agent can still learn it when its own JavaScript call was cut off (navigation, lost tab).
 */
export class ResultLog {
  private readonly latest = new Map<string, LoggedResult>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Context for a `no_login_form` outcome: the profile's latest real login outcome (not an earlier
   * `no_login_form`) when it is recent. An agent whose result was cut off often just logs in again.
   */
  noFormContext(profile: string): NoFormContext | null {
    const latest = this.latest.get(profile);
    const previous: PreviousLogin | undefined =
      latest?.status === 'no_login_form'
        ? latest.previous_login
        : latest && { status: latest.status, at: latest.at, ...(latest.url === undefined ? {} : { url: latest.url }) };
    if (previous === undefined || this.now() - Date.parse(previous.at) > RECENT_MS) return null;
    return WENT_THROUGH.has(previous.status) ? { previous_login: previous, hint: alreadyLoggedInHint(previous) } : { previous_login: previous };
  }

  record(profile: string, result: { status: string; hint?: string; url?: string }, via: LoggedResult['via']): LoggedResult {
    const context = result.status === 'no_login_form' ? this.noFormContext(profile) : null;
    const hint = context?.hint ?? result.hint;
    const entry: LoggedResult = {
      profile,
      status: result.status,
      ...(hint === undefined ? {} : { hint }),
      ...(result.url === undefined ? {} : { url: result.url }),
      ...(context === null ? {} : { previous_login: context.previous_login }),
      via,
      at: new Date(this.now()).toISOString(),
    };
    this.latest.set(profile, entry);
    return entry;
  }

  get(profile?: string): LoggedResult[] {
    const all = [...this.latest.values()];
    return profile === undefined ? all : all.filter((r) => r.profile === profile.toLowerCase());
  }
}
