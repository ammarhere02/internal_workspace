/**
 * Projection freshness states (TM-12). Pure function so it can be unit-tested.
 * A successful query is NOT the same as fresh data: the reply carries the Python service's own metadata
 * (lastEventOccurredAt = newest event folded into THIS project, processingAgeMs = time since the consumer
 * last committed anything). We compare that with the newest authoritative change we know about.
 *
 *  unavailable  the query failed (timeout/no responder/503) → show last known data, if any, as untrusted
 *  not_ready    Python has no projection for this project yet (events not consumed)
 *  pending      authoritative data changed after the newest folded event; expected for a few seconds
 *  stale        pending for longer than STALE_AFTER_MS → the consumer is probably behind or down
 *  fresh        the projection has folded every change we know about
 */
export const STALE_AFTER_MS = 30_000;

export function classify({ reply, error, authoritativeLatest, now = Date.now() }) {
  if (error) return { state: 'unavailable', label: 'unavailable', kind: 'danger', detail: error.detail || error.message || 'query failed' };
  if (!reply) return { state: 'unavailable', label: 'unavailable', kind: 'danger', detail: 'no reply' };
  const f = reply.freshness || {};
  if (reply.status === 'not_ready') return { state: 'not_ready', label: 'pending (no projection yet)', kind: 'warning', detail: 'The Python service has not processed any event for this project yet.', freshness: f };
  const folded = f.lastEventOccurredAt ? Date.parse(f.lastEventOccurredAt) : 0;
  const latest = authoritativeLatest ? Date.parse(authoritativeLatest) : 0;
  if (latest && latest > folded) {
    const behindMs = now - latest;
    if (behindMs > STALE_AFTER_MS) return { state: 'stale', label: 'stale', kind: 'danger', detail: `Authoritative data changed ${Math.round(behindMs / 1000)}s ago and the projection has not caught up (last folded event ${f.lastEventOccurredAt || 'none'}).`, freshness: f };
    return { state: 'pending', label: 'pending', kind: 'warning', detail: `Recent changes are not folded in yet (last folded event ${f.lastEventOccurredAt}).`, freshness: f };
  }
  return { state: 'fresh', label: 'fresh', kind: 'success', detail: `Last event folded ${f.lastEventOccurredAt || '—'}; consumer last processed ${f.lastProcessedAt || '—'} (stream seq ${f.lastStreamSeq ?? '—'}).`, freshness: f };
}

/** Newest authoritative timestamp from a board payload + project (what the projection should have caught up to). */
export function latestAuthoritative(project, board) {
  let max = project?.updatedAt || null;
  for (const col of board?.columns || []) for (const it of col.items || []) if (!max || it.updatedAt > max) max = it.updatedAt;
  return max;
}
