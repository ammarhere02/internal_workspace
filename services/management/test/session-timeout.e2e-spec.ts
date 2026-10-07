/**
 * Session timeout on the real stack, Google mode (e-mail/password JWT path, which shares the policy with the Google
 * session). The windows are shortened through the SESSION_* settings: idle 6 s, absolute 18 s.
 *   - login returns the expiry; every API call re-issues the cookie with a later expiry (sliding idle window)
 *   - an unused token ends after the idle window (401 invalid_token)
 *   - continuous activity cannot extend the sign-in past the absolute limit
 * The browser-side behaviour (warning, dialog) is covered by the browser walkthrough in the verification report.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.AUTH_MODE = 'google';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.SESSION_SECRET = 'x'.repeat(32);
process.env.SESSION_IDLE_MINUTES = '0.1'; // 6 s
process.env.SESSION_MAX_HOURS = '0.005'; // 18 s

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = { 'content-type': 'application/json' };
let app: NestExpressApplication;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/app.setup.js');
  const { configureAuth } = await import('../src/auth/auth.setup.js');
  const { configureWeb } = await import('../src/web/web.setup.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app); configureWeb(app); configureAuth(app);
  // test-only hook: create a real Passport session for an existing user, exactly what the Google callback does after sign-in
  const { IdentityService } = await import('../src/identity/identity.service.js');
  app.use('/__test_login', async (req: any, res: any) => {
    const user = await app.get(IdentityService).findActive(String(req.query.uid));
    req.logIn(user, () => { req.session.authAt = req.session.lastActiveAt = Date.now(); res.end('ok'); });
  });
  await app.init();
  http = request(app.getHttpServer());
}, 60_000);
afterAll(async () => { await app?.close(); });

const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
const expiry = (res: request.Response) => Date.parse(String(res.headers['x-session-expires']));

describe('session timeout', () => {
  it('slides on activity, ends when idle, and is capped by the absolute limit', async () => {
    const t0 = Date.now();
    const reg = await http.post('/auth/register').set(json).send({ name: 'Time Out', email: `to.${process.env.WORKSPACE_SLUG}@example.test`, password: 'correct horse battery' }).expect(201);
    expect(Date.parse(reg.body.sessionExpiresAt) - t0).toBeLessThanOrEqual(6500); // idle window, not 8 h
    let cookie = cookieOf(reg);

    // 1) sliding: a call 2.5 s later moves the expiry forward and re-issues the cookie
    await sleep(2500);
    const a = await http.get('/api/me').set('cookie', cookie).expect(200);
    expect(expiry(a)).toBeGreaterThan(Date.parse(reg.body.sessionExpiresAt) + 1500);
    expect(a.headers['set-cookie']?.join(';')).toMatch(/tm\.jwt=/);
    expect(a.body.sessionExpiresAt).toBe(new Date(expiry(a)).toISOString()); // /api/me and the header agree
    cookie = cookieOf(a);

    // 2) absolute limit: stay active every 2.5 s; the cap (18 s after login) still ends the session
    let lastOk = 0, status = 200;
    while (status === 200 && Date.now() - t0 < 30_000) {
      await sleep(2500);
      const r = await http.get('/api/me').set('cookie', cookie);
      status = r.status;
      if (status === 200) { cookie = cookieOf(r); lastOk = Date.now() - t0; expect(expiry(r)).toBeLessThanOrEqual(t0 + 18_500); } // never promises more than the cap
    }
    expect(status).toBe(401);
    expect(lastOk).toBeGreaterThan(10_000); // it did slide past one idle window...
    expect(Date.now() - t0).toBeGreaterThanOrEqual(18_000); // ...but not past the absolute limit
  }, 60_000);

  it('an unused token ends after the idle window', async () => {
    const reg = await http.post('/auth/register').set(json).send({ name: 'Idle User', email: `idle.${process.env.WORKSPACE_SLUG}@example.test`, password: 'correct horse battery' }).expect(201);
    const cookie = cookieOf(reg);
    await http.get('/api/me').set('cookie', cookie).expect(200);
    await sleep(7000);
    const res = await http.get('/api/me').set('cookie', cookie).expect(401);
    expect(res.body.error.code).toBe('invalid_token');
  }, 30_000);
});

describe('background polling must not keep a session alive', () => {
  const email = () => `bg.${process.env.WORKSPACE_SLUG}@example.test`;

  it('e-mail/password JWT: a passive call neither renews the cookie nor moves the expiry', async () => {
    const reg = await http.post('/auth/register').set(json).send({ name: 'Passive Jwt', email: email(), password: 'correct horse battery' }).expect(201);
    const cookie = cookieOf(reg);
    await sleep(2500);
    const passive = await http.get('/api/me').set('cookie', cookie).set('x-session-passive', '1').expect(200);
    expect(passive.headers['set-cookie']).toBeUndefined(); // not re-issued
    expect(Date.parse(passive.body.sessionExpiresAt)).toBeLessThanOrEqual(Date.parse(reg.body.sessionExpiresAt) + 1000); // not extended
    const active = await http.get('/api/me').set('cookie', cookie).expect(200);
    expect(expiry(active)).toBeGreaterThan(Date.parse(reg.body.sessionExpiresAt) + 1500); // real activity does slide it
  }, 30_000);

  it('Google/Passport session: real activity slides the idle window, passive polling does not, idle ends it, the cap ends it regardless', async () => {
    const reg = await http.post('/auth/register').set(json).send({ name: 'Passive Session', email: `s.${email()}`, password: 'correct horse battery' }).expect(201);
    const uid = reg.body.user.id as string;
    const login = async () => { const r = await http.get(`/__test_login?uid=${uid}`); return (r.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).filter((c) => c.startsWith('tm.sid')).join('; '); };

    // (a) only passive polls: the session ends after the idle window although the server is contacted every 2 s
    let cookie = await login();
    const polls: number[] = [];
    for (let i = 0; i < 6; i++) { await sleep(2000); polls.push((await http.get('/api/me').set('cookie', cookie).set('x-session-passive', '1')).status); }
    expect(polls[0]).toBe(200);
    expect(polls.at(-1)).toBe(401); // 12 s of polling, idle window 6 s
    const gone = await http.get('/api/me').set('cookie', cookie);
    expect(gone.status).toBe(401); // the session was destroyed, a real call does not revive it

    // (b) real activity every 2.5 s keeps it alive past one idle window, but never past the absolute cap (18 s)
    const t0 = Date.now();
    cookie = await login();
    let status = 200, lastOk = 0;
    while (status === 200 && Date.now() - t0 < 30_000) {
      await sleep(2500);
      const r = await http.get('/api/me').set('cookie', cookie);
      status = r.status;
      if (status === 200) { lastOk = Date.now() - t0; expect(expiry(r)).toBeLessThanOrEqual(t0 + 18_500); }
    }
    expect(status).toBe(401);
    expect(lastOk).toBeGreaterThan(10_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(18_000);
  }, 90_000);
});
