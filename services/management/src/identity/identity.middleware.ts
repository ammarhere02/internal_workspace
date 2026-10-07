import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { RequestContext } from '../common/context.js';
import { DomainError } from '../common/errors/domain-error.js';
import { JWT_COOKIE, verifyToken } from '../auth/jwt.js';
import type { Env } from '../config/env.js';
import type { UserDoc } from './identity.types.js';
import { IdentityService } from './identity.service.js';

/**
 * Attaches the trusted context to every /api request. Workspace = server config, never a browser field.
 * Actor: AUTH_MODE=google → the session user (Passport); AUTH_MODE=dev → seeded user picked by x-dev-user.
 * Employees get their team ids as read scope; admins are unrestricted inside the workspace.
 */
@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(private readonly identity: IdentityService, private readonly config: ConfigService<Env, true>) {}

  private async fromJwt(req: Request & { cookies?: Record<string, string> }): Promise<UserDoc | null> {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.cookies?.[JWT_COOKIE];
    if (!token) return null;
    const claims = verifyToken(token, this.config.get('JWT_SECRET') || this.config.get('SESSION_SECRET'));
    if (!claims || claims.ws !== this.identity.currentWorkspace()._id) throw new DomainError(401, 'invalid_token', 'the token is invalid or expired');
    const user = await this.identity.findActive(claims.sub);
    if (!user) throw new DomainError(401, 'invalid_token', 'the token does not belong to an active user');
    (req as { sessionExpiresAt?: number }).sessionExpiresAt = claims.exp ? claims.exp * 1000 : undefined;
    return user; // role comes from the user record, not from the token
  }

  async use(req: Request & { ctx?: RequestContext; id?: string; user?: UserDoc }, _res: Response, next: NextFunction) {
    try {
      // 1) Passport session (Google)  2) JWT from the Authorization header or the HttpOnly cookie  3) dev identity (dev mode only)
      let actor: UserDoc | null = req.user ?? (await this.fromJwt(req));
      if (req.user) (req as { sessionExpiresAt?: number }).sessionExpiresAt = (req as { session?: { cookie?: { expires?: Date | boolean } } }).session?.cookie?.expires instanceof Date ? ((req as { session: { cookie: { expires: Date } } }).session.cookie.expires).getTime() : undefined;
      if (!actor) {
        if (this.config.get('AUTH_MODE') === 'google') throw new DomainError(401, 'unauthenticated', 'sign in to use the API');
        const header = req.headers['x-dev-user'];
        actor = await this.identity.resolveActor(Array.isArray(header) ? header[0] : header);
      }
      const workspaceId = this.identity.currentWorkspace()._id;
      const role = actor.role ?? 'EMPLOYEE';
      req.ctx = { workspaceId, actorId: actor._id, correlationId: String(req.id ?? ''), role, teamIds: role === 'ADMIN' ? null : await this.identity.teamIdsOf(workspaceId, actor._id) };
      next();
    } catch (e) {
      next(e);
    }
  }
}

/** Page routes: unauthenticated browsers go to /login (google mode); employees asking for admin pages go to /my. */
@Injectable()
export class PageAuthMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService<Env, true>) {}
  use(req: Request & { user?: UserDoc }, res: Response, next: NextFunction) {
    if (this.config.get('AUTH_MODE') !== 'google') return next();
    const user = req.user ?? this.fromJwtCookie(req);
    if (!user) return res.redirect('/login');
    const path = (req.originalUrl || req.url).split('?')[0]!; // req.path is relative to the mount point inside Nest middleware ('/' for every page)
    if (user.role !== 'ADMIN' && ADMIN_PAGES.some((re) => re.test(path))) return res.redirect('/my');
    next();
  }
  /** Page routes only need to know "is someone signed in" and the role claim; the API re-validates the user on every call. */
  private fromJwtCookie(req: Request & { cookies?: Record<string, string> }) {
    const token = req.cookies?.[JWT_COOKIE];
    const claims = token ? verifyToken(token, this.config.get('JWT_SECRET') || this.config.get('SESSION_SECRET')) : null;
    return claims ? { role: claims.role } : null;
  }
}
const ADMIN_PAGES = [/^\/$/, /^\/teams/, /^\/projects\/new$/, /^\/projects\/[^/]+\/edit$/];
