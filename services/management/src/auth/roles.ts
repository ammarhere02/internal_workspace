import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { RequestContext } from '../common/context.js';
import { DomainError } from '../common/errors/domain-error.js';

export const ADMIN_ONLY = 'adminOnly';
/** Marks a route (or whole controller) as ADMIN-only: managing teams, projects, members and board columns. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

/** Global guard: 403 `forbidden` for employees on admin-only routes. Workspace/team scoping of reads is done in the services. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(exec: ExecutionContext): boolean {
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [exec.getHandler(), exec.getClass()]);
    if (!adminOnly) return true;
    const req = exec.switchToHttp().getRequest<Request & { ctx?: RequestContext }>();
    if (req.ctx?.role !== 'ADMIN') throw new DomainError(403, 'forbidden', 'this action requires the ADMIN role');
    return true;
  }
}
