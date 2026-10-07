/**
 * Relay semantics without a broker: publish-before-mark, duplicate PubAck handling, retry classification
 * (every publish error is retried with backoff until maxAttempts, then parked as failed), head-of-line
 * ordering, and the single-leader lease.
 */
import { describe, expect, it } from 'vitest';
import { buildEnvelope } from './envelope.js';
import { OutboxRelay, defaultBackoffMs, type PublishResult, type RelayStore } from './outbox-relay.js';
import type { OutboxDoc } from './outbox.service.js';

const quiet = { log() {}, warn() {}, error() {} };

function row(i: number): OutboxDoc {
  const e = buildEnvelope({ eventType: 'team.created', workspaceId: 'ws', aggregate: { type: 'Team', id: `t${i}`, version: 1 }, correlationId: 'req', causationId: 'cmd', actorId: 'u', payload: { teamId: `t${i}`, name: 'n', code: 'C' } });
  return { _id: e.eventId, subject: 'tm.v1.team.created', eventType: e.eventType, schemaVersion: 1, aggregateId: `t${i}`, workspaceId: 'ws', correlationId: 'req', occurredAt: new Date(), publishedAt: null, attempts: 0, lastError: null, nextAttemptAt: null, failedAt: null, streamSeq: null, envelope: e };
}

class MemoryStore implements RelayStore {
  rows: OutboxDoc[] = [];
  lease: { owner: string; expiresAt: Date } | null = null;
  async acquireLease(owner: string, now: Date, leaseMs: number) {
    if (this.lease && this.lease.owner !== owner && this.lease.expiresAt > now) return false;
    this.lease = { owner, expiresAt: new Date(now.getTime() + leaseMs) };
    return true;
  }
  async releaseLease(owner: string) { if (this.lease?.owner === owner) this.lease = null; }
  async loadPending(limit: number) { return this.rows.filter((r) => !r.publishedAt && !r.failedAt).slice(0, limit); }
  async markPublished(id: string, at: Date, seq: number, attempts: number) { Object.assign(this.find(id), { publishedAt: at, streamSeq: seq, attempts, lastError: null, nextAttemptAt: null }); }
  async markFailedAttempt(id: string, attempts: number, error: string, nextAttemptAt: Date, failedAt: Date | null) { Object.assign(this.find(id), { attempts, lastError: error, nextAttemptAt, failedAt }); }
  async countPending() { return this.rows.filter((r) => !r.publishedAt && !r.failedAt).length; }
  async countFailed() { return this.rows.filter((r) => !r.publishedAt && r.failedAt).length; }
  private find(id: string) { return this.rows.find((r) => r._id === id)!; }
}

/** Scripted broker: records every publish attempt that reached it; `script` decides what happens. */
class FakePublisher {
  published: string[] = [];
  seq = 0;
  constructor(private script: (doc: OutboxDoc, call: number) => PublishResult | Error = () => ({ seq: ++this.seq, duplicate: false })) {}
  async publish(doc: OutboxDoc): Promise<PublishResult> {
    const r = this.script(doc, this.published.length);
    if (r instanceof Error) throw r;
    this.published.push(doc._id);
    return r;
  }
}

const clock = (start = 1_000_000) => { let t = start; return { now: () => new Date(t), advance: (ms: number) => { t += ms; } }; };
const opts = (c: ReturnType<typeof clock>, extra = {}) => ({ owner: 'me', batch: 10, maxAttempts: 3, leaseMs: 5000, now: c.now, ...extra });

