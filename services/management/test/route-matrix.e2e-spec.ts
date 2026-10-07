/**
 * Access matrix for EVERY route the application registers, as three kinds of caller (Google mode, the real
 * guards and middleware): anonymous, EMPLOYEE, ADMIN. The route list is discovered from the Nest container, so a
 * new route without a row here fails the completeness test below; stale rows fail it too.
 *
 *   public   : reachable by everyone (health, login/register pages and the auth endpoints)
 *   api      : any signed-in user; anonymous -> 401 unauthenticated
 *   admin    : API, ADMIN only; employee -> 403 forbidden, anonymous -> 401
 *   page     : HTML shell, any signed-in user; anonymous -> 302 /login
 *   adminpage: HTML shell, ADMIN only; employee -> 302 /my, anonymous -> 302 /login
 * "Allowed" means the request got past authentication and authorisation (anything except 401/403/redirect): with
 * placeholder ids a permitted call legitimately ends in 400/404/422.
 */
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const slug = process.env.WORKSPACE_SLUG!;
const ADMIN_EMAIL = `admin.${slug}@example.test`;
process.env.AUTH_MODE = 'google';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.SESSION_SECRET = 'y'.repeat(32);
process.env.ADMIN_EMAILS = ADMIN_EMAIL;

type Kind = 'public' | 'api' | 'admin' | 'page' | 'adminpage';
const R = (kind: Kind, route: string) => ({ kind, route });
const MATRIX = [
  // ---- public
  R('public', 'GET /health/live'), R('public', 'GET /health/ready'), R('public', 'GET /health/relay'),
  R('public', 'GET /login'), R('public', 'GET /register'), R('public', 'GET /auth/google'), R('public', 'GET /auth/google/callback'),
  R('public', 'POST /auth/logout'), R('public', 'POST /auth/login'), R('public', 'POST /auth/register'), R('public', 'POST /auth/logout/token'),
  // ---- API, any signed-in user
  R('api', 'GET /api/me'), R('api', 'GET /api/me/items'), R('api', 'GET /api/users'),
  R('api', 'GET /api/teams'), R('api', 'GET /api/teams/:teamId'), R('api', 'GET /api/teams/:teamId/members'),
  R('api', 'GET /api/projects'), R('api', 'GET /api/projects/:projectId'), R('api', 'GET /api/projects/:projectId/board'),
  R('api', 'GET /api/projects/:projectId/items'), R('api', 'POST /api/projects/:projectId/items'),
  R('api', 'GET /api/projects/:projectId/activity'), R('api', 'GET /api/projects/:projectId/insights'),
  R('api', 'GET /api/items/:itemId'), R('api', 'PATCH /api/items/:itemId'), R('api', 'POST /api/items/:itemId/assign'),
  R('api', 'POST /api/items/:itemId/move'), R('api', 'POST /api/items/:itemId/archive'),
  // ---- API, ADMIN only
  R('admin', 'POST /api/teams'), R('admin', 'PATCH /api/teams/:teamId'), R('admin', 'POST /api/teams/:teamId/archive'),
  R('admin', 'POST /api/teams/:teamId/members'), R('admin', 'PATCH /api/teams/:teamId/members/:userId'), R('admin', 'DELETE /api/teams/:teamId/members/:userId'),
  R('admin', 'POST /api/projects'), R('admin', 'PATCH /api/projects/:projectId'), R('admin', 'PUT /api/projects/:projectId/team'),
  R('admin', 'POST /api/projects/:projectId/archive'), R('admin', 'PUT /api/projects/:projectId/board/columns'), R('admin', 'GET /api/dashboard'),
  // ---- pages
  R('page', 'GET /my'), R('page', 'GET /projects'), R('page', 'GET /board'), R('page', 'GET /projects/:projectId'),
  R('page', 'GET /projects/:projectId/board'), R('page', 'GET /projects/:projectId/activity'), R('page', 'GET /projects/:projectId/insights'),
  R('adminpage', 'GET /'), R('adminpage', 'GET /teams'), R('adminpage', 'GET /teams/:teamId'),
  R('adminpage', 'GET /projects/new'), R('adminpage', 'GET /projects/:projectId/edit'),
];

const json = { 'content-type': 'application/json' };
let app: NestExpressApplication;
let http: ReturnType<typeof request>;
const cookies: Record<'anonymous' | 'employee' | 'admin', string> = { anonymous: '', employee: '', admin: '' };

/** Every route the Nest container registers, as "METHOD /path/:param". */
function discoverRoutes(): string[] {
  const out = new Set<string>();
  const names = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new () => object) | null;
      if (!ctrl) continue;
      const base = String(Reflect.getMetadata('path', ctrl) ?? '/');
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler) as number | undefined;
        if (method === undefined) continue;
        const sub = String(Reflect.getMetadata('path', handler) ?? '/');
        const path = '/' + [base, sub].join('/').split('/').filter(Boolean).join('/');
        out.add(`${names[method === RequestMethod.ALL ? 5 : method]} ${path}`);
      }
    }
  }
  return [...out].sort();
}

