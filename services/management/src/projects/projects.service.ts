import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongodb';
import type { RequestContext } from '../common/context.js';
import { DomainError } from '../common/errors/domain-error.js';
import { newId } from '../common/ids.js';
import { toPage } from '../common/pagination.js';
import { IdentityService } from '../identity/identity.service.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import { buildEnvelope, type EventEnvelope } from '../messaging/envelope.js';
import { OutboxService } from '../messaging/outbox.service.js';
import { TeamsService } from '../teams/teams.service.js';
import type { ArchiveProjectDto, AssignTeamDto, CreateProjectDto, UpdateProjectDto } from './dto/projects.dto.js';
import { ProjectsRepository } from './projects.repository.js';
import { type BoardDoc, DEFAULT_COLUMNS, type ProjectDoc } from './projects.types.js';

/**
 * Projects module (TM-03, TM-04, TM-05 initialisation). Creating a project also creates its single
 * default board; both documents and both events (project.created, board.created) commit in one transaction.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly repo: ProjectsRepository,
    private readonly mongo: MongoService,
    private readonly outbox: OutboxService,
    private readonly teams: TeamsService,
    private readonly identity: IdentityService,
  ) {}

  private projectEvent(ctx: RequestContext, p: ProjectDoc, eventType: string, payload: object): EventEnvelope {
    return buildEnvelope({ eventType, workspaceId: ctx.workspaceId, aggregate: { type: 'Project', id: p._id, version: p.version }, correlationId: ctx.correlationId, causationId: newId('cmd'), actorId: ctx.actorId, payload });
  }
  boardEvent(ctx: RequestContext, b: BoardDoc, eventType: string): EventEnvelope {
    return buildEnvelope({ eventType, workspaceId: ctx.workspaceId, aggregate: { type: 'Board', id: b._id, version: b.version }, correlationId: ctx.correlationId, causationId: newId('cmd'), actorId: ctx.actorId, payload: { boardId: b._id, projectId: b.projectId, columns: b.columns } });
  }

  async create(ctx: RequestContext, dto: CreateProjectDto): Promise<ProjectDoc> {
    const team = await this.teams.getActive(ctx, dto.teamId);
    const ownerId = dto.ownerId ?? ctx.actorId;
    await this.identity.getActiveUser(ctx.workspaceId, ownerId);
    if (!(await this.teams.isMember(team._id, ownerId))) throw DomainError.invalid('owner_not_in_team', `project owner must be a member of team ${team.code}`);
    const now = new Date();
    const boardId = newId('brd');
    const project: ProjectDoc = {
      _id: newId('prj'), workspaceId: ctx.workspaceId, projectKey: dto.projectKey, name: dto.name, description: dto.description ?? '',
      teamId: team._id, ownerId, status: dto.status ?? 'PLANNED', startDate: dto.startDate ?? null, targetDate: dto.targetDate ?? null,
      boardId, archivedAt: null, version: 1, createdAt: now, updatedAt: now,
    };
    const board: BoardDoc = {
      _id: boardId, workspaceId: ctx.workspaceId, projectId: project._id, version: 1, createdAt: now, updatedAt: now,
      columns: DEFAULT_COLUMNS.map(([columnId, name], order) => ({ columnId, name, order, wipLimit: null })),
    };
    await this.mongo.withTransaction(async (session) => {
      await this.repo.projects.insertOne(project, { session });
      await this.repo.boards.insertOne(board, { session });
      await this.outbox.append(session, [
        this.projectEvent(ctx, project, 'project.created', { projectId: project._id, projectKey: project.projectKey, name: project.name, teamId: project.teamId, ownerId, status: project.status }),
        this.boardEvent(ctx, board, 'board.created'),
      ]);
    });
    return project;
  }

  async get(ctx: RequestContext, projectId: string, session?: ClientSession): Promise<ProjectDoc> {
    const p = await this.repo.findById(ctx.workspaceId, projectId, session);
    // employees only see projects of their teams; outside the scope the project "does not exist" (no existence leak)
    if (!p || (ctx.teamIds && !ctx.teamIds.includes(p.teamId))) throw DomainError.notFound('project', projectId);
    return p;
  }
  async getActive(ctx: RequestContext, projectId: string, session?: ClientSession): Promise<ProjectDoc> {
    const p = await this.get(ctx, projectId, session);
    if (p.archivedAt) throw DomainError.conflict('project_archived', `project ${p.projectKey} is archived`);
    return p;
  }
  async getBoard(ctx: RequestContext, projectId: string, session?: ClientSession): Promise<BoardDoc> {
    const b = await this.repo.findBoard(ctx.workspaceId, projectId, session);
    if (!b) throw DomainError.notFound('board for project', projectId);
    return b;
  }

  async list(ctx: RequestContext, opts: { includeArchived: boolean; teamId?: string }, limit: number, cursor?: string) {
    return toPage(await this.repo.list(ctx.workspaceId, { ...opts, teamIds: ctx.teamIds ?? undefined }, limit, cursor), limit);
  }

  async update(ctx: RequestContext, projectId: string, dto: UpdateProjectDto): Promise<ProjectDoc> {
    const { expectedVersion, ...rest } = dto;
    const set: Partial<ProjectDoc> = {};
    const changed: string[] = [];
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) { (set as Record<string, unknown>)[k] = v; changed.push(k); }
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActive(ctx, projectId, session);
      if (set.ownerId && !(await this.teams.isMember(before.teamId, set.ownerId, session))) throw DomainError.invalid('owner_not_in_team', 'project owner must be a member of the owning team');
      const p = await this.repo.updateVersioned(ctx.workspaceId, projectId, expectedVersion, set, session);
      if (!p) throw DomainError.stale(before.version, expectedVersion);
      await this.outbox.append(session, [this.projectEvent(ctx, p, 'project.updated', { projectId: p._id, projectKey: p.projectKey, name: p.name, status: p.status, changedFields: changed })]);
      return p;
    });
  }

  /** TM-04: one owning team. Rejected while any active item is assigned to someone outside the new team. */
  async assignTeam(ctx: RequestContext, projectId: string, dto: AssignTeamDto): Promise<ProjectDoc> {
    const team = await this.teams.getActive(ctx, dto.teamId);
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActive(ctx, projectId, session);
      if (before.teamId === team._id) return before;
      const members = (await this.teams.memberIds(team._id, session));
      if (!members.includes(before.ownerId)) throw DomainError.invalid('owner_not_in_team', `project owner is not a member of team ${team.code}; change the owner first`);
      const outside = await this.repo.countActiveItemsAssignedOutside(ctx.workspaceId, projectId, members, session);
      if (outside > 0) throw DomainError.invalid('assignees_outside_team', `${outside} active work item(s) are assigned to users outside team ${team.code}; reassign them first`, { count: outside });
      const p = await this.repo.updateVersioned(ctx.workspaceId, projectId, dto.expectedVersion, { teamId: team._id }, session);
      if (!p) throw DomainError.stale(before.version, dto.expectedVersion);
      await this.outbox.append(session, [this.projectEvent(ctx, p, 'project.team_assigned', { projectId: p._id, projectKey: p.projectKey, teamId: team._id, previousTeamId: before.teamId })]);
      return p;
    });
  }

  async archive(ctx: RequestContext, projectId: string, dto: ArchiveProjectDto): Promise<ProjectDoc> {
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActive(ctx, projectId, session);
      const p = await this.repo.updateVersioned(ctx.workspaceId, projectId, dto.expectedVersion, { archivedAt: new Date(), status: 'ARCHIVED' }, session);
      if (!p) throw DomainError.stale(before.version, dto.expectedVersion);
      await this.outbox.append(session, [this.projectEvent(ctx, p, 'project.updated', { projectId: p._id, projectKey: p.projectKey, name: p.name, status: p.status, changedFields: ['status', 'archivedAt'] })]);
      return p;
    });
  }
}
