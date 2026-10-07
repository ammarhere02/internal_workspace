/**
 * The browser's freshness rules (ui/public/js/freshness.js) are plain functions, so they are tested here
 * with vitest: a successful query is not the same as fresh data (TM-12).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no type declarations
import { classify, latestAuthoritative, STALE_AFTER_MS } from '../../ui/public/js/freshness.js';

const now = Date.parse('2026-10-07T12:00:00Z');
const freshness = (lastEventOccurredAt: string | null) => ({ lastProcessedAt: '2026-10-07T11:59:59Z', lastStreamSeq: 10, lastEventOccurredAt, processingAgeMs: 1000 });

describe('freshness classification', () => {
  it('query failure → unavailable, regardless of previous data', () => {
    expect(classify({ error: { detail: 'timeout' }, now }).state).toBe('unavailable');
  });
  it('not_ready reply → not_ready (no projection yet)', () => {
    expect(classify({ reply: { status: 'not_ready', freshness: freshness(null) }, now }).state).toBe('not_ready');
  });
  it('projection folded the newest authoritative change → fresh', () => {
    const r = classify({ reply: { status: 'ready', freshness: freshness('2026-10-07T11:59:00Z') }, authoritativeLatest: '2026-10-07T11:58:00Z', now });
    expect(r.state).toBe('fresh');
  });
  it('authoritative change newer than the last folded event → pending while recent', () => {
    const latest = new Date(now - 5_000).toISOString();
    const r = classify({ reply: { status: 'ready', freshness: freshness('2026-10-07T11:50:00Z') }, authoritativeLatest: latest, now });
    expect(r.state).toBe('pending');
  });
  it('… and stale once it has been behind for longer than the threshold', () => {
    const latest = new Date(now - STALE_AFTER_MS - 1).toISOString();
    const r = classify({ reply: { status: 'ready', freshness: freshness('2026-10-07T11:50:00Z') }, authoritativeLatest: latest, now });
    expect(r.state).toBe('stale');
  });
  it('a successful query with no folded events but no authoritative changes is fresh (empty project)', () => {
    expect(classify({ reply: { status: 'ready', freshness: freshness(null) }, authoritativeLatest: null, now }).state).toBe('fresh');
  });
  it('latestAuthoritative = newest of project.updatedAt and every card updatedAt', () => {
    const board = { columns: [{ items: [{ updatedAt: '2026-10-07T11:00:00Z' }, { updatedAt: '2026-10-07T11:30:00Z' }] }, { items: [] }] };
    expect(latestAuthoritative({ updatedAt: '2026-10-07T10:00:00Z' }, board)).toBe('2026-10-07T11:30:00Z');
    expect(latestAuthoritative({ updatedAt: '2026-10-07T12:00:00Z' }, board)).toBe('2026-10-07T12:00:00Z');
  });
});
