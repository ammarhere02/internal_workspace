/**
 * Outbox relay core (PDF §9, decisions D-03/D-04). Pure logic over a small store interface so the
 * publish/mark ordering can be unit-tested with an in-memory store and a scripted publisher.
 *
 * Per tick:
 *   1. acquire/renew the single-leader lease (safe multi-relay: only one process publishes at a time)
 *   2. load pending rows (publishedAt null, not failed) in _id (= time) order
 *   3. for each row: publish → wait for the JetStream PubAck → mark publishedAt + streamSeq
 *      a PubAck with duplicate=true (broker already has this Nats-Msg-Id) counts as published
 *   4. on a publish error: attempts+1, lastError, nextAttemptAt = now + backoff; after maxAttempts
 *      the row is marked failedAt so it is operator-visible (GET /health/relay) instead of retried forever
 *
 * Head-of-line semantics: the queue is strictly ordered. While the oldest pending row is in backoff,
 * nothing behind it is published, so an aggregate's events reach the stream in command order. A poison
 * row therefore delays the queue for at most maxAttempts × backoff before it is parked as failed.
 *
 * Crash between publish and mark ⇒ the row is still pending ⇒ republished with the same eventId ⇒ the
 * broker suppresses it inside the duplicate window and the Python inbox suppresses it after that.
 * That is why the relay is at-least-once and never needs to be exactly-once.
 */
import type { OutboxDoc } from './outbox.service.js';

export interface PublishResult { seq: number; duplicate: boolean }
export interface RelayPublisher { publish(doc: OutboxDoc): Promise<PublishResult> }

export interface RelayStore {
  /** true if this owner holds the lease until now+leaseMs (acquired or renewed). */
  acquireLease(owner: string, now: Date, leaseMs: number): Promise<boolean>;
  releaseLease(owner: string): Promise<void>;
  /** Oldest pending (unpublished, not failed) rows in _id order, regardless of backoff. */
  loadPending(limit: number): Promise<OutboxDoc[]>;
  markPublished(eventId: string, at: Date, seq: number, attempts: number): Promise<void>;
  markFailedAttempt(eventId: string, attempts: number, error: string, nextAttemptAt: Date, failedAt: Date | null): Promise<void>;
  countPending(): Promise<number>;
  countFailed(): Promise<number>;
}

export interface RelayOptions {
  owner: string;
  batch: number;
  maxAttempts: number;
  leaseMs: number;
  /** Delay before the next publish attempt of a row that failed `attempts` times. */
  backoffMs?: (attempts: number) => number;
  now?: () => Date;
}

/** 1s, 2s, 4s … capped at 30s. Exported for the unit test. */
export const defaultBackoffMs = (attempts: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1));

export interface RelayStats {
  leader: boolean;
  published: number;
  duplicates: number;
  failedAttempts: number;
  exhausted: number;
  lastTickAt: string | null;
  lastPublishedAt: string | null;
  lastError: string | null;
}

export interface TickResult { leader: boolean; published: number; failed: number; waiting?: boolean }

export class OutboxRelay {
  readonly stats: RelayStats = { leader: false, published: 0, duplicates: 0, failedAttempts: 0, exhausted: 0, lastTickAt: null, lastPublishedAt: null, lastError: null };
  private readonly backoff: (n: number) => number;
  private readonly now: () => Date;

  constructor(
    private readonly store: RelayStore,
    private readonly publisher: RelayPublisher,
    private readonly opts: RelayOptions,
    private readonly log: { log(msg: string): void; warn(msg: string): void; error(msg: string): void } = console,
  ) {
    this.backoff = opts.backoffMs ?? defaultBackoffMs;
    this.now = opts.now ?? (() => new Date());
  }

  async tick(): Promise<TickResult> {
    const now = this.now();
    this.stats.lastTickAt = now.toISOString();
    const leader = await this.store.acquireLease(this.opts.owner, now, this.opts.leaseMs);
    this.stats.leader = leader;
    if (!leader) return { leader: false, published: 0, failed: 0 };

    const rows = await this.store.loadPending(this.opts.batch);
    let published = 0;
    if (rows[0]?.nextAttemptAt && rows[0].nextAttemptAt > now) return { leader: true, published: 0, failed: 0, waiting: true };
    for (const row of rows) {
      const attempts = row.attempts + 1;
      const startedAt = Date.now();
      let result: PublishResult;
      try {
        result = await this.publisher.publish(row); // resolves only after the broker's PubAck
        this.log.log(JSON.stringify({ msg: 'outbox published', eventId: row._id, eventType: row.eventType, subject: row.subject, aggregateId: row.aggregateId, correlationId: row.correlationId, attempt: attempts, latencyMs: Date.now() - startedAt, streamSeq: result.seq, result: result.duplicate ? 'duplicate' : 'published' }));
      } catch (e) {
        const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        const exhausted = attempts >= this.opts.maxAttempts;
        const at = this.now();
        await this.store.markFailedAttempt(row._id, attempts, error, new Date(at.getTime() + this.backoff(attempts)), exhausted ? at : null);
        this.stats.failedAttempts++;
        this.stats.lastError = error;
        if (exhausted) {
          this.stats.exhausted++;
          this.log.error(`outbox relay: event ${row._id} (${row.eventType}) FAILED after ${attempts} attempts: ${error}`);
        } else {
          this.log.warn(`outbox relay: publish attempt ${attempts} failed for ${row._id} (${row.eventType}): ${error}`);
        }
        // Stop the batch: the queue is head-of-line ordered, so nothing behind this row is published until it succeeds or is parked.
        return { leader: true, published, failed: 1 };
      }
      // Publish → PubAck → mark. If the process dies here the row is republished on the next tick (idempotent).
      await this.store.markPublished(row._id, this.now(), result.seq, attempts);
      published++;
      this.stats.published++;
      if (result.duplicate) this.stats.duplicates++;
      this.stats.lastPublishedAt = this.now().toISOString();
      this.stats.lastError = null;
    }
    return { leader: true, published, failed: 0 };
  }

  async release() {
    if (this.stats.leader) await this.store.releaseLease(this.opts.owner);
    this.stats.leader = false;
  }

  async snapshot() {
    const [pending, failed] = await Promise.all([this.store.countPending(), this.store.countFailed()]);
    return { ...this.stats, pending, failed };
  }
}
