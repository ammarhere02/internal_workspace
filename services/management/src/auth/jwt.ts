import jwt from 'jsonwebtoken';

export interface JwtClaims {
  sub: string; ws: string; role: 'ADMIN' | 'EMPLOYEE';
  /** expiry, seconds since epoch */
  exp?: number;
  /** time of the original sign-in, seconds since epoch; renewals keep it so the absolute cap cannot be extended */
  at?: number;
}
export const JWT_COOKIE = 'tm.jwt';

/** HS256 access token. `expMs` comes from the session policy (sliding idle window, capped by the absolute limit). */
export function signToken(claims: Pick<JwtClaims, 'sub' | 'ws' | 'role'>, secret: string, when: { authAtMs: number; expMs: number }): string {
  return jwt.sign({ ...claims, at: Math.floor(when.authAtMs / 1000), exp: Math.floor(when.expMs / 1000) }, secret, { algorithm: 'HS256', issuer: 'management-service' });
}
/** Returns null for anything invalid (bad signature, expired, wrong algorithm, garbage). Never throws. */
export function verifyToken(token: string, secret: string): JwtClaims | null {
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'management-service' }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.ws !== 'string' || (p.role !== 'ADMIN' && p.role !== 'EMPLOYEE')) return null;
    return { sub: p.sub, ws: p.ws, role: p.role, exp: p.exp, at: typeof p.at === 'number' ? p.at : undefined };
  } catch {
    return null;
  }
}
