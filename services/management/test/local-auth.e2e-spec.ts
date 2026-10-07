/**
 * E-mail/password sign-in with JWT (employees) against the real app: registration, login, injection
 * payloads rejected before any query, enumeration-safe 401, rate limit, Bearer/cookie use, role scope.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { configureAuth } from '../src/auth/auth.setup.js';
import { configureWeb } from '../src/web/web.setup.js';

const slug = process.env.WORKSPACE_SLUG!;
if (!slug || slug === 'dev') throw new Error('request tests must run with an isolated WORKSPACE_SLUG (use npm run test:e2e)');
const json = { 'content-type': 'application/json' };
const EMAIL = `emp.${slug}@example.test`, PASSWORD = 'correct horse battery';

let app: NestExpressApplication;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app); configureWeb(app); configureAuth(app);
  await app.init();
  http = request(app.getHttpServer());
}, 60_000);
afterAll(async () => { await app?.close(); });

describe('register + login', () => {
  let token: string;
  it('registers an employee and returns a JWT + HttpOnly cookie + landing /my', async () => {
    const res = await http.post('/auth/register').set(json).send({ name: 'Emma Employee', email: EMAIL, password: PASSWORD }).expect(201);
    expect(res.body.user.role).toBe('EMPLOYEE');
    expect(res.body.landing).toBe('/my');
    expect(res.headers['set-cookie']?.join(';')).toMatch(/tm\.jwt=.*HttpOnly/);
    token = res.body.token;
  });
  it('duplicate e-mail → 409', async () => {
    await http.post('/auth/register').set(json).send({ name: 'Again', email: EMAIL.toUpperCase(), password: PASSWORD }).expect(409);
  });
  it('the token authenticates API calls (Bearer) with the EMPLOYEE role and empty team scope', async () => {
    const me = (await http.get('/api/me').set('authorization', `Bearer ${token}`).expect(200)).body;
    expect(me).toMatchObject({ email: EMAIL, role: 'EMPLOYEE', teamIds: [] });
    await http.post('/api/teams').set('authorization', `Bearer ${token}`).set(json).send({ name: 'X', code: 'XX' }).expect(403);
  });
  it('the cookie authenticates too', async () => {
    const login = await http.post('/auth/login').set(json).send({ email: EMAIL, password: PASSWORD }).expect(200);
    const cookie = login.headers['set-cookie']!.map((c: string) => c.split(';')[0]).join('; ');
    expect((await http.get('/api/me').set('cookie', cookie).expect(200)).body.role).toBe('EMPLOYEE');
  });
  it('wrong password and unknown e-mail give the same 401', async () => {
    const a = await http.post('/auth/login').set(json).send({ email: EMAIL, password: 'wrong password!' }).expect(401);
    const b = await http.post('/auth/login').set(json).send({ email: `nobody.${slug}@example.test`, password: 'wrong password!' }).expect(401);
    expect(a.body.error).toMatchObject({ code: 'invalid_credentials' });
    expect(b.body.error.message).toBe(a.body.error.message);
  });
  it('tampered / foreign tokens → 401 invalid_token', async () => {
    await http.get('/api/me').set('authorization', `Bearer ${token.slice(0, -3)}abc`).expect(401);
    await http.get('/api/me').set('authorization', 'Bearer not.a.token').expect(401);
  });
});

describe('page redirects with the JWT cookie (google mode only applies them; here we assert no loop)', () => {
  it('/login with a valid employee cookie redirects to /my, and /my does not redirect back', async () => {
    const login = await http.post('/auth/login').set(json).send({ email: EMAIL, password: PASSWORD }).expect(200);
    const cookie = login.headers['set-cookie']!.map((c: string) => c.split(';')[0]).join('; ');
    const l = await http.get('/login').set('cookie', cookie).expect(302);
    expect(l.headers.location).toBe('/my');
    await http.get('/my').set('cookie', cookie).expect(200);
  });
});

describe('injection payloads never reach a query', () => {
  it.each([
    ['operator object as e-mail', { email: { $gt: '' }, password: 'password123' }],
    ['operator object as password', { email: EMAIL, password: { $gt: '' } }],
    ['$ne null password', { email: EMAIL, password: { $ne: null } }],
    ['$regex e-mail', { email: { $regex: '.*' }, password: 'password123' }],
    ['SQL-style string', { email: "' OR '1'='1", password: "' OR '1'='1" }],
    ['extra fields (prototype-ish)', { email: EMAIL, password: PASSWORD, __proto__x: 1, role: 'ADMIN' }],
  ])('%s → 400 validation_error', async (_n, body) => {
    const res = await http.post('/auth/login').set(json).send(body).expect(400);
    expect(res.body.error.code).toBe('validation_error');
  });
  it('register with an operator name or role field → 400', async () => {
    await http.post('/auth/register').set(json).send({ name: { $gt: '' }, email: `x.${slug}@example.test`, password: PASSWORD }).expect(400);
    await http.post('/auth/register').set(json).send({ name: 'X Y', email: `x.${slug}@example.test`, password: PASSWORD, role: 'ADMIN' }).expect(400);
  });
});

describe('brute force', () => {
  it('locks an e-mail after 5 failed attempts (429 with retry hint)', async () => {
    const email = `lock.${slug}@example.test`;
    for (let i = 0; i < 5; i++) await http.post('/auth/login').set(json).send({ email, password: 'wrong password!' }).expect(401);
    const res = await http.post('/auth/login').set(json).send({ email, password: 'wrong password!' }).expect(429);
    expect(res.body.error.code).toBe('too_many_attempts');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });
});
