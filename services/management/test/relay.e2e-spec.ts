/**
 * Relay against the REAL Atlas outbox and a REAL local NATS JetStream (isolated stream per run).
 * The app boots with OUTBOX_RELAY_ENABLED=false; the relay core is driven by hand with the app's own
 * Mongo store and JetStream publisher, so every claim below is about production code paths:
 *   - command → outbox row → publish → PubAck → publishedAt/streamSeq
 *   - crash between publish and mark → republish, broker-suppressed duplicate, row still marked
 *   - broker interruption → attempts/backoff on the head row, recovery drains in order
 *   - exhausted row → failedAt, GET /health/relay shows it, retryFailed() re-queues it
 *   - lease: a second relay instance does not publish while the first holds the lease
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jetstreamManager, type JetStreamManager } from '@nats-io/jetstream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MongoService } from '../src/infra/mongo/mongo.module.js';
import { NatsService, ensureStream } from '../src/messaging/nats.service.js';
import { OutboxRelay, type RelayPublisher } from '../src/messaging/outbox-relay.js';
import { MongoRelayStore, RELAY_LEASE_ID } from '../src/messaging/outbox-relay.store.js';
import type { OutboxDoc } from '../src/messaging/outbox.service.js';
import { publishEnvelope } from '../src/messaging/publish.js';

const slug = process.env.WORKSPACE_SLUG!;
if (!slug || slug === 'dev') throw new Error('relay tests must run with an isolated WORKSPACE_SLUG (use npm run test:e2e)');
const WS = `ws_${slug}`;
const STREAM = `TEAM_EVENTS_TEST_${slug.toUpperCase()}`;
const PREFIX = `tmtest.${slug}.`; // subjects are rewritten so test events never enter TEAM_EVENTS
const json = { 'content-type': 'application/json' };

let app: INestApplication;
let http: ReturnType<typeof request>;
let mongo: MongoService;
let nats: NatsService;
let jsm: JetStreamManager;
let store: MongoRelayStore;

/** The real publisher (same headers, same PubAck wait), pointed at the isolated stream's subjects. */
class TestPublisher implements RelayPublisher {
  calls: string[] = [];
  crashAfterPublishOnce = false;
  offline = false;
  async publish(doc: OutboxDoc) {
    if (this.offline) throw new Error('NatsError: CONNECTION_CLOSED (simulated broker outage)');
    const ack = await publishEnvelope(nats.client(), doc.subject.replace('tm.v1.', PREFIX), doc.envelope);
    this.calls.push(doc._id);
    if (this.crashAfterPublishOnce) { this.crashAfterPublishOnce = false; throw new Error('simulated crash after PubAck, before mark'); }
    return { seq: ack.seq, duplicate: ack.duplicate === true };
  }
}
const pub = new TestPublisher();
let clockMs = 0; // relative offset so backoff windows can be skipped without sleeping
const now = () => new Date(Date.now() + clockMs);
let relay: OutboxRelay;
const quiet = { log() {}, warn() {}, error() {} };

const pending = () => mongo.db.collection<OutboxDoc>('outbox').find({ workspaceId: WS }).sort({ _id: 1 }).toArray();
const streamMsgs = async () => (await jsm.streams.info(STREAM)).state.messages;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.init();
  http = request(app.getHttpServer());
  mongo = app.get(MongoService);
  nats = app.get(NatsService);
  jsm = await jetstreamManager(nats.connection());
  await ensureStream(jsm, STREAM, [`${PREFIX}>`]);
  store = new MongoRelayStore(mongo.db, { workspaceId: WS }); // only this run's outbox rows: never publish or re-queue another workspace's rows
  relay = new OutboxRelay(store, pub, { owner: `test-${slug}`, batch: 50, maxAttempts: 3, leaseMs: 5000, now }, quiet);
}, 60_000);

afterAll(async () => {
  for (const c of ['teams', 'team_memberships', 'projects', 'boards', 'work_items', 'issue_sequences', 'outbox', 'users']) {
    await mongo.db.collection(c).deleteMany({ workspaceId: WS });
  }
  await mongo.db.collection('workspaces').deleteOne({ _id: WS });
  await store.leases.deleteOne({ _id: RELAY_LEASE_ID, owner: { $regex: `^test-${slug}` } });
  await jsm.streams.delete(STREAM).catch(() => undefined);
  await app.close();
}, 60_000);

