import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Trusted per-request identity. Set by IdentityMiddleware on the server side; never taken from
 * a browser-supplied workspace field. Every repository filter uses ctx.workspaceId.
 */
export interface RequestContext {
  workspaceId: string;
  actorId: string;
  correlationId: string;
  /** ADMIN or EMPLOYEE (see identity.types). Admin-only routes are gated by RolesGuard. */
  role: 'ADMIN' | 'EMPLOYEE';
  /** Team scope: null = unrestricted (admin); for employees the teams they belong to. Repositories/services narrow reads to these. */
  teamIds: string[] | null;
}

export const Ctx = createParamDecorator((_data: unknown, exec: ExecutionContext): RequestContext => {
  const req = exec.switchToHttp().getRequest<Request & { ctx?: RequestContext }>();
  if (!req.ctx) throw new Error('RequestContext missing: IdentityMiddleware not applied');
  return req.ctx;
});
