import { describe, expect, it } from 'vitest';
import { pastAbsoluteLimit, policyFrom, slideExpiry } from './session-policy.js';

const p = { idleMs: 30 * 60_000, maxMs: 8 * 3_600_000 };

describe('session timeout policy', () => {
  it('slides: each active moment pushes the expiry to now + idle window', () => {
    const t0 = 1_000_000;
    expect(slideExpiry(t0, t0, p)).toBe(t0 + p.idleMs);
    expect(slideExpiry(t0, t0 + 20 * 60_000, p)).toBe(t0 + 20 * 60_000 + p.idleMs); // active at minute 20 -> ends at minute 50
  });
  it('never slides past the absolute limit, however active the user is', () => {
    const t0 = 1_000_000;
    const lateActivity = t0 + p.maxMs - 5 * 60_000; // 5 minutes before the cap
    expect(slideExpiry(t0, lateActivity, p)).toBe(t0 + p.maxMs);
    expect(pastAbsoluteLimit(t0, t0 + p.maxMs - 1, p)).toBe(false);
    expect(pastAbsoluteLimit(t0, t0 + p.maxMs, p)).toBe(true);
  });
  it('is built from the SESSION_* settings (minutes and hours)', () => {
    const cfg = { get: (k: string) => ({ SESSION_IDLE_MINUTES: 15, SESSION_MAX_HOURS: 2 })[k as 'SESSION_IDLE_MINUTES'] as number };
    expect(policyFrom(cfg)).toEqual({ idleMs: 15 * 60_000, maxMs: 2 * 3_600_000 });
  });
});
