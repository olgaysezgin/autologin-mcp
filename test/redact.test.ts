import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED } from '../src/redact.ts';

describe('createRedactor', () => {
  const redact = createRedactor(['s3cret pass', undefined, '', 'cret']);

  it('scrubs secrets and their URL-encoded form from every string, longest first', () => {
    const input = {
      hint: 'Login failed for s3cret pass',
      url: 'https://x.test/?p=s3cret%20pass',
      nested: { list: ['a cret b', 1, null, true] },
    };
    expect(redact(input)).toEqual({
      hint: `Login failed for ${REDACTED}`,
      url: `https://x.test/?p=${REDACTED}`,
      nested: { list: [`a ${REDACTED} b`, 1, null, true] },
    });
  });

  it('keeps enum fields and non-string values untouched', () => {
    expect(redact({ status: 'cret', reason: 'cret', count: 2 })).toEqual({ status: 'cret', reason: 'cret', count: 2 });
    expect(redact('plain cret')).toBe(`plain ${REDACTED}`);
    expect(redact(42)).toBe(42);
  });

  it('is a no-op without secrets', () => {
    expect(createRedactor([])({ hint: 'anything' })).toEqual({ hint: 'anything' });
  });
});
