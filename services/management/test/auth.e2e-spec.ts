/**
 * Role gating and employee team scope (AUTH_MODE=dev, so identities come from x-dev-user; the Google
 * round trip itself needs real credentials and is exercised manually, see docs/auth.md).
 * Seeded roles: usr_admin = ADMIN, everyone else = EMPLOYEE.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { configureWeb } from '../src/web/web.setup.js';

const slug = process.env.WORKSPACE_SLUG!;
if (!slug || slug === 'dev') throw new Error('request tests must run with an isolated WORKSPACE_SLUG (use npm run test:e2e)');
const json = { 'content-type': 'application/json' };
const asBlake = { ...json, 'x-dev-user': 'usr_blake' };
const asEli = { ...json, 'x-dev-user': 'usr_eli' };

let app: NestExpressApplication;
let http: ReturnType<typeof request>;
let teamId: string, otherTeamId: string, projectId: string, otherProjectId: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  configureWeb(app);
  await app.init();
  http = request(app.getHttpServer());
  const mk = async (code: string, member: string) => {
    const t = await http.post('/api/teams').set(json).send({ name: code, code }).expect(201);
    await http.post(`/api/teams/${t.body.id}/members`).set(json).send({ userId: `usr_admin_${slug}`, role: 'OWNER' }).expect(201);
    await http.post(`/api/teams/${t.body.id}/members`).set(json).send({ userId: `${member}_${slug}`, role: 'MEMBER' }).expect(201);
    const p = await http.post('/api/projects').set(json).send({ projectKey: code, name: code, teamId: t.body.id }).expect(201);
    return [t.body.id, p.body.id];
  };
  [teamId, projectId] = await mk('AUTHA', 'usr_blake');
  [otherTeamId, otherProjectId] = await mk('AUTHB', 'usr_casey');
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('identity', () => {
  it('/api/me reports role, team scope and auth mode', async () => {
    const admin = (await http.get('/api/me').expect(200)).body;
    expect(admin).toMatchObject({ role: 'ADMIN', teamIds: null, authMode: 'dev' });
    const blake = (await http.get('/api/me').set(asBlake).expect(200)).body;
    expect(blake.role).toBe('EMPLOYEE');
    expect(blake.teamIds).toEqual([teamId]);
  });
  it('login page renders (dev mode explains the dev identity)', async () => {
    const res = await http.get('/login').expect(200);
    expect(res.text).toContain('Development identity mode');
  });
});

describe('admin-only routes', () => {
  it.each([
    ['POST', '/api/teams', { name: 'X', code: 'XX' }],
    ['PATCH', '/api/teams/:t', { expectedVersion: 1, name: 'renamed' }],
    ['POST', '/api/teams/:t/members', { userId: 'usr_dana_SLUG', role: 'MEMBER' }],
    ['DELETE', '/api/teams/:t/members/usr_blake_SLUG', undefined],
    ['POST', '/api/projects', { projectKey: 'ZZ', name: 'Z', teamId: 'TEAM' }],
    ['PATCH', '/api/projects/:p', { expectedVersion: 1, name: 'renamed' }],
    ['PUT', '/api/projects/:p/team', { expectedVersion: 1, teamId: 'TEAM' }],
    ['POST', '/api/projects/:p/archive', { expectedVersion: 1 }],
    ['PUT', '/api/projects/:p/board/columns', { expectedVersion: 1, columns: [{ name: 'Only' }] }],
    ['GET', '/api/dashboard', undefined],
  ])('%s %s → 403 forbidden for an employee', async (method, path, body) => {
    const url = path.replace(':t', teamId).replace(':p', projectId).replace('SLUG', slug);
    const res = await (http as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()]!(url).set(asBlake).send(body && JSON.parse(JSON.stringify(body).replace('TEAM', teamId).replace('SLUG', slug)));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('employee scope: own teams only', () => {
  it('sees only the teams and projects they belong to', async () => {
    const teams = (await http.get('/api/teams?limit=100').set(asBlake).expect(200)).body.items.map((t: { id: string }) => t.id);
    expect(teams).toEqual([teamId]);
    const projects = (await http.get('/api/projects?limit=100').set(asBlake).expect(200)).body.items.map((p: { id: string }) => p.id);
    expect(projects).toEqual([projectId]);
    await http.get(`/api/projects/${otherProjectId}`).set(asBlake).expect(404); // not "403": existence is not leaked
    await http.get(`/api/projects/${otherProjectId}/board`).set(asBlake).expect(404);
    await http.get(`/api/teams/${otherTeamId}/members`).set(asBlake).expect(404);
    expect((await http.get(`/api/teams?limit=100`).set(asEli).expect(200)).body.items).toEqual([]); // member of nothing
  });
  it('can work on the board of their team: create, assign to self, move; and sees it under /api/me/items', async () => {
    const created = await http.post(`/api/projects/${projectId}/items`).set(asBlake).send({ title: 'employee card', assigneeId: `usr_blake_${slug}` }).expect(201);
    expect(created.body.reporterId).toBe(`usr_blake_${slug}`);
    await http.post(`/api/items/${created.body.id}/move`).set(asBlake).send({ expectedVersion: 1, toColumnId: 'todo' }).expect(200);
    const mine = (await http.get('/api/me/items').set(asBlake).expect(200)).body.items;
    expect(mine.map((i: { id: string }) => i.id)).toContain(created.body.id);
    await http.post(`/api/projects/${otherProjectId}/items`).set(asBlake).send({ title: 'not my team' }).expect(404);
  });
  it('admin remains unrestricted', async () => {
    const projects = (await http.get('/api/projects?limit=100').expect(200)).body.items.map((p: { id: string }) => p.id);
    expect(projects).toEqual(expect.arrayContaining([projectId, otherProjectId]));
    await http.get('/api/dashboard').expect(200);
  });
});