const concrete = (route: string) => {
  const [method, path] = route.split(' ') as [string, string];
  return { method: method.toLowerCase(), url: path.replace(/:userId/g, 'usr_x').replace(/:[A-Za-z]+/g, 'x_id') };
};
const call = (route: string, who: keyof typeof cookies) => {
  const { method, url } = concrete(route);
  let r = (http as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('accept', method === 'get' && !url.startsWith('/api') ? 'text/html' : 'application/json');
  if (cookies[who]) r = r.set('cookie', cookies[who]);
  return method === 'get' || method === 'delete' ? r : r.set(json).send({});
};
const blocked = (status: number) => status === 401 || status === 403;

beforeAll(async () => {
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/app.setup.js');
  const { configureAuth } = await import('../src/auth/auth.setup.js');
  const { configureWeb } = await import('../src/web/web.setup.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app); configureWeb(app); configureAuth(app);
  await app.init();
  http = request(app.getHttpServer());
  const sign = async (name: string, email: string) => {
    const r = await http.post('/auth/register').set(json).send({ name, email, password: 'correct horse battery' }).expect(201);
    return { cookie: (r.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), role: r.body.user.role as string };
  };
  const admin = await sign('Route Admin', ADMIN_EMAIL);
  const employee = await sign('Route Employee', `emp.${slug}@example.test`);
  expect([admin.role, employee.role]).toEqual(['ADMIN', 'EMPLOYEE']); // the allow-list decides the role
  cookies.admin = admin.cookie; cookies.employee = employee.cookie;
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('route inventory', () => {
  it('every registered route has a row in the matrix, and every row is a real route', () => {
    const registered = discoverRoutes();
    const declared = MATRIX.map((m) => m.route).sort();
    expect(registered.filter((r) => !declared.includes(r)), 'routes WITHOUT an access rule').toEqual([]);
    expect(declared.filter((r) => !registered.includes(r)), 'matrix rows that match no route').toEqual([]);
  });
});

describe('anonymous (no cookie)', () => {
  it.each(MATRIX.filter((m) => m.kind === 'api' || m.kind === 'admin'))('$route → 401 unauthenticated', async ({ route }) => {
    const res = await call(route, 'anonymous');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
  it.each(MATRIX.filter((m) => m.kind === 'page' || m.kind === 'adminpage'))('$route → redirect to /login', async ({ route }) => {
    const res = await call(route, 'anonymous');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
  it.each(MATRIX.filter((m) => m.kind === 'public'))('$route is reachable', async ({ route }) => {
    const res = await call(route, 'anonymous');
    expect(blocked(res.status), `status ${res.status}`).toBe(false);
  });
});

describe('EMPLOYEE', () => {
  it.each(MATRIX.filter((m) => m.kind === 'admin'))('$route → 403 forbidden', async ({ route }) => {
    const res = await call(route, 'employee');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
  it.each(MATRIX.filter((m) => m.kind === 'api'))('$route is allowed (not 401/403)', async ({ route }) => {
    const res = await call(route, 'employee');
    expect(blocked(res.status), `status ${res.status} ${JSON.stringify(res.body?.error ?? '')}`).toBe(false);
  });
  it.each(MATRIX.filter((m) => m.kind === 'adminpage'))('$route → redirected to /my', async ({ route }) => {
    const res = await call(route, 'employee');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/my');
  });
  it.each(MATRIX.filter((m) => m.kind === 'page'))('$route renders (200)', async ({ route }) => {
    expect((await call(route, 'employee')).status).toBe(200);
  });
});

describe('ADMIN', () => {
  it.each(MATRIX.filter((m) => m.kind === 'api' || m.kind === 'admin'))('$route is allowed (not 401/403)', async ({ route }) => {
    const res = await call(route, 'admin');
    expect(blocked(res.status), `status ${res.status} ${JSON.stringify(res.body?.error ?? '')}`).toBe(false);
  });
  it.each(MATRIX.filter((m) => m.kind === 'page' || m.kind === 'adminpage'))('$route renders (200)', async ({ route }) => {
    expect((await call(route, 'admin')).status).toBe(200);
  });
});

describe('role is decided by the server, not the token or the browser', () => {
  it('an employee cannot become admin by sending role/admin fields or a dev header', async () => {
    const res = await http.get('/api/teams').set('cookie', cookies.employee).set('x-dev-user', 'usr_admin');
    expect(res.status).toBe(200);
    expect((await http.get('/api/me').set('cookie', cookies.employee).set('x-dev-user', 'usr_admin')).body.role).toBe('EMPLOYEE');
    await http.post('/api/teams').set('cookie', cookies.employee).set(json).send({ name: 'Sneaky', code: 'SNK', role: 'ADMIN' }).expect(403);
  });
});
