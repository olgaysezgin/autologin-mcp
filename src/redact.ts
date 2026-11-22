export const REDACTED = '[REDACTED]';

/** Keys whose values are fixed enums produced by autologin-mcp itself. */
const KEEP_KEYS = new Set(['status', 'reason']);

export type Redactor = <T>(value: T) => T;

/**
 * Builds a function that replaces every known secret (and its URL-encoded form)
 * in all string values of a result object. Applied to everything sent to the agent.
 */
export function createRedactor(secrets: Iterable<string | undefined>): Redactor {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    needles.add(secret);
    needles.add(encodeURIComponent(secret));
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  const scrub = (text: string): string => ordered.reduce((acc, needle) => acc.split(needle).join(REDACTED), text);
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') return key !== undefined && KEEP_KEYS.has(key) ? value : scrub(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return <T>(value: T): T => walk(value) as T;
}
