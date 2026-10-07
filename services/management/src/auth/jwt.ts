import jwt from 'jsonwebtoken';

export interface JwtClaims { sub: string; ws: string; role: 'ADMIN' | 'EMPLOYEE'; /** expiry, seconds since epoch (set by verifyToken) */ exp?: number; }
export const JWT_COOKIE = 'tm.jwt';
export const JWT_TTL_SECONDS = 8 * 3600;

/** HS256 access token: subject = user id, plus workspace and role for logging. The user is still re-read per request. */
export function signToken(claims: JwtClaims, secret: string): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS, issuer: 'management-service' });
}
/** Returns null for anything invalid (bad signature, expired, wrong algorithm, garbage). Never throws. */
export function verifyToken(token: string, secret: string): JwtClaims | null {
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'management-service' }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.ws !== 'string' || (p.role !== 'ADMIN' && p.role !== 'EMPLOYEE')) return null;
    return { sub: p.sub, ws: p.ws, role: p.role, exp: p.exp };
  } catch {
    return null;
  }
}
