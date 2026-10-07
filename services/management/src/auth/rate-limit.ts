/**
 * Small fixed-window limiter for the login/register endpoints (per client IP and per e-mail), in memory.
 * Good enough for one instance; a shared store would be the production answer.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Returns remaining seconds to wait when over the limit, otherwise 0 (and records the hit). */
  hit(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) { this.hits.set(key, { count: 1, resetAt: now + this.windowMs }); return 0; }
    if (h.count >= this.max) return Math.ceil((h.resetAt - now) / 1000);
    h.count += 1;
    return 0;
  }
  reset(key: string) { this.hits.delete(key); }
}
