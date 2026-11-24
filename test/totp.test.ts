import { describe, expect, it } from 'vitest';
import { base32Decode, freshTotpCode, parseTotpSecret, secretForms, totpCode, TOTP_MIN_REMAINING_MS, type TotpConfig } from '../src/totp.ts';

const ascii = (text: string) => Buffer.from(text, 'ascii');
const config = (key: Buffer, algorithm: TotpConfig['algorithm'], digits = 8): TotpConfig => ({ key, algorithm, digits, period: 30 });

/** RFC 6238 appendix B. */
const VECTORS: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];
const SHA1_KEY = ascii('12345678901234567890');
const SHA256_KEY = ascii('12345678901234567890123456789012');
const SHA512_KEY = ascii('1234567890123456789012345678901234567890123456789012345678901234');
/** SHA1_KEY in base32, as an authenticator app would show it. */
const SHA1_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode', () => {
  it.each(VECTORS)('matches the RFC 6238 test vectors at T=%i', (seconds, sha1, sha256, sha512) => {
    expect(totpCode(config(SHA1_KEY, 'SHA1'), seconds * 1000)).toBe(sha1);
    expect(totpCode(config(SHA256_KEY, 'SHA256'), seconds * 1000)).toBe(sha256);
    expect(totpCode(config(SHA512_KEY, 'SHA512'), seconds * 1000)).toBe(sha512);
  });

  it('keeps the last digits for shorter codes, with leading zeros', () => {
    expect(totpCode(config(SHA1_KEY, 'SHA1', 6), 59_000)).toBe('287082');
    expect(totpCode(config(SHA1_KEY, 'SHA1', 6), 1111111109_000)).toBe('081804');
  });

  it('changes only at a step boundary', () => {
    const c = config(SHA1_KEY, 'SHA1', 6);
    expect(totpCode(c, 30_000)).toBe(totpCode(c, 59_999));
    expect(totpCode(c, 59_999)).not.toBe(totpCode(c, 60_000));
  });
});

describe('base32Decode', () => {
  it('reads what authenticator apps show: any case, spaces, dashes and padding', () => {
    expect(base32Decode(SHA1_BASE32)).toEqual(SHA1_KEY);
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq')).toEqual(SHA1_KEY);
    expect(base32Decode('MZXW6===')).toEqual(ascii('foo'));
  });

  it('rejects empty input and characters outside the alphabet', () => {
    expect(base32Decode('')).toBeNull();
    expect(base32Decode('  ==')).toBeNull();
    expect(base32Decode('ABC1')).toBeNull();
  });
});

describe('parseTotpSecret', () => {
  it('takes a base32 secret with the usual defaults', () => {
    expect(parseTotpSecret(` ${SHA1_BASE32} `)).toEqual({ ok: true, config: { key: SHA1_KEY, algorithm: 'SHA1', digits: 6, period: 30 } });
  });

  it('takes an otpauth URI with its algorithm, digits and period', () => {
    const uri = `otpauth://totp/Example:qa@example.com?secret=${SHA1_BASE32}&issuer=Example&algorithm=sha256&digits=8&period=60`;
    expect(parseTotpSecret(uri)).toEqual({ ok: true, config: { key: SHA1_KEY, algorithm: 'SHA256', digits: 8, period: 60 } });
    expect(parseTotpSecret(`OTPAUTH://TOTP/x?secret=${SHA1_BASE32}`)).toEqual({ ok: true, config: { key: SHA1_KEY, algorithm: 'SHA1', digits: 6, period: 30 } });
  });

  it('says what is wrong with a secret it cannot use', () => {
    expect(parseTotpSecret('not a secret!')).toEqual({ ok: false, error: 'not a base32 secret or an otpauth:// URI' });
    expect(parseTotpSecret('otpauth:// bad')).toEqual({ ok: false, error: 'not a valid otpauth:// URI' });
    expect(parseTotpSecret(`otpauth://hotp/x?secret=${SHA1_BASE32}&counter=1`)).toMatchObject({ ok: false, error: expect.stringContaining('only otpauth://totp/') });
    expect(parseTotpSecret('otpauth://totp/x?issuer=Example')).toMatchObject({ ok: false, error: expect.stringContaining('no valid base32 secret') });
    expect(parseTotpSecret(`otpauth://totp/x?secret=${SHA1_BASE32}&algorithm=MD5`)).toMatchObject({ ok: false, error: expect.stringContaining('algorithm') });
    expect(parseTotpSecret(`otpauth://totp/x?secret=${SHA1_BASE32}&digits=4`)).toMatchObject({ ok: false, error: expect.stringContaining('digits') });
    expect(parseTotpSecret(`otpauth://totp/x?secret=${SHA1_BASE32}&period=0`)).toMatchObject({ ok: false, error: expect.stringContaining('period') });
  });
});

describe('freshTotpCode', () => {
  const fakeClock = (t: number) => {
    const clock = { t, slept: 0, now: () => clock.t, sleep: async (ms: number) => void ((clock.t += ms), (clock.slept += ms)) };
    return clock;
  };
  const c = config(SHA1_KEY, 'SHA1', 6);

  it('uses the current code while enough of its time is left', async () => {
    const clock = fakeClock(30_000 + 30_000 - TOTP_MIN_REMAINING_MS);
    expect(await freshTotpCode(c, clock)).toBe(totpCode(c, 30_000));
    expect(clock.slept).toBe(0);
  });

  it('waits for the next code when the current one is about to expire', async () => {
    const clock = fakeClock(59_000);
    expect(await freshTotpCode(c, clock)).toBe(totpCode(c, 60_000));
    expect(clock.slept).toBe(1_050);
  });

  it('never waits a whole short period', async () => {
    const short = { ...c, period: 4 };
    const clock = fakeClock(1_000);
    expect(await freshTotpCode(short, clock)).toBe(totpCode(short, 1_000));
    expect(clock.slept).toBe(0);
  });
});

describe('secretForms', () => {
  it('lists the forms a secret can show up in, for redaction', () => {
    expect(secretForms(' gezd gnbv-gy3t ')).toEqual(['gezd gnbv-gy3t', 'gezdgnbvgy3t']);
    expect(secretForms(SHA1_BASE32)).toEqual([SHA1_BASE32]);
    expect(secretForms(`otpauth://totp/x?secret=${SHA1_BASE32}&issuer=Ex`)).toEqual([`otpauth://totp/x?secret=${SHA1_BASE32}&issuer=Ex`, SHA1_BASE32]);
    expect(secretForms('otpauth:// bad')).toEqual(['otpauth:// bad', 'otpauth://bad']);
    expect(secretForms('otpauth://totp/x')).toEqual(['otpauth://totp/x']);
    expect(secretForms('  ')).toEqual([]);
  });
});
