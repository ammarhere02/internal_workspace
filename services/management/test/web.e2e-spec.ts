/**
 * AdminLTE pages and the dashboard summary (phase 6). Pages are shells: they must render, carry the CSP
 * header, escape route parameters, and serve the vendored AdminLTE/Bootstrap assets from this service
 * (no third backend, no CDN). /api/dashboard counts come from management_db only.
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

let app: NestExpressApplication;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  configureWeb(app);
  await app.init();
  http = request(app.getHttpServer());
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('pages', () => {
  it.each(['/', '/teams', '/projects', '/projects/new', '/board', '/teams/team_x', '/projects/prj_x', '/projects/prj_x/edit', '/projects/prj_x/board', '/projects/prj_x/activity', '/projects/prj_x/insights'])('%s renders the AdminLTE shell with a CSP header', async (url) => {
    const res = await http.get(url).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.text).toContain('class="app-wrapper"');
    expect(res.text).toContain('/vendor/adminlte/css/adminlte.min.css');
  });

  it('escapes route parameters instead of injecting them as HTML', async () => {
    const res = await http.get('/projects/%3Cscript%3Ealert(1)%3C%2Fscript%3E/board').expect(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it.each(['/vendor/adminlte/css/adminlte.min.css', '/vendor/adminlte/js/adminlte.min.js', '/vendor/bootstrap/js/bootstrap.bundle.min.js', '/vendor/bootstrap-icons/bootstrap-icons.min.css', '/assets/js/board.js', '/assets/css/app.css'])('serves %s locally', async (url) => {
    const res = await http.get(url).expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('unknown pages fall through to the JSON error envelope', async () => {
    const res = await http.get('/no-such-page').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('GET /api/dashboard', () => {
  it('counts teams, active projects, open and overdue items from authoritative data only', async () => {
    const before = (await http.get('/api/dashboard').expect(200)).body;
    const t = await http.post('/api/teams').set(json).send({ name: 'Dash', code: 'DSH' }).expect(201);
    await http.post(`/api/teams/${t.body.id}/members`).set(json).send({ userId: `usr_admin_${slug}`, role: 'OWNER' }).expect(201);
    const p = await http.post('/api/projects').set(json).send({ projectKey: 'DSH', name: 'Dashboard', teamId: t.body.id, status: 'ACTIVE' }).expect(201);
    const board = (await http.get(`/api/projects/${p.body.id}/board`).expect(200)).body;
    const lastColumn = board.columns.at(-1).columnId;
    await http.post(`/api/projects/${p.body.id}/items`).set(json).send({ title: 'open, overdue', dueDate: '2020-01-01' }).expect(201);
    await http.post(`/api/projects/${p.body.id}/items`).set(json).send({ title: 'open, future', dueDate: '2099-01-01' }).expect(201);
    await http.post(`/api/projects/${p.body.id}/items`).set(json).send({ title: 'done, overdue but closed', dueDate: '2020-01-01', columnId: lastColumn }).expect(201);
    const archived = await http.post(`/api/projects/${p.body.id}/items`).set(json).send({ title: 'archived', dueDate: '2020-01-01' }).expect(201);
    await http.post(`/api/items/${archived.body.id}/archive`).set(json).send({ expectedVersion: 1 }).expect(200);

    const after = (await http.get('/api/dashboard').expect(200)).body;
    expect(after.teams).toBe(before.teams + 1);
    expect(after.activeProjects).toBe(before.activeProjects + 1);
    expect(after.openItems).toBe(before.openItems + 2);
    expect(after.overdueItems).toBe(before.overdueItems + 1);
    expect(after.source).toBe('authoritative');
    const recent = after.recentProjects.find((r: { id: string }) => r.id === p.body.id);
    expect(recent.projectKey).toBe('DSH');
    expect(Date.parse(recent.latestChangeAt)).toBeGreaterThan(Date.parse(p.body.createdAt)); // newest item change, not just project.updatedAt
  });
});
