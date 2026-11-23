import { describe, expect, it } from 'vitest';
import { ssoProvider } from '../src/sso.ts';

describe('ssoProvider', () => {
  it('knows the common single sign-on hosts', () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/identifier',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://login.live.com/login.srf',
      'https://contoso.b2clogin.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
      'https://acme.okta.com/oauth2/default/v1/authorize',
      'https://acme.oktapreview.com/login',
      'https://acme.us.auth0.com/u/login',
      'https://acme.onelogin.com/login2',
      'https://appleid.apple.com/auth/authorize',
      'https://acme.auth.eu-west-1.amazoncognito.com/login',
    ]) {
      expect(ssoProvider(url)).toBe(new URL(url).hostname);
    }
  });

  it('leaves other hosts and bad URLs alone', () => {
    for (const url of ['https://staging.example.com/login', 'https://google.com/', 'https://notokta.com/', 'http://localhost:3000/login', 'not a url']) {
      expect(ssoProvider(url)).toBeNull();
    }
  });
});
