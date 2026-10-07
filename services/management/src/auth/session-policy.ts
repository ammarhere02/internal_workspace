/**
 * Session timeout policy. Two clocks:
 *  - idle: the session slides forward on every authenticated request (API call or page activity pings the API),
 *    so it ends after SESSION_IDLE_MINUTES without use;
 *  - absolute: whatever the activity, a login never lives longer than SESSION_MAX_HOURS (forces a fresh sign-in).
 * Pure functions so the rule is unit-tested without HTTP.
 */
export interface SessionPolicy { idleMs: number; maxMs: number }

/** Where the session ends if the user is active right now. */
export const slideExpiry = (authAtMs: number, nowMs: number, p: SessionPolicy): number => Math.min(nowMs + p.idleMs, authAtMs + p.maxMs);
/** True once the login is older than the absolute cap. */
export const pastAbsoluteLimit = (authAtMs: number, nowMs: number, p: SessionPolicy): boolean => nowMs >= authAtMs + p.maxMs;

/** True once the last real (non-background) activity is older than the idle window. */
export const idleExpired = (lastActiveMs: number, nowMs: number, p: SessionPolicy): boolean => nowMs - lastActiveMs >= p.idleMs;

export const policyFrom = (cfg: { get(k: 'SESSION_IDLE_MINUTES' | 'SESSION_MAX_HOURS'): number }): SessionPolicy =>
  ({ idleMs: cfg.get('SESSION_IDLE_MINUTES') * 60_000, maxMs: cfg.get('SESSION_MAX_HOURS') * 3_600_000 });
