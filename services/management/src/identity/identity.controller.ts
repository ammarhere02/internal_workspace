import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import type { WorkItemDoc } from '../boards/boards.types.js';
import { itemView } from '../boards/boards.service.js';
import { Ctx, type RequestContext } from '../common/context.js';
import { IdentityService } from './identity.service.js';

@Controller('api')
export class IdentityController {
  constructor(private readonly identity: IdentityService, private readonly config: ConfigService<Env, true>, private readonly mongo: MongoService) {}

  /** Who am I, which workspace: lets the UI label the dev identity. */
  @Get('me')
  async me(@Ctx() ctx: RequestContext, @Req() req: Request & { sessionExpiresAt?: number }) {
    const ws = this.identity.currentWorkspace();
    const user = await this.identity.getActiveUser(ctx.workspaceId, ctx.actorId);
    return { workspace: { id: ws._id, name: ws.name, slug: ws.slug }, actorId: ctx.actorId, name: user.name, email: user.email, role: ctx.role, teamIds: ctx.teamIds, authMode: this.config.get('AUTH_MODE'), sessionExpiresAt: req.sessionExpiresAt ? new Date(req.sessionExpiresAt).toISOString() : null, correlationId: ctx.correlationId };
  }

  /** "My Work": active items assigned to the caller across the workspace (employees' landing page). */
  @Get('me/items')
  async myItems(@Ctx() ctx: RequestContext) {
    const items = await this.mongo.collection<WorkItemDoc>('work_items').find({ workspaceId: ctx.workspaceId, assigneeId: ctx.actorId, archivedAt: null }).sort({ dueDate: 1, _id: 1 }).limit(100).toArray();
    return { items: items.map(itemView) };
  }

  /** Users available for membership/assignment pickers (no emails leak beyond the workspace). */
  @Get('users')
  async users(@Ctx() ctx: RequestContext) {
    const users = await this.identity.listUsers(ctx.workspaceId);
    return { items: users.map((u) => ({ id: u._id, name: u.name, email: u.email })) };
  }
}