describe('outbox relay (real Atlas + real JetStream)', () => {
  it('the app relay is disabled in this suite and the outbox starts empty for this workspace', async () => {
    const r = await http.get('/health/relay').expect(200);
    expect(r.body.enabled).toBe(false);
    expect(await pending()).toHaveLength(0);
  });

  it('POST /api/teams → outbox row → publish → PubAck → marked published with the stream sequence', async () => {
    const t = await http.post('/api/teams').set(json).send({ name: 'Relay', code: 'RLY' }).expect(201);
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: 'team.created', publishedAt: null, attempts: 0, streamSeq: null });
    expect(rows[0]!.envelope.payload).toMatchObject({ teamId: t.body.id, code: 'RLY' });

    expect(await relay.tick()).toEqual({ leader: true, published: 1, failed: 0 });
    const [row] = await pending();
    expect(row!.publishedAt).toBeInstanceOf(Date);
    expect(row!.attempts).toBe(1);
    expect(row!.streamSeq).toBe(1);
    expect(await streamMsgs()).toBe(1);

    // the message on the broker is the envelope byte-for-byte, with the dedup/correlation headers
    const m = await jsm.streams.getMessage(STREAM, { seq: 1 });
    expect(JSON.parse(m.string())).toEqual(JSON.parse(JSON.stringify(row!.envelope)));
    expect(m.header?.get('Nats-Msg-Id')).toBe(row!._id);
    expect(m.header?.get('x-correlation-id')).toBe(row!.correlationId);
    expect(m.subject).toBe(`${PREFIX}team.created`);
  });

  it('crash between publish and mark: republished with the same Nats-Msg-Id, broker suppresses it, row gets marked', async () => {
    const before = await streamMsgs();
    await http.post('/api/teams').set(json).send({ name: 'Crash', code: 'CRS' }).expect(201);
    pub.crashAfterPublishOnce = true;
    expect(await relay.tick()).toEqual({ leader: true, published: 0, failed: 1 });
    let rows = await pending();
    const row = rows.find((r) => r.envelope.payload && (r.envelope.payload as { code?: string }).code === 'CRS')!;
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('simulated crash');
    expect(await streamMsgs()).toBe(before + 1); // the broker DID get it

    expect(await relay.tick()).toMatchObject({ waiting: true });
    clockMs += 1500; // past the 1 s backoff
    expect(await relay.tick()).toEqual({ leader: true, published: 1, failed: 0 });
    expect(pub.calls.filter((id) => id === row._id)).toHaveLength(2);
    expect(await streamMsgs()).toBe(before + 1); // ...and the re-publish was suppressed (Nats-Msg-Id)
    rows = await pending();
    expect(rows.find((r) => r._id === row._id)).toMatchObject({ attempts: 2, streamSeq: before + 1 });
    expect(rows.find((r) => r._id === row._id)!.publishedAt).toBeInstanceOf(Date);
    expect(relay.stats.duplicates).toBe(1);
  });

  it('broker interruption: head row retries with backoff, later rows wait, recovery drains in command order', async () => {
    const t = await http.post('/api/teams').set(json).send({ name: 'Outage', code: 'OUT' }).expect(201);
    await http.patch(`/api/teams/${t.body.id}`).set(json).send({ expectedVersion: 1, name: 'Outage 2' }).expect(200);
    pub.offline = true;
    expect(await relay.tick()).toEqual({ leader: true, published: 0, failed: 1 });
    clockMs += 1500;
    expect(await relay.tick()).toEqual({ leader: true, published: 0, failed: 1 });
    let rows = (await pending()).filter((r) => !r.publishedAt);
    expect(rows.map((r) => [r.eventType, r.attempts])).toEqual([['team.created', 2], ['team.updated', 0]]);
    expect(rows[0]!.lastError).toContain('CONNECTION_CLOSED');
    const health = await http.get('/health/relay').expect(200);
    expect(health.body.pending).toBeGreaterThanOrEqual(2);

    pub.offline = false;
    clockMs += 2500;
    expect(await relay.tick()).toEqual({ leader: true, published: 2, failed: 0 });
    rows = (await pending()).filter((r) => r.aggregateId === t.body.id);
    expect(rows.map((r) => r.streamSeq)).toEqual([rows[0]!.streamSeq, rows[0]!.streamSeq! + 1]); // created before updated
  });

  it('exhausted row is parked as failed and visible; retryFailed() re-queues it', async () => {
    await http.post('/api/teams').set(json).send({ name: 'Poison', code: 'PSN' }).expect(201);
    pub.offline = true;
    for (let i = 0; i < 3; i++) { await relay.tick(); clockMs += 5000; }
    const row = (await pending()).find((r) => (r.envelope.payload as { code?: string }).code === 'PSN')!;
    expect(row).toMatchObject({ attempts: 3, publishedAt: null });
    expect(row.failedAt).toBeInstanceOf(Date);
    const health = await http.get('/health/relay').expect(200);
    expect(health.body.failed).toBeGreaterThanOrEqual(1);

    pub.offline = false;
    expect(await store.retryFailed()).toBeGreaterThanOrEqual(1);
    expect(await relay.tick()).toEqual({ leader: true, published: 1, failed: 0 });
    expect(await store.countPending()).toBe(0);
  });

  it('a second relay instance does not publish while the lease is held, and takes over after expiry', async () => {
    await http.post('/api/teams').set(json).send({ name: 'Lease', code: 'LSE' }).expect(201);
    const other = new OutboxRelay(store, pub, { owner: `test-${slug}-b`, batch: 50, maxAttempts: 3, leaseMs: 5000, now }, quiet);
    await relay.tick(); // renews our lease (and publishes LSE)
    await http.post('/api/teams').set(json).send({ name: 'Lease 2', code: 'LS2' }).expect(201);
    expect(await other.tick()).toEqual({ leader: false, published: 0, failed: 0 });
    clockMs += 6000; // our lease expired without release (simulated death)
    expect(await other.tick()).toEqual({ leader: true, published: 1, failed: 0 });
    expect(await relay.tick()).toEqual({ leader: false, published: 0, failed: 0 }); // the old leader is now locked out
    await other.release();
    expect(await store.leases.findOne({ _id: RELAY_LEASE_ID })).toBeNull();
  });

  it('every outbox row of this workspace ended up published exactly once on the broker', async () => {
    const rows = await pending();
    expect(rows.every((r) => r.publishedAt && r.streamSeq)).toBe(true);
    expect(new Set(rows.map((r) => r.streamSeq)).size).toBe(rows.length);
    expect(await streamMsgs()).toBe(rows.length);
  });
});
