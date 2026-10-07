/**
 * BFF query path against the REAL NATS server: no responder → fast 503; a responder that answers in the
 * Python wire format (nest packet) → 200 ready / not_ready passthrough with freshness; a responder that
 * hangs → 503 timeout; a responder that replies status=error → 503 responder_error; foreign/unknown
 * project → 404 before any request leaves. The responder here stands in for app/query_responder.py; the
 * Python-side half of the same contract is proven in services/insights/tests/integration.
 * Note: run with the Python service stopped, otherwise it also answers on the live subjects.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Subscription } from '@nats-io/transport-node';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MongoService } from '../src/infra/mongo/mongo.module.js';
import { ACTIVITY_SUBJECT, INSIGHTS_SUBJECT } from '../src/insights/insights.service.js';
import { NatsService } from '../src/messaging/nats.service.js';

const slug = process.env.WORKSPACE_SLUG!;
if (!slug || slug === 'dev') throw new Error('request tests must run with an isolated WORKSPACE_SLUG (use npm run test:e2e)');
const WS = `ws_${slug}`;
const json = { 'content-type': 'application/json' };
const freshness = { lastProcessedAt: '2026-10-07T10:00:00Z', lastStreamSeq: 7, lastEventOccurredAt: '2026-10-07T09:59:59Z', processingAgeMs: 1200 };

let app: INestApplication;
let http: ReturnType<typeof request>;
let mongo: MongoService;
let nats: NatsService;
let projectId: string;
let subs: Subscription[] = [];

/** A stand-in Python responder speaking the Nest packet format ({id, response, isDisposed}). */
async function respond(subject: string, fn: (data: Record<string, unknown>) => Promise<unknown> | unknown) {
  const nc = nats.connection();
  const sub = nc.subscribe(subject, {
    callback: async (_err, msg) => {
      const packet = JSON.parse(msg.string()) as { id: string; data: Record<string, unknown> };
      const response = await fn(packet.data);
      if (response !== undefined) msg.respond(JSON.stringify({ id: packet.id, response, isDisposed: true }));
    },
  });
  await nc.flush();
  subs.push(sub);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.init();
  http = request(app.getHttpServer());
  mongo = app.get(MongoService);
  nats = app.get(NatsService);
  const t = await http.post('/api/teams').set(json).send({ name: 'Insights', code: 'INS' }).expect(201);
  await http.post(`/api/teams/${t.body.id}/members`).set(json).send({ userId: `usr_admin_${slug}`, role: 'OWNER' }).expect(201); // the default owner must be in the team
  const p = await http.post('/api/projects').set(json).send({ projectKey: 'INS', name: 'Insights', teamId: t.body.id }).expect(201);
  projectId = p.body.id;
}, 60_000);

afterEach(async () => {
  for (const s of subs) s.unsubscribe();
  subs = [];
  await nats.connection().flush();
});

afterAll(async () => {
  for (const c of ['teams', 'team_memberships', 'projects', 'boards', 'work_items', 'issue_sequences', 'outbox', 'users']) {
    await mongo.db.collection(c).deleteMany({ workspaceId: WS });
  }
  await mongo.db.collection('workspaces').deleteOne({ _id: WS });
  await app.close();
}, 60_000);

describe('GET /api/projects/:id/insights and /activity (BFF over NATS request/reply)', () => {
  it('404 for an unknown project, before any NATS request', async () => {
    const r = await http.get('/api/projects/prj_nope/insights').expect(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('503 insights_unavailable (no_responders) when Python is not there, well inside the timeout', async () => {
    const started = Date.now();
    const r = await http.get(`/api/projects/${projectId}/insights`).expect(503);
    expect(r.body.error).toMatchObject({ code: 'insights_unavailable', details: { reason: 'no_responders', subject: INSIGHTS_SUBJECT } });
    expect(r.body.error.correlationId).toMatch(/^req_/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('passes a ready reply through with freshness, source=projection, and the request carrying the trusted workspace + correlation id', async () => {
    let seen: Record<string, unknown> | undefined;
    await respond(INSIGHTS_SUBJECT, (data) => {
      seen = data;
      return { status: 'ready', projectId: data.projectId, correlationId: data.correlationId, freshness, workload: { totalActive: 2, byColumn: { todo: 2 }, byPriority: { HIGH: 2 }, byAssignee: [{ assigneeId: null, total: 2, byColumn: { todo: 2 } }] } };
    });
    const r = await http.get(`/api/projects/${projectId}/insights`).set('x-correlation-id', 'req_ins_1').set('x-workspace-id', 'ws_evil').expect(200);
    expect(seen).toEqual({ workspaceId: WS, projectId, correlationId: 'req_ins_1' });
    expect(r.body).toMatchObject({ status: 'ready', source: 'projection', correlationId: 'req_ins_1', freshness, workload: { totalActive: 2 } });
  });

  it('passes not_ready through as 200 so the UI can show "pending"', async () => {
    await respond(INSIGHTS_SUBJECT, (data) => ({ status: 'not_ready', projectId: data.projectId, correlationId: data.correlationId, freshness: { lastProcessedAt: null, lastStreamSeq: null, lastEventOccurredAt: null, processingAgeMs: null } }));
    const r = await http.get(`/api/projects/${projectId}/insights`).expect(200);
    expect(r.body.status).toBe('not_ready');
    expect(r.body.workload).toBeUndefined();
  });

  it('503 timeout when the responder hangs past NATS_REQUEST_TIMEOUT_MS', async () => {
    await respond(INSIGHTS_SUBJECT, () => new Promise(() => undefined));
    const r = await http.get(`/api/projects/${projectId}/insights`).expect(503);
    expect(r.body.error.details.reason).toBe('timeout');
  }, 15_000);

  it('503 responder_error when Python answers status=error (store unavailable)', async () => {
    await respond(INSIGHTS_SUBJECT, (data) => ({ status: 'error', projectId: data.projectId, correlationId: data.correlationId, freshness: { lastProcessedAt: null, lastStreamSeq: null, lastEventOccurredAt: null, processingAgeMs: null }, error: { code: 'unavailable', message: 'projection store unavailable' } }));
    const r = await http.get(`/api/projects/${projectId}/insights`).expect(503);
    expect(r.body.error.details).toMatchObject({ reason: 'responder_error', code: 'unavailable' });
  });

  it('activity forwards limit/cursor and returns the page', async () => {
    let seen: Record<string, unknown> | undefined;
    await respond(ACTIVITY_SUBJECT, (data) => {
      seen = data;
      return { status: 'ready', projectId: data.projectId, correlationId: data.correlationId, freshness, items: [{ eventId: 'e2', eventType: 'workitem.moved', actorId: 'u', occurredAt: '2026-10-07T09:59:59Z', summary: 'moved INS-1', aggregate: { type: 'WorkItem', id: 'wi', version: 2 }, item: null, correlationId: 'req' }], nextCursor: 'e2' };
    });
    const r = await http.get(`/api/projects/${projectId}/activity?limit=1&cursor=e9`).expect(200);
    expect(seen).toMatchObject({ workspaceId: WS, projectId, limit: 1, cursor: 'e9' });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.nextCursor).toBe('e2');
    await http.get(`/api/projects/${projectId}/activity?limit=500`).expect(400);
  });
});
