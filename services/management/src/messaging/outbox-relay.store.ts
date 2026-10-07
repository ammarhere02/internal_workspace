import type { Collection, Db } from 'mongodb';
import type { RelayStore } from './outbox-relay.js';
import type { OutboxDoc } from './outbox.service.js';

export interface LeaseDoc { _id: string; owner: string; expiresAt: Date; acquiredAt: Date }
export const RELAY_LEASE_ID = 'outbox-relay';

/** MongoDB implementation of the relay store (management_db: outbox + relay_leases). */
export class MongoRelayStore implements RelayStore {
  readonly outbox: Collection<OutboxDoc>;
  readonly leases: Collection<LeaseDoc>;
  /** `scope.workspaceId` restricts every queue query to one workspace. Production passes nothing (the relay serves the whole collection); the request tests pass their own workspace so a run never publishes, counts or re-queues rows it did not create. */
  constructor(db: Db, private readonly scope: { workspaceId?: string } = {}) {
    this.outbox = db.collection<OutboxDoc>('outbox');
    this.leases = db.collection<LeaseDoc>('relay_leases');
  }

  async ensureIndexes() {
    // Replace the phase-3 index: pending rows are now also filtered by backoff deadline and failure flag.
    const names = (await this.outbox.indexes()).map((i) => i.name);
    if (names.includes('relay_pending')) await this.outbox.dropIndex('relay_pending');
    await this.outbox.createIndexes([
      { key: { publishedAt: 1, failedAt: 1, _id: 1 }, name: 'relay_pending_v2' },
      { key: { workspaceId: 1, aggregateId: 1 }, name: 'by_aggregate' },
    ]);
  }

  /**
   * Single-leader lease. The filter only matches when the lease is ours or expired; otherwise the
   * upsert collides on _id (E11000) and we are not the leader. One document, one atomic statement.
   */
  async acquireLease(owner: string, now: Date, leaseMs: number): Promise<boolean> {
    try {
      await this.leases.updateOne(
        { _id: RELAY_LEASE_ID, $or: [{ owner }, { expiresAt: { $lte: now } }] },
        { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs) }, $setOnInsert: { acquiredAt: now } },
        { upsert: true },
      );
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }

  async releaseLease(owner: string) {
    await this.leases.deleteOne({ _id: RELAY_LEASE_ID, owner });
  }

  loadPending(limit: number) {
    // Rows written before phase 4 have no failedAt: `null` matches a missing field too.
    return this.outbox.find({ publishedAt: null, failedAt: null, ...this.scoped() }).sort({ _id: 1 }).limit(limit).toArray();
  }

  async markPublished(eventId: string, at: Date, seq: number, attempts: number) {
    await this.outbox.updateOne({ _id: eventId, publishedAt: null }, { $set: { publishedAt: at, streamSeq: seq, attempts, lastError: null, nextAttemptAt: null } });
  }

  async markFailedAttempt(eventId: string, attempts: number, error: string, nextAttemptAt: Date, failedAt: Date | null) {
    await this.outbox.updateOne({ _id: eventId, publishedAt: null }, { $set: { attempts, lastError: error, nextAttemptAt, failedAt } });
  }

  private scoped() { return this.scope.workspaceId ? { workspaceId: this.scope.workspaceId } : {}; }
  countPending() { return this.outbox.countDocuments({ publishedAt: null, failedAt: null, ...this.scoped() }); }
  countFailed() { return this.outbox.countDocuments({ publishedAt: null, failedAt: { $ne: null }, ...this.scoped() }); }

  /** Operator action: put exhausted rows back into the queue (e.g. after fixing the broker). */
  async retryFailed() {
    const r = await this.outbox.updateMany({ publishedAt: null, failedAt: { $ne: null }, ...this.scoped() }, { $set: { failedAt: null, nextAttemptAt: null, attempts: 0 } });
    return r.modifiedCount;
  }
}
