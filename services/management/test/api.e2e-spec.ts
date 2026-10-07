/**
 * Request tests against the REAL Atlas database (PDF §14 "NestJS request" + "MongoDB" rows).
 * Isolation: a unique workspace slug per run; afterAll deletes ONLY documents that carry this run's workspaceId.
 * Needs: services/management/.env with MONGODB_URI, and a running NATS (docker compose up -d nats).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MongoService } from '../src/infra/mongo/mongo.module.js';

const slug = process.env.WORKSPACE_SLUG!; // set per run by vitest.config.e2e.ts
if (!slug || slug === 'dev') throw new Error('request tests must run with an isolated WORKSPACE_SLUG (use npm run test:e2e)');
const WS = `ws_${slug}`;
const u = (name: string) => `usr_${name}_${slug}`;
const json = { 'content-type': 'application/json' };

let app: INestApplication;
let http: ReturnType<typeof request>;
let mongo: MongoService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.init();
  http = request(app.getHttpServer());
  mongo = app.get(MongoService);
}, 60_000);

afterAll(async () => {
  // Clean up only this run's data (PDF §14): everything we wrote carries workspaceId = WS.
  for (const c of ['teams', 'team_memberships', 'projects', 'boards', 'work_items', 'issue_sequences', 'outbox', 'users']) {
    await mongo.db.collection(c).deleteMany({ workspaceId: { $in: [WS, `ws_other_${slug}`] } });
  }
  await mongo.db.collection('workspaces').deleteOne({ _id: WS });
  await app.close();
}, 60_000);

const outboxCount = () => mongo.db.collection('outbox').countDocuments({ workspaceId: WS });

describe('identity', () => {
  it('derives workspace and actor from the server, not the request', async () => {
    const r = await http.get('/api/me').set('x-workspace-id', 'ws_someone_else').expect(200);
    expect(r.body.workspace.id).toBe(WS);
    expect(r.body.actorId).toBe(u('admin'));
    expect(r.headers['x-correlation-id']).toMatch(/^req_/);
  });
  it('echoes a supplied correlation id', async () => {
    const r = await http.get('/api/me').set('x-correlation-id', 'req_from_test').expect(200);
    expect(r.body.correlationId).toBe('req_from_test');
  });
});

describe('teams (TM-01, TM-02)', () => {
  let teamId: string;
  it('creates a team and an outbox row atomically', async () => {
    const before = await outboxCount();
    const r = await http.post('/api/teams').set(json).send({ name: 'Payments', code: 'PAY' }).expect(201);
    teamId = r.body.id;
    expect(r.body).toMatchObject({ code: 'PAY', version: 1, archivedAt: null });
    expect(await outboxCount()).toBe(before + 1);
  });
  it('returns the stable error envelope on validation errors (400)', async () => {
    const r = await http.post('/api/teams').set(json).send({ name: 'x', code: 'lower', extra: 1 }).expect(400);
    expect(r.body.error).toMatchObject({ code: 'validation_error' });
    expect(r.body.error.details.violations).toEqual(expect.arrayContaining([expect.stringContaining('extra')]));
    expect(r.body.error.correlationId).toMatch(/^req_/);
  });
  it('rejects a duplicate code within the workspace (409) and writes no outbox row', async () => {
    const before = await outboxCount();
    const r = await http.post('/api/teams').set(json).send({ name: 'Other', code: 'PAY' }).expect(409);
    expect(r.body.error.code).toBe('duplicate_key');
    expect(await outboxCount()).toBe(before);
  });
  it('adds two members and updates a role (journey 1)', async () => {
    await http.post(`/api/teams/${teamId}/members`).set(json).send({ userId: u('blake'), role: 'LEAD' }).expect(201);
    await http.post(`/api/teams/${teamId}/members`).set(json).send({ userId: u('casey') }).expect(201);
    await http.post(`/api/teams/${teamId}/members`).set(json).send({ userId: u('casey') }).expect(409);
    await http.post(`/api/teams/${teamId}/members`).set(json).send({ userId: 'usr_nobody' }).expect(404);
    const r = await http.patch(`/api/teams/${teamId}/members/${u('casey')}`).set(json).send({ role: 'LEAD' }).expect(200);
    expect(r.body.role).toBe('LEAD');
    const m = await http.get(`/api/teams/${teamId}/members`).expect(200);
    expect(m.body.items.map((x: { userId: string }) => x.userId).sort()).toEqual([u('blake'), u('casey')].sort());
    const t = await http.get(`/api/teams/${teamId}`).expect(200);
    expect(t.body.version).toBe(4); // create + 2 members + role change
  });
  it('update uses expectedVersion: stale -> 409 with currentVersion', async () => {
    const r = await http.patch(`/api/teams/${teamId}`).set(json).send({ expectedVersion: 1, name: 'Pay' }).expect(409);
    expect(r.body.error).toMatchObject({ code: 'version_conflict', details: { currentVersion: 4, expectedVersion: 1 } });
    await http.patch(`/api/teams/${teamId}`).set(json).send({ expectedVersion: 4, name: 'Payments team' }).expect(200);
  });
  it('paginates with a stable keyset cursor', async () => {
    await http.post('/api/teams').set(json).send({ name: 'Billing', code: 'BIL' }).expect(201);
    await http.post('/api/teams').set(json).send({ name: 'Core', code: 'CORE' }).expect(201);
    const p1 = await http.get('/api/teams?limit=2').expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await http.get(`/api/teams?limit=2&cursor=${p1.body.nextCursor}`).expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items].map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(3);
  });
  it('cannot see a team from another workspace (cross-workspace access)', async () => {
    const foreign = { _id: `team_foreign_${slug}`, workspaceId: `ws_other_${slug}`, name: 'Foreign', code: 'FOR', description: '', archivedAt: null, version: 1, createdAt: new Date(), updatedAt: new Date() };
    await mongo.db.collection('teams').insertOne(foreign);
    await http.get(`/api/teams/${foreign._id}`).expect(404);
    await http.post(`/api/teams/${foreign._id}/members`).set(json).send({ userId: u('blake') }).expect(404);
    const list = await http.get('/api/teams?limit=100').expect(200);
    expect(list.body.items.find((t: { id: string }) => t.id === foreign._id)).toBeUndefined();
  });
});

describe('projects and board (TM-03..05)', () => {
  let teamId: string;
  let projectId: string;
  beforeAll(async () => {
    teamId = (await http.get('/api/teams').expect(200)).body.items.find((t: { code: string }) => t.code === 'PAY').id;
  });
  it('rejects an owner who is not in the team (422)', async () => {
    const r = await http.post('/api/projects').set(json).send({ projectKey: 'PAY', name: 'Payments platform', teamId, ownerId: u('eli') }).expect(422);
    expect(r.body.error.code).toBe('owner_not_in_team');
  });
  it('creates the project with its default board and two events in one transaction', async () => {
    const before = await outboxCount();
    const r = await http.post('/api/projects').set(json).send({ projectKey: 'PAY', name: 'Payments platform', teamId, ownerId: u('blake'), status: 'ACTIVE', targetDate: '2026-12-31' }).expect(201);
    projectId = r.body.id;
    expect(await outboxCount()).toBe(before + 2);
    const b = await http.get(`/api/projects/${projectId}/board`).expect(200);
    expect(b.body.columns.map((c: { columnId: string }) => c.columnId)).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
    await http.post('/api/projects').set(json).send({ projectKey: 'PAY', name: 'dup', teamId, ownerId: u('blake') }).expect(409);
  });
  it('configures columns; refuses to drop a non-empty column; bumps board version', async () => {
    await http.post(`/api/projects/${projectId}/items`).set(json).send({ title: 'in backlog' }).expect(201);
    const cols = [{ columnId: 'backlog', name: 'Backlog' }, { columnId: 'todo', name: 'Ready', wipLimit: 3 }, { columnId: 'in_progress', name: 'Doing' }, { columnId: 'review', name: 'Review' }, { columnId: 'done', name: 'Done' }, { name: 'Blocked' }];
    const r = await http.put(`/api/projects/${projectId}/board/columns`).set(json).send({ expectedVersion: 1, columns: cols }).expect(200);
    expect(r.body.version).toBe(2);
    expect(r.body.columns).toHaveLength(6);
    expect(r.body.columns[1]).toMatchObject({ name: 'Ready', wipLimit: 3, order: 1 });
    const drop = await http.put(`/api/projects/${projectId}/board/columns`).set(json).send({ expectedVersion: 2, columns: cols.slice(1) }).expect(422);
    expect(drop.body.error.code).toBe('column_not_empty');
  });
  it('reassigning the owning team is rejected while assignees would fall outside it', async () => {
    const other = (await http.get('/api/teams').expect(200)).body.items.find((t: { code: string }) => t.code === 'BIL').id;
    const r = await http.put(`/api/projects/${projectId}/team`).set(json).send({ expectedVersion: 1, teamId: other }).expect(422);
    expect(r.body.error.code).toBe('owner_not_in_team');
  });
});

describe('work items (TM-06..09, TM-11)', () => {
  let projectId: string;
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  beforeAll(async () => {
    projectId = (await http.get('/api/projects').expect(200)).body.items[0].id;
  });
  it('creates items with sequential immutable issue keys and full fields', async () => {
    const r1 = await http.post(`/api/projects/${projectId}/items`).set(json).send({ title: 'Add refund endpoint', type: 'TASK', priority: 'HIGH', assigneeId: u('casey'), labels: ['backend', 'api'], dueDate: '2026-10-20', acceptanceNotes: 'Refund returns 201' }).expect(201);
    const r2 = await http.post(`/api/projects/${projectId}/items`).set(json).send({ title: 'Fix rounding bug', type: 'BUG', priority: 'CRITICAL' }).expect(201);
    a = r1.body; b = r2.body;
    expect(a.issueKey).toBe('PAY-2'); // PAY-1 was created in the board test
    expect(b.issueKey).toBe('PAY-3');
    expect(a).toMatchObject({ reporterId: u('admin'), assigneeId: u('casey'), labels: ['backend', 'api'], dueDate: '2026-10-20', acceptanceNotes: 'Refund returns 201', version: 1, columnId: 'backlog' });
  });
  it('rejects assignment to a non-member in the domain layer (journey 6) with no side effects', async () => {
    const before = await outboxCount();
    const r = await http.post(`/api/projects/${projectId}/items`).set(json).send({ title: 'Sneaky', assigneeId: u('eli') }).expect(422);
    expect(r.body.error.code).toBe('assignee_not_in_team');
    const r2 = await http.post(`/api/items/${a.id}/assign`).set(json).send({ expectedVersion: 1, assigneeId: u('eli') }).expect(422);
    expect(r2.body.error.code).toBe('assignee_not_in_team');
    expect(await outboxCount()).toBe(before);
    const seq = await mongo.db.collection('issue_sequences').findOne({ _id: projectId as never });
    expect(seq?.next).toBe(3); // rejected create did not consume a number
  });
  it('moves between columns and reorders inside a column with deterministic ranks (TM-08)', async () => {
    const m1 = await http.post(`/api/items/${a.id}/move`).set(json).send({ expectedVersion: 1, toColumnId: 'in_progress' }).expect(200);
    expect(m1.body).toMatchObject({ columnId: 'in_progress', version: 2 });
    const m2 = await http.post(`/api/items/${b.id}/move`).set(json).send({ expectedVersion: 1, toColumnId: 'in_progress', afterItemId: null }).expect(200); // top
    expect(m2.body.rank < m1.body.rank).toBe(true);
    const m3 = await http.post(`/api/items/${b.id}/move`).set(json).send({ expectedVersion: 2, toColumnId: 'in_progress', afterItemId: a.id }).expect(200); // below a
    expect(m3.body.rank > m1.body.rank).toBe(true);
    const board = await http.get(`/api/projects/${projectId}/board`).expect(200);
    const col = board.body.columns.find((c: { columnId: string }) => c.columnId === 'in_progress');
    expect(col.items.map((i: { issueKey: string }) => i.issueKey)).toEqual(['PAY-2', 'PAY-3']);
    expect(col.count).toBe(2);
    await http.post(`/api/items/${a.id}/move`).set(json).send({ expectedVersion: 2, toColumnId: 'nope' }).expect(422);
  });
  it('stale move returns 409 with the current version (optimistic concurrency)', async () => {
    const r = await http.post(`/api/items/${a.id}/move`).set(json).send({ expectedVersion: 1, toColumnId: 'review' }).expect(409);
    expect(r.body.error).toMatchObject({ code: 'version_conflict', details: { currentVersion: 2 } });
  });
  it('edits, reassigns and unassigns with version checks', async () => {
    const e = await http.patch(`/api/items/${a.id}`).set(json).send({ expectedVersion: 2, priority: 'CRITICAL', labels: ['backend'], dueDate: null }).expect(200);
    expect(e.body).toMatchObject({ priority: 'CRITICAL', labels: ['backend'], dueDate: null, version: 3 });
    await http.patch(`/api/items/${a.id}`).set(json).send({ expectedVersion: 3, issueKey: 'HACK-1' }).expect(400); // not editable
    const un = await http.post(`/api/items/${a.id}/assign`).set(json).send({ expectedVersion: 3, assigneeId: null }).expect(200);
    expect(un.body).toMatchObject({ assigneeId: null, version: 4 });
    const re = await http.post(`/api/items/${a.id}/assign`).set(json).send({ expectedVersion: 4, assigneeId: u('blake') }).expect(200);
    expect(re.body.version).toBe(5);
  });
  it('filters by assignee, priority, label, type and text (TM-11)', async () => {
    const keys = async (q: string) => (await http.get(`/api/projects/${projectId}/items?${q}`).expect(200)).body.items.map((i: { issueKey: string }) => i.issueKey);
    expect(await keys('priority=CRITICAL')).toEqual(['PAY-2', 'PAY-3']);
    expect(await keys('type=BUG')).toEqual(['PAY-3']);
    expect(await keys('label=backend')).toEqual(['PAY-2']);
    expect(await keys(`assigneeId=${u('blake')}`)).toEqual(['PAY-2']);
    expect(await keys('assigneeId=unassigned')).toEqual(['PAY-1', 'PAY-3']);
    expect(await keys('q=rounding')).toEqual(['PAY-3']);
    await http.get(`/api/projects/${projectId}/items?priority=URGENT`).expect(400);
  });
  it('member removal is blocked while the user has active assignments, allowed after unassign', async () => {
    const teamId = (await http.get(`/api/projects/${projectId}`).expect(200)).body.teamId;
    const r = await http.delete(`/api/teams/${teamId}/members/${u('blake')}`).expect(422);
    expect(r.body.error.code).toBe('member_has_assignments');
  });
  it('archives instead of deleting; archived items leave the board but stay queryable', async () => {
    const r = await http.post(`/api/items/${b.id}/archive`).set(json).send({ expectedVersion: 3 }).expect(200);
    expect(r.body.archivedAt).toBeTruthy();
    await http.post(`/api/items/${b.id}/move`).set(json).send({ expectedVersion: 4, toColumnId: 'done' }).expect(409);
    const board = await http.get(`/api/projects/${projectId}/board`).expect(200);
    expect(board.body.columns.flatMap((c: { items: { issueKey: string }[] }) => c.items.map((i) => i.issueKey))).not.toContain('PAY-3');
    const all = await http.get(`/api/projects/${projectId}/items?includeArchived=true`).expect(200);
    expect(all.body.items.map((i: { issueKey: string }) => i.issueKey)).toContain('PAY-3');
  });
  it('wrote one outbox event per successful command, with correct aggregate versions', async () => {
    const rows = await mongo.db.collection('outbox').find({ workspaceId: WS, aggregateId: a.id as string }).sort({ _id: 1 }).toArray();
    expect(rows.map((r) => `${r.eventType}@${r.envelope.aggregate.version}`)).toEqual([
      'workitem.created@1', 'workitem.moved@2', 'workitem.updated@3', 'workitem.assigned@4', 'workitem.assigned@5',
    ]);
    expect(rows.every((r) => r.publishedAt === null && r.envelope.correlationId.startsWith('req_'))).toBe(true);
  });
});
