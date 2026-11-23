/**
 * Hosts of single sign-on providers. A tab on one of them shows a login that a person has to finish:
 * autologin-mcp only fills the app's own username and password form (#2).
 */
const SSO_HOSTS: RegExp[] = [
  /^accounts\.google\.com$/,
  /^login\.(microsoftonline|microsoft|live)\.com$/,
  /^login\.microsoftonline\.us$/,
  /\.b2clogin\.com$/,
  /\.okta(preview|-emea)?\.com$/,
  /\.auth0\.com$/,
  /\.onelogin\.com$/,
  /^appleid\.apple\.com$/,
  /\.amazoncognito\.com$/,
  /\.pingone\.(com|eu|asia|ca)$/,
  /\.duosecurity\.com$/,
  /\.jumpcloud\.com$/,
];

/** The host of `pageUrl` when it belongs to a known single sign-on provider, else null. */
export function ssoProvider(pageUrl: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  return SSO_HOSTS.some((pattern) => pattern.test(host)) ? host : null;
}
