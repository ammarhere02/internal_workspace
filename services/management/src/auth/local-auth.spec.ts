import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { signToken, verifyToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';

const violations = (dto: object) => validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((v) => v.property);

describe('login input validation (NoSQL injection)', () => {
  it.each([
    ['operator object as e-mail', { email: { $gt: '' }, password: 'password123' }],
    ['operator object as password', { email: 'a@example.test', password: { $ne: null } }],
    ['$where injection', { email: 'a@example.test', password: { $where: 'this.passwordHash' } }],
    ['array instead of string', { email: ['a@example.test'], password: 'password123' }],
    ['SQL-style payload is not an e-mail', { email: "' OR 1=1 --", password: 'password123' }],
    ['overlong password', { email: 'a@example.test', password: 'x'.repeat(129) }],
    ['missing fields', {}],
  ])('rejects %s', (_name, body) => {
    expect(violations(plainToInstance(LoginDto, body)).length).toBeGreaterThan(0);
  });
  it('accepts a plain e-mail and password', () => {
    expect(violations(plainToInstance(LoginDto, { email: 'a@example.test', password: 'password123' }))).toEqual([]);
  });
  it('register rejects names with template/operator characters', () => {
    expect(violations(plainToInstance(RegisterDto, { name: '{"$gt":""}', email: 'a@example.test', password: 'password123' }))).toContain('name');
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies in constant time; wrong/malformed never verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });
});

describe('jwt', () => {
  it('round-trips claims and rejects tampering, wrong secret and junk', () => {
    const t = signToken({ sub: 'usr_1', ws: 'ws_x', role: 'EMPLOYEE' }, 'secret-secret-secret', { authAtMs: Date.now(), expMs: Date.now() + 8 * 3_600_000 });
    expect(verifyToken(t, 'secret-secret-secret')).toMatchObject({ sub: 'usr_1', ws: 'ws_x', role: 'EMPLOYEE' });
    expect(verifyToken(t, 'secret-secret-secret')!.exp).toBeGreaterThan(Date.now() / 1000); // expiry is exposed for the session-expired UX
    expect(verifyToken(t, 'other-secret-other')).toBeNull();
    expect(verifyToken(t.slice(0, -2) + 'xx', 'secret-secret-secret')).toBeNull();
    expect(verifyToken('not.a.jwt', 'secret-secret-secret')).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows max hits per window then reports the wait', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit('k', 0)).toBe(0); expect(rl.hit('k', 10)).toBe(0);
    expect(rl.hit('k', 20)).toBe(1); // blocked, ~1 s left
    expect(rl.hit('k', 1001)).toBe(0); // window reset
  });
});