describe('OutboxRelay', () => {
  it('publishes pending rows in id order and marks each only after the PubAck', async () => {
    const store = new MemoryStore(); store.rows = [row(1), row(2), row(3)];
    const pub = new FakePublisher();
    const r = await new OutboxRelay(store, pub, opts(clock()), quiet).tick();
    expect(r).toEqual({ leader: true, published: 3, failed: 0 });
    expect(pub.published).toEqual(store.rows.map((x) => x._id));
    expect(store.rows.map((x) => x.streamSeq)).toEqual([1, 2, 3]);
    expect(store.rows.every((x) => x.publishedAt && x.attempts === 1)).toBe(true);
    expect(await store.countPending()).toBe(0);
  });

  it('crash between publish and mark ⇒ republished with the same eventId; a duplicate PubAck still marks it', async () => {
    const store = new MemoryStore(); store.rows = [row(1)];
    // call 0: broker accepted the message, then the process died before the mark (modelled as a throw after recording)
    const pub = new FakePublisher((doc, call) => { if (call === 0) { pub.published.push(doc._id); return new Error('process crashed after PubAck'); } return { seq: 7, duplicate: true }; });
    const c = clock();
    const relay = new OutboxRelay(store, pub, opts(c), quiet);
    await relay.tick();
    expect(store.rows[0]!.publishedAt).toBeNull();
    expect(store.rows[0]!.attempts).toBe(1);
    expect(await relay.tick()).toMatchObject({ waiting: true }); // still inside the backoff window
    c.advance(defaultBackoffMs(1));
    await relay.tick();
    expect(pub.published).toEqual([store.rows[0]!._id, store.rows[0]!._id]); // same Nats-Msg-Id twice: broker/inbox dedup
    expect(store.rows[0]!.publishedAt).not.toBeNull();
    expect(store.rows[0]!.streamSeq).toBe(7);
    expect(relay.stats.duplicates).toBe(1);
  });

  it('broker outage: attempts and bounded backoff on the head row, rows behind it wait (ordering), recovery drains everything', async () => {
    const store = new MemoryStore(); store.rows = [row(1), row(2)];
    let broken = true;
    const pub = new FakePublisher(() => (broken ? new Error('NatsError: connection closed') : { seq: ++pub.seq, duplicate: false }));
    const c = clock();
    const relay = new OutboxRelay(store, pub, opts(c, { maxAttempts: 10 }), quiet);
    expect(await relay.tick()).toEqual({ leader: true, published: 0, failed: 1 });
    expect(store.rows[0]!).toMatchObject({ attempts: 1, publishedAt: null });
    expect(store.rows[0]!.lastError).toContain('connection closed');
    expect(store.rows[1]!.attempts).toBe(0); // never tried: head-of-line
    expect(await relay.tick()).toMatchObject({ waiting: true });
    c.advance(defaultBackoffMs(1));
    await relay.tick();
    expect(store.rows[0]!.nextAttemptAt!.getTime() - c.now().getTime()).toBe(defaultBackoffMs(2)); // 2 s after the 2nd failure
    broken = false;
    c.advance(defaultBackoffMs(2));
    expect(await relay.tick()).toEqual({ leader: true, published: 2, failed: 0 });
    expect(pub.published).toEqual([store.rows[0]!._id, store.rows[1]!._id]);
    expect(relay.stats.lastError).toBeNull();
    expect([1, 2, 3, 4, 5, 6, 10].map(defaultBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('after maxAttempts the row is parked as failed (visible, not retried) and the queue moves on', async () => {
    const store = new MemoryStore(); store.rows = [row(1), row(2)];
    const poison = store.rows[0]!._id;
    const pub = new FakePublisher((doc) => (doc._id === poison ? new Error('maximum payload exceeded') : { seq: ++pub.seq, duplicate: false }));
    const c = clock();
    const relay = new OutboxRelay(store, pub, opts(c), quiet);
    for (let i = 0; i < 3; i++) { await relay.tick(); c.advance(60_000); }
    expect(store.rows[0]!).toMatchObject({ attempts: 3, publishedAt: null });
    expect(store.rows[0]!.failedAt).not.toBeNull();
    expect(await relay.tick()).toEqual({ leader: true, published: 1, failed: 0 });
    expect(store.rows[1]!.publishedAt).not.toBeNull();
    expect(await relay.snapshot()).toMatchObject({ pending: 0, failed: 1, exhausted: 1 });
  });

  it('only the lease holder publishes; the lease passes over after it expires', async () => {
    const store = new MemoryStore(); store.rows = [row(1)];
    const c = clock();
    const a = new OutboxRelay(store, new FakePublisher(), { ...opts(c), owner: 'a' }, quiet);
    const b = new OutboxRelay(store, new FakePublisher(), { ...opts(c), owner: 'b' }, quiet);
    expect(await a.tick()).toMatchObject({ leader: true, published: 1 });
    store.rows.push(row(2));
    expect(await b.tick()).toEqual({ leader: false, published: 0, failed: 0 });
    c.advance(5001); // a died without releasing: lease expires
    expect(await b.tick()).toMatchObject({ leader: true, published: 1 });
    await b.release();
    expect(store.lease).toBeNull();
  });
});
