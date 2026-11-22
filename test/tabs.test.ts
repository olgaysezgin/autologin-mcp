import { describe, expect, it } from 'vitest';
import type { TargetLike } from '../src/browser/adapter.ts';
import { selectTarget } from '../src/browser/tabs.ts';
import type { PageLike } from '../src/login/engine.ts';
import { buildStore, isUsable, type UsableProfile } from '../src/store/profiles.ts';

function profiles(vars: Record<string, string>): UsableProfile[] {
  return buildStore(vars).profiles.filter(isUsable);
}

const app = profiles({ APP_URL: 'app.test', APP_USERNAME: 'u', APP_PASSWORD: 'p' });
const two = profiles({
  ADMIN_URL: 'app.test',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'p1',
  VIEWER_URL: 'app.test',
  VIEWER_USERNAME: 'viewer',
  VIEWER_PASSWORD: 'p2',
});

interface TabOptions {
  type?: string;
  password?: boolean | 'throw';
  page?: null;
}

function tab(url: string, options: TabOptions = {}): TargetLike {
  const page: PageLike = {
    url: () => url,
    run: async <T>() => {
      if (options.password === 'throw') throw new Error('detached');
      return { passwordVisible: options.password === true } as T;
    },
    element: async () => null,
    insertText: async () => undefined,
    press: async () => undefined,
    bringToFront: async () => undefined,
  };
  return { type: () => options.type ?? 'page', url: () => url, page: async () => (options.page === null ? null : page) };
}

describe('selectTarget', () => {
  it('picks the only tab that matches a profile, ignoring other targets', async () => {
    const targets = [tab('https://app.test/login'), tab('https://other.test/'), tab('chrome://newtab/'), tab('https://app.test/sw.js', { type: 'service_worker' })];
    const selection = await selectTarget(targets, app, {});
    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.profile.name).toBe('app');
      expect(selection.page.url()).toBe('https://app.test/login');
    }
  });

  it('finds the tab by url (ignoring the hash, then by prefix)', async () => {
    const targets = [tab('https://app.test/login#x'), tab('https://app.test/home')];
    expect((await selectTarget(targets, app, { url: 'https://app.test/login' })).ok).toBe(true);
    expect((await selectTarget(targets, app, { url: 'https://app.test/ho' })).ok).toBe(true);
  });

  it('reports a url that is not open', async () => {
    const selection = await selectTarget([tab('https://app.test/a')], app, { url: 'https://app.test/zzz' });
    expect(selection).toEqual({
      ok: false,
      result: { status: 'no_matching_tab', hint: 'No open tab has the URL https://app.test/zzz.', candidates: ['https://app.test/a'] },
    });
  });

  it('refuses to use a profile on a host it does not belong to', async () => {
    const targets = [tab('https://evil.test/login')];
    expect(await selectTarget(targets, app, { url: 'https://evil.test/login' })).toMatchObject({
      ok: false,
      result: { status: 'origin_mismatch', hint: expect.stringContaining('evil.test does not match any profile') },
    });
    expect(await selectTarget(targets, app, { url: 'https://evil.test/login', profile: 'APP' })).toMatchObject({
      result: { status: 'origin_mismatch', hint: expect.stringContaining('does not match profile "app"') },
    });
  });

  it('reports when no open tab matches', async () => {
    const targets = [tab('https://other.test/')];
    expect(await selectTarget(targets, app, {})).toMatchObject({ result: { status: 'no_matching_tab', hint: 'No open tab matches any profile.' } });
    expect(await selectTarget(targets, app, { profile: 'app' })).toMatchObject({ result: { hint: 'No open tab matches profile "app" (app.test).' } });
    expect(await selectTarget(targets, app, { profile: 'ghost' })).toMatchObject({ result: { hint: 'No open tab matches profile "ghost" (unknown).' } });
  });

  it('prefers the one matching tab that shows a login form', async () => {
    const targets = [tab('https://app.test/a'), tab('https://app.test/b', { password: true }), tab('https://app.test/c', { password: 'throw' }), tab('https://app.test/d', { page: null })];
    const selection = await selectTarget(targets, app, {});
    expect(selection.ok && selection.page.url()).toBe('https://app.test/b');
  });

  it('asks for the url when several tabs are equally plausible', async () => {
    const none = [tab('https://app.test/a'), tab('https://app.test/b')];
    expect(await selectTarget(none, app, {})).toMatchObject({ result: { status: 'ambiguous_tab', candidates: ['https://app.test/a', 'https://app.test/b'] } });
    const both = [tab('https://app.test/a', { password: true }), tab('https://app.test/b', { password: true }), tab('https://app.test/c')];
    expect(await selectTarget(both, app, {})).toMatchObject({ result: { candidates: ['https://app.test/a', 'https://app.test/b'] } });
  });

  it('caps the candidate list', async () => {
    const many = Array.from({ length: 15 }, (_, i) => tab(`https://other.test/${i}`));
    const selection = await selectTarget(many, app, {});
    expect(!selection.ok && selection.result.candidates).toHaveLength(10);
  });

  it('asks for a profile when several match the tab, and accepts one by name', async () => {
    const targets = [tab('https://app.test/login')];
    expect(await selectTarget(targets, two, {})).toMatchObject({ result: { status: 'ambiguous_profile', candidates: ['admin', 'viewer'] } });
    const selection = await selectTarget(targets, two, { profile: 'Viewer' });
    expect(selection.ok && selection.profile.username).toBe('viewer');
  });

  it('reports a tab that closed in the meantime', async () => {
    const selection = await selectTarget([tab('https://app.test/login', { page: null })], app, {});
    expect(selection).toMatchObject({ result: { status: 'no_matching_tab', hint: 'The tab https://app.test/login is no longer available.' } });
  });
});
