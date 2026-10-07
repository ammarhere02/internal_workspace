import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../common/context.js';
import { DomainError } from '../common/errors/domain-error.js';
import { newId } from '../common/ids.js';
import { toPage } from '../common/pagination.js';
import { IdentityService } from '../identity/identity.service.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import { buildEnvelope } from '../messaging/envelope.js';
import { OutboxService } from '../messaging/outbox.service.js';
import type { AddMemberDto, ChangeRoleDto, CreateTeamDto, UpdateTeamDto } from './dto/teams.dto.js';
import { TeamsRepository } from './teams.repository.js';
import type { MembershipDoc, Role, TeamDoc } from './teams.types.js';

/**
 * Teams module (TM-01, TM-02). The Team is the aggregate; memberships are part of it, so every
 * membership change bumps the team version and emits an event. Every command runs as
 * one transaction: team/membership write + outbox rows.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly repo: TeamsRepository,
    private readonly mongo: MongoService,
    private readonly outbox: OutboxService,
    private readonly identity: IdentityService,
  ) {}

  private event(ctx: RequestContext, team: TeamDoc, eventType: string, payload: object) {
    return buildEnvelope({
      eventType, workspaceId: ctx.workspaceId, aggregate: { type: 'Team', id: team._id, version: team.version },
      correlationId: ctx.correlationId, causationId: newId('cmd'), actorId: ctx.actorId, payload,
    });
  }

  async create(ctx: RequestContext, dto: CreateTeamDto): Promise<TeamDoc> {
    const now = new Date();
    const team: TeamDoc = { _id: newId('team'), workspaceId: ctx.workspaceId, name: dto.name, code: dto.code, description: dto.description ?? '', archivedAt: null, version: 1, createdAt: now, updatedAt: now };
    await this.mongo.withTransaction(async (session) => {
      await this.repo.teams.insertOne(team, { session });
      await this.outbox.append(session, [this.event(ctx, team, 'team.created', { teamId: team._id, name: team.name, code: team.code })]);
    });
    return team;
  }

  async get(ctx: RequestContext, teamId: string): Promise<TeamDoc> {
    const team = await this.repo.findById(ctx.workspaceId, teamId);
    if (!team || (ctx.teamIds && !ctx.teamIds.includes(team._id))) throw DomainError.notFound('team', teamId); // employees: own teams only
    return team;
  }

  /** Active team or 409: archived teams accept no new projects/members. */
  async getActive(ctx: RequestContext, teamId: string): Promise<TeamDoc> {
    const team = await this.get(ctx, teamId);
    if (team.archivedAt) throw DomainError.conflict('team_archived', `team ${team.code} is archived`);
    return team;
  }

  async list(ctx: RequestContext, includeArchived: boolean, limit: number, cursor?: string) {
    return toPage(await this.repo.list(ctx.workspaceId, includeArchived, limit, cursor, ctx.teamIds ?? undefined), limit);
  }

  async update(ctx: RequestContext, teamId: string, dto: UpdateTeamDto): Promise<TeamDoc> {
    const set: Partial<TeamDoc> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.description !== undefined) set.description = dto.description;
    return this.mongo.withTransaction(async (session) => {
      const team = await this.repo.updateVersioned(ctx.workspaceId, teamId, dto.expectedVersion, set, session);
      if (!team) throw await this.staleOrMissing(ctx, teamId, dto.expectedVersion);
      await this.outbox.append(session, [this.event(ctx, team, 'team.updated', { teamId: team._id, name: team.name, code: team.code })]);
      return team;
    });
  }

  async archive(ctx: RequestContext, teamId: string, expectedVersion: number): Promise<TeamDoc> {
    return this.mongo.withTransaction(async (session) => {
      const team = await this.repo.updateVersioned(ctx.workspaceId, teamId, expectedVersion, { archivedAt: new Date() }, session);
      if (!team) throw await this.staleOrMissing(ctx, teamId, expectedVersion);
      await this.outbox.append(session, [this.event(ctx, team, 'team.archived', { teamId: team._id, name: team.name, code: team.code })]);
      return team;
    });
  }

  async members(ctx: RequestContext, teamId: string) {
    await this.get(ctx, teamId);
    const rows = await this.repo.members(ctx.workspaceId, teamId);
    const users = await this.identity.listUsers(ctx.workspaceId);
    const byId = new Map(users.map((u) => [u._id, u]));
    return rows.map((m) => ({ userId: m.userId, name: byId.get(m.userId)?.name ?? '(inactive user)', role: m.role, joinedAt: m.joinedAt }));
  }

  async addMember(ctx: RequestContext, teamId: string, dto: AddMemberDto): Promise<MembershipDoc> {
    const user = await this.identity.getActiveUser(ctx.workspaceId, dto.userId); // must exist in THIS workspace
    try { return await this.mongo.withTransaction(async (session) => {
      const team = await this.repo.findById(ctx.workspaceId, teamId, session);
      if (!team) throw DomainError.notFound('team', teamId);
      if (team.archivedAt) throw DomainError.conflict('team_archived', `team ${team.code} is archived`);
      if (await this.repo.membership(teamId, user._id, session)) throw DomainError.conflict('already_member', `${user.name} is already a member`);
      const membership: MembershipDoc = { _id: `${teamId}:${user._id}`, workspaceId: ctx.workspaceId, teamId, userId: user._id, role: dto.role, joinedAt: new Date() };
      await this.repo.memberships.insertOne(membership, { session });
      const bumped = (await this.repo.updateVersioned(ctx.workspaceId, teamId, team.version, {}, session))!;
      await this.outbox.append(session, [this.event(ctx, bumped, 'team.member_added', { teamId, teamName: team.name, userId: user._id, userName: user.name, role: dto.role })]);
      return membership;
    }); } finally { this.identity.forgetTeams(ctx.workspaceId, user._id); }
  }

  async changeRole(ctx: RequestContext, teamId: string, userId: string, dto: ChangeRoleDto) {
    return this.mongo.withTransaction(async (session) => {
      const team = await this.repo.findById(ctx.workspaceId, teamId, session);
      if (!team) throw DomainError.notFound('team', teamId);
      const m = await this.repo.membership(teamId, userId, session);
      if (!m) throw DomainError.notFound('membership', userId);
      if (m.role === dto.role) return m;
      const user = await this.identity.getActiveUser(ctx.workspaceId, userId);
      await this.repo.memberships.updateOne({ _id: m._id }, { $set: { role: dto.role } }, { session });
      const bumped = (await this.repo.updateVersioned(ctx.workspaceId, teamId, team.version, {}, session))!;
      await this.outbox.append(session, [this.event(ctx, bumped, 'team.member_role_changed', { teamId, teamName: team.name, userId, userName: user.name, previousRole: m.role as Role, role: dto.role })]);
      return { ...m, role: dto.role };
    });
  }

  async removeMember(ctx: RequestContext, teamId: string, userId: string) {
    try { return await this.mongo.withTransaction(async (session) => {
      const team = await this.repo.findById(ctx.workspaceId, teamId, session);
      if (!team) throw DomainError.notFound('team', teamId);
      const m = await this.repo.membership(teamId, userId, session);
      if (!m) throw DomainError.notFound('membership', userId);
      // Invariant: an assignee always belongs to the project's current team. Unassign first, then remove.
      const open = await this.repo.countActiveAssignments(ctx.workspaceId, teamId, userId, session);
      if (open > 0) throw DomainError.invalid('member_has_assignments', `user still has ${open} active work item(s) in this team's projects; unassign them first`, { openAssignments: open });
      const user = await this.identity.getActiveUser(ctx.workspaceId, userId);
      await this.repo.memberships.deleteOne({ _id: m._id }, { session });
      const bumped = (await this.repo.updateVersioned(ctx.workspaceId, teamId, team.version, {}, session))!;
      await this.outbox.append(session, [this.event(ctx, bumped, 'team.member_removed', { teamId, teamName: team.name, userId, userName: user.name })]);
    }); } finally { this.identity.forgetTeams(ctx.workspaceId, userId); }
  }

  /** Used by Projects/Boards: is this user an active member of the team? */
  async isMember(teamId: string, userId: string, session?: import('mongodb').ClientSession): Promise<boolean> {
    return !!(await this.repo.membership(teamId, userId, session));
  }

  async memberIds(teamId: string, session?: import('mongodb').ClientSession): Promise<string[]> {
    return (await this.repo.memberships.find({ teamId }, { session, projection: { userId: 1 } }).toArray()).map((m) => m.userId);
  }

  private async staleOrMissing(ctx: RequestContext, teamId: string, expectedVersion: number) {
    const current = await this.repo.findById(ctx.workspaceId, teamId);
    return current ? DomainError.stale(current.version, expectedVersion) : DomainError.notFound('team', teamId);
  }
}
