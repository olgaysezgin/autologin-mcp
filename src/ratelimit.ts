/** Stops repeated failed logins for a profile, so a wrong password cannot lock the account. */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 3,
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const t = this.now();
    const kept = (this.failures.get(key) ?? []).filter((at) => t - at < this.windowMs);
    this.failures.set(key, kept);
    return kept;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  recordFailure(key: string): void {
    this.recent(key).push(this.now());
  }
}
