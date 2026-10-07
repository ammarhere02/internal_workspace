import { describe, expect, it } from 'vitest';
import { roleForEmail } from '../identity/identity.service.js';
import { landingFor } from './auth.controller.js';

describe('role rule (ADMIN_EMAILS allowlist)', () => {
  it('allow-listed e-mails become ADMIN, case-insensitively, everyone else EMPLOYEE', () => {
    expect(roleForEmail('Boss@Example.com', 'boss@example.com, other@example.com')).toBe('ADMIN');
    expect(roleForEmail('dev@example.com', 'boss@example.com')).toBe('EMPLOYEE');
    expect(roleForEmail('dev@example.com', '')).toBe('EMPLOYEE');
  });
  it('redirects each role to its own landing page', () => {
    expect(landingFor({ role: 'ADMIN' })).toBe('/');
    expect(landingFor({ role: 'EMPLOYEE' })).toBe('/my');
  });
});
