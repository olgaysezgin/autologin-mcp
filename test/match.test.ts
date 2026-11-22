import { describe, expect, it } from 'vitest';
import { hostOf, matchesUrl, parseRootUrl, type RootUrl } from '../src/store/match.ts';

const root = (input: string): RootUrl => {
  const parsed = parseRootUrl(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.root;
};

describe('parseRootUrl', () => {
  it.each([
    ['example.com', 'example.com', false],
    ['https://Example.com/', 'example.com', false],
    ['http://example.com/login?next=1', 'example.com', true],
    ['localhost:3000', 'localhost:3000', false],
    ['*.example.com', '*.example.com', false],
    ['example.com:443', 'example.com:443', false],
    ['example.com:80', 'example.com', false],
    ['[::1]:8080', '[::1]:8080', false],
    ['  staging.example.com#top ', 'staging.example.com', true],
  ])('normalizes %j to %j', (input, normalized, strippedPath) => {
    expect(parseRootUrl(input)).toMatchObject({ ok: true, normalized, strippedPath });
  });

  it.each([
    ['', 'URL is empty'],
    ['   ', 'URL is empty'],
    ['http://', 'Invalid URL'],
    ['exa mple.com', 'Invalid URL'],
    ['user:secret@example.com', 'must not contain a username or password'],
    ['foo_bar.com', 'Invalid host'],
    ['example.com.', 'Invalid host'],
  ])('rejects %j', (input, error) => {
    const parsed = parseRootUrl(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(error);
  });
});

describe('matchesUrl', () => {
  it.each([
    ['example.com', 'https://example.com/app', true],
    ['example.com', 'http://www.example.com/', true],
    ['example.com', 'https://api.example.com/', false],
    ['*.example.com', 'https://api.example.com/', true],
    ['*.example.com', 'https://example.com/', true],
    ['example.com', 'https://example.com:8443/', false],
    ['example.com:8443', 'https://example.com:8443/', true],
    ['example.com:443', 'https://example.com/', true],
    ['example.com:443', 'http://example.com/', false],
    ['localhost:3000', 'http://127.0.0.1:3000/login', true],
    ['localhost:3000', 'http://[::1]:3000/', true],
    ['localhost:3000', 'http://localhost:3001/', false],
    ['127.0.0.1:3000', 'http://example.com:3000/', false],
    ['example.com', 'ftp://example.com/', false],
    ['example.com', 'chrome://newtab/', false],
    ['example.com', 'not a url', false],
    ['example.com', 'https://evil-example.com/', false],
    ['example.com', 'https://example.com.evil.com/', false],
  ])('%s vs %s → %s', (rootUrl, pageUrl, expected) => {
    expect(matchesUrl(root(rootUrl), pageUrl)).toBe(expected);
  });
});

describe('hostOf', () => {
  it('returns the host, or the input when it is not a URL', () => {
    expect(hostOf('http://localhost:3000/x')).toBe('localhost:3000');
    expect(hostOf('nope')).toBe('nope');
  });
});
