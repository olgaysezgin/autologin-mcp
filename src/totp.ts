import { createHmac } from 'node:crypto';

/**
 * Time-based one-time codes (RFC 6238) for a profile's second factor. The secret stays in this process:
 * a page only ever gets the current code (#1).
 */
export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpConfig {
  key: Buffer;
  algorithm: TotpAlgorithm;
  digits: number;
  /** Seconds per code. */
  period: number;
}

const ALGORITHMS: readonly TotpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, as authenticator apps show it: any case, spaces and padding allowed. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean === '') return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export type ParsedTotp = { ok: true; config: TotpConfig } | { ok: false; error: string };

/** 80 bits (16 base32 characters): the shortest secret authenticator setups hand out. */
const MIN_KEY_BYTES = 10;
const TOO_SHORT = 'the secret is too short: an authenticator secret has at least 16 base32 characters';

/**
 * A base32 secret (SHA-1, 6 digits, 30 s), or an `otpauth://totp/...` URI as the QR code of an
 * authenticator setup holds it, which may set `algorithm`, `digits` and `period`.
 */
export function parseTotpSecret(value: string): ParsedTotp {
  const text = value.trim();
  if (!/^otpauth:/i.test(text)) {
    const key = base32Decode(text);
    if (key === null) return { ok: false, error: 'not a base32 secret or an otpauth:// URI' };
    if (key.length < MIN_KEY_BYTES) return { ok: false, error: TOO_SHORT };
    return { ok: true, config: { key, algorithm: 'SHA1', digits: 6, period: 30 } };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'not a valid otpauth:// URI' };
  }
  if (url.hostname.toLowerCase() !== 'totp') return { ok: false, error: 'only otpauth://totp/ URIs are supported (time-based codes)' };
  const key = base32Decode(url.searchParams.get('secret') ?? '');
  if (key === null) return { ok: false, error: 'the otpauth:// URI has no valid base32 secret' };
  if (key.length < MIN_KEY_BYTES) return { ok: false, error: TOO_SHORT };
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() as TotpAlgorithm;
  if (!ALGORITHMS.includes(algorithm)) return { ok: false, error: `algorithm must be one of ${ALGORITHMS.join(', ')}` };
  const digits = Number(url.searchParams.get('digits') ?? 6);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) return { ok: false, error: 'digits must be 6, 7 or 8' };
  const period = Number(url.searchParams.get('period') ?? 30);
  if (!Number.isInteger(period) || period < 1) return { ok: false, error: 'period must be a whole number of seconds' };
  return { ok: true, config: { key, algorithm, digits, period } };
}

/**
 * The forms a TOTP secret can show up in, for redaction: as written, without spaces, inside an otpauth:// URI,
 * and a base32 secret in either case (base32 is case-insensitive, so either one works as the secret).
 */
export function secretForms(value: string): string[] {
  const text = value.trim();
  const forms = new Set([text]);
  const addBase32 = (secret: string): void => {
    const compact = secret.replace(/[\s-]/g, '');
    forms.add(compact);
    if (base32Decode(compact) !== null) {
      forms.add(compact.toUpperCase());
      forms.add(compact.toLowerCase());
    }
  };
  if (/^otpauth:/i.test(text)) {
    forms.add(text.replace(/[\s-]/g, ''));
    try {
      const secret = new URL(text).searchParams.get('secret');
      if (secret) addBase32(secret);
    } catch {
      // parseTotpSecret reports the URI as a problem of the profile.
    }
  } else {
    addBase32(text);
  }
  return [...forms].filter((form) => form !== '');
}

/** The code for the time step that contains `timeMs` (RFC 6238 / RFC 4226 dynamic truncation). */
export function totpCode(config: TotpConfig, timeMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / config.period)));
  const hash = createHmac(config.algorithm.toLowerCase(), config.key).update(counter).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const number = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** config.digits).padStart(config.digits, '0');
}

/** A code with less time left than this could expire before the page checks it: wait for the next one. */
export const TOTP_MIN_REMAINING_MS = 3_000;

/** The current code, or the next one when the current one is about to expire. */
export async function freshTotpCode(config: TotpConfig, clock: { now(): number; sleep(ms: number): Promise<void> }): Promise<string> {
  const periodMs = config.period * 1000;
  const left = periodMs - (clock.now() % periodMs);
  if (left < TOTP_MIN_REMAINING_MS && left < periodMs / 2) await clock.sleep(left + 50);
  return totpCode(config, clock.now());
}
