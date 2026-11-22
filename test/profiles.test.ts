import { describe, expect, it } from 'vitest';
import { buildStore, isUsable, parseBoolean, splitKey } from '../src/store/profiles.ts';

describe('splitKey', () => {
  it.each([
    ['STAGING_URL', 'STAGING', 'URL'],
    ['staging_password', 'STAGING', 'PASSWORD'],
    ['STAGING_ADMIN_USERNAME', 'STAGING_ADMIN', 'USERNAME'],
    ['APP_USERNAME_SELECTOR', 'APP', 'USERNAME_SELECTOR'],
    ['MY_USERNAME_URL', 'MY_USERNAME', 'URL'],
    ['A_PASSWORD_PASSWORD', 'A_PASSWORD', 'PASSWORD'],
  ])('%s → %s + %s', (key, prefix, suffix) => {
    expect(splitKey(key)).toEqual({ prefix, suffix });
  });

  it.each(['URL', 'STAGING', 'STAGING_HOST', '_URL', 'X-Y_URL'])('rejects %s', (key) => {
    expect(splitKey(key)).toBeNull();
  });
});

describe('parseBoolean', () => {
  it.each([
    ['true', true],
    [' YES ', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['No', false],
    ['0', false],
    ['off', false],
    ['maybe', null],
  ])('%j → %j', (input, expected) => {
    expect(parseBoolean(input)).toBe(expected);
  });
});

describe('buildStore', () => {
  it('groups keys into profiles in file order, with selectors and auto-login', () => {
    const store = buildStore({
      STAGING_URL: 'https://staging.example.com/login',
      STAGING_USERNAME: 'qa@example.com',
      STAGING_PASSWORD: 'secret',
      STAGING_AUTO_LOGIN: 'yes',
      STAGING_USERNAME_SELECTOR: ' #email ',
      STAGING_PASSWORD_SELECTOR: '',
      STAGING_SUBMIT_SELECTOR: 'button.go',
      STAGING_SUCCESS_SELECTOR: '[data-test=menu]',
      local_url: 'localhost:3000',
      local_username: 'admin',
      local_password: 'admin',
    });
    expect(store.profiles.map((p) => p.name)).toEqual(['staging', 'local']);
    const [staging, local] = store.profiles;
    expect(staging).toMatchObject({
      key: 'STAGING',
      url: 'staging.example.com',
      root: { host: 'staging.example.com', port: null, wildcard: false },
      username: 'qa@example.com',
      password: 'secret',
      autoLogin: true,
      selectors: { username: '#email', password: undefined, submit: 'button.go', success: '[data-test=menu]' },
      problems: [],
    });
    expect(local).toMatchObject({ url: 'localhost:3000', autoLogin: null, problems: [] });
    expect(isUsable(staging!)).toBe(true);
    expect(store.warnings).toEqual([]);
  });

  it('reports what is wrong with incomplete profiles', () => {
    const store = buildStore({ A_USERNAME: '', B_URL: 'bad host!', B_USERNAME: 'u', B_PASSWORD: 'p', B_AUTO_LOGIN: 'sometimes' });
    const [a, b] = store.profiles;
    expect(a!.problems).toEqual(['A_URL is missing', 'A_USERNAME is missing', 'A_PASSWORD is missing']);
    expect(a).toMatchObject({ username: undefined, password: undefined, root: null, url: '' });
    expect(b!.problems).toEqual(['B_URL: Invalid URL "bad host!"', 'B_AUTO_LOGIN must be true or false']);
    expect(isUsable(a!)).toBe(false);
  });

  it('reads settings and warns about unknown keys', () => {
    const store = buildStore({ AUTOLOGIN_CDP_URL: ' http://127.0.0.1:9222 ', AUTOLOGIN_COLOR: 'red', RANDOM: 'x' });
    expect(store.settings).toEqual({ cdpUrl: 'http://127.0.0.1:9222' });
    expect(store.profiles).toEqual([]);
    expect(store.warnings).toEqual([expect.stringContaining('Unknown setting AUTOLOGIN_COLOR'), expect.stringContaining('Ignoring RANDOM')]);
    expect(buildStore({ AUTOLOGIN_CDP_URL: '  ' }).settings.cdpUrl).toBeUndefined();
  });

  it('reads the login mode', () => {
    expect(buildStore({ AUTOLOGIN_MODE: ' Bridge ' }).settings.mode).toBe('bridge');
    expect(buildStore({ autologin_mode: 'cdp' }).settings.mode).toBe('cdp');
    const bad = buildStore({ AUTOLOGIN_MODE: 'magic' });
    expect(bad.settings.mode).toBeUndefined();
    expect(bad.warnings).toEqual(['AUTOLOGIN_MODE must be one of auto, bridge, cdp; using auto']);
  });
});
