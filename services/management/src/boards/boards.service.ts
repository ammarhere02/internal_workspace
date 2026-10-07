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
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { BoardDoc, ColumnDef, ProjectDoc } from '../projects/projects.types.js';
import { TeamsService } from '../teams/teams.service.js';
import { BoardsRepository } from './boards.repository.js';
import { toItemState, type WorkItemDoc } from './boards.types.js';
import type { ArchiveItemDto, AssignItemDto, CreateItemDto, ListItemsQuery, MoveItemDto, UpdateColumnsDto, UpdateItemDto } from './dto/boards.dto.js';
import { FIRST_RANK, rankAfter, rankBefore, rankBetween } from './rank.js';

/**
 * Boards module (TM-05 columns, TM-06..TM-09, TM-11). Owns work items, issue-key sequences, ranks and
 * version conflicts. Every command: load inside the transaction -> check rules -> conditional update on
 * version -> outbox event with the full post-state snapshot -> commit.
 */
@Injectable()
export class BoardsService {
  constructor(
    private readonly repo: BoardsRepository,
    private readonly projectsRepo: ProjectsRepository,
    private readonly projects: ProjectsService,
    private readonly teams: TeamsService,
    private readonly identity: IdentityService,
    private readonly mongo: MongoService,
    private readonly outbox: OutboxService,
  ) {}

  private itemEvent(ctx: RequestContext, item: WorkItemDoc, eventType: string, extra: object = {}): EventEnvelope {
    return buildEnvelope({
      eventType, workspaceId: ctx.workspaceId, aggregate: { type: 'WorkItem', id: item._id, version: item.version },
      correlationId: ctx.correlationId, causationId: newId('cmd'), actorId: ctx.actorId, payload: { item: toItemState(item), ...extra },
    });
  }

  /** Unauthorized assignment guard (PDF §13): assignee must be an active member of the project's CURRENT team. */
  private async assertAssignable(ctx: RequestContext, project: ProjectDoc, assigneeId: string | null, session?: ClientSession) {
    if (assigneeId === null) return;
    const user = await this.identity.getActiveUser(ctx.workspaceId, assigneeId);
    if (!(await this.teams.isMember(project.teamId, user._id, session))) {
      throw DomainError.invalid('assignee_not_in_team', `${user.name} is not a member of the team that owns project ${project.projectKey}`, { assigneeId, teamId: project.teamId });
    }
  }

  private column(board: BoardDoc, columnId: string): ColumnDef {
    const c = board.columns.find((c) => c.columnId === columnId);
    if (!c) throw DomainError.invalid('unknown_column', `column ${columnId} does not exist on this board`, { columnId });
    return c;
  }

  // ---- board read -------------------------------------------------------------------------------

  /** GET /api/projects/{id}/board: columns with ordered cards and counts (authoritative read, not a projection). */
  async board(ctx: RequestContext, projectId: string) {
    const project = await this.projects.get(ctx, projectId);
    const board = await this.projects.getBoard(ctx, projectId);
    const items = await this.repo.boardItems(ctx.workspaceId, projectId);
    const columns = [...board.columns].sort((a, b) => a.order - b.order).map((c) => {
      const cards = items.filter((i) => i.columnId === c.columnId).map(itemView);
      return { ...c, count: cards.length, wipExceeded: c.wipLimit !== null && cards.length > c.wipLimit, items: cards };
    });
    return { projectId, projectKey: project.projectKey, teamId: project.teamId, boardId: board._id, version: board.version, columns };
  }

  async updateColumns(ctx: RequestContext, projectId: string, dto: UpdateColumnsDto): Promise<BoardDoc> {
    return this.mongo.withTransaction(async (session) => {
      await this.projects.getActive(ctx, projectId, session);
      const board = await this.projects.getBoard(ctx, projectId, session);
      const columns: ColumnDef[] = dto.columns.map((c, order) => ({ columnId: c.columnId ?? newId('col'), name: c.name, order, wipLimit: c.wipLimit ?? null }));
      const ids = columns.map((c) => c.columnId);
      if (new Set(ids).size !== ids.length) throw DomainError.invalid('duplicate_column', 'column ids must be unique');
      const removed = board.columns.map((c) => c.columnId).filter((id) => !ids.includes(id));
      if (removed.length) {
        const occupied = await this.repo.countInColumns(ctx.workspaceId, projectId, removed, session);
        if (occupied > 0) throw DomainError.invalid('column_not_empty', `cannot remove columns that still hold ${occupied} card(s); move them first`, { removed, occupied });
      }
      const updated = await this.projectsRepo.updateBoardVersioned(ctx.workspaceId, board._id, dto.expectedVersion, { columns }, session);
      if (!updated) throw DomainError.stale(board.version, dto.expectedVersion);
      await this.outbox.append(session, [this.projects.boardEvent(ctx, updated, 'board.columns_updated')]);
      return updated;
    });
  }

  // ---- work items ------------------------------------------------------------------------------

  async createItem(ctx: RequestContext, projectId: string, dto: CreateItemDto): Promise<WorkItemDoc> {
    return this.mongo.withTransaction(async (session) => {
      const project = await this.projects.getActive(ctx, projectId, session);
      const board = await this.projects.getBoard(ctx, projectId, session);
      const columnId = dto.columnId ?? [...board.columns].sort((a, b) => a.order - b.order)[0]!.columnId;
      this.column(board, columnId);
      const assigneeId = dto.assigneeId ?? null;
      await this.assertAssignable(ctx, project, assigneeId, session);
      const n = await this.repo.nextIssueNumber(ctx.workspaceId, projectId, session);
      const last = (await this.repo.columnItems(ctx.workspaceId, projectId, columnId, session)).at(-1);
      const now = new Date();
      const item: WorkItemDoc = {
        _id: newId('wi'), workspaceId: ctx.workspaceId, projectId, boardId: board._id, issueKey: `${project.projectKey}-${n}`,
        columnId, rank: last ? rankAfter(last.rank) : FIRST_RANK, type: dto.type, priority: dto.priority, title: dto.title,
        description: dto.description ?? '', acceptanceNotes: dto.acceptanceNotes ?? '', reporterId: ctx.actorId, assigneeId,
        labels: dto.labels ?? [], dueDate: dto.dueDate ?? null, archivedAt: null, version: 1, createdAt: now, updatedAt: now,
      };
      await this.repo.items.insertOne(item, { session });
      await this.outbox.append(session, [this.itemEvent(ctx, item, 'workitem.created')]);
      return item;
    });
  }

  async getItem(ctx: RequestContext, itemId: string, session?: ClientSession): Promise<WorkItemDoc> {
    const item = await this.repo.findById(ctx.workspaceId, itemId, session);
    if (!item) throw DomainError.notFound('work item', itemId);
    return item;
  }
  private async getActiveItem(ctx: RequestContext, itemId: string, session: ClientSession): Promise<WorkItemDoc> {
    const item = await this.getItem(ctx, itemId, session);
    if (item.archivedAt) throw DomainError.conflict('item_archived', `${item.issueKey} is archived`);
    return item;
  }

  async listItems(ctx: RequestContext, projectId: string, q: ListItemsQuery) {
    await this.projects.get(ctx, projectId);
    return toPage(await this.repo.list(ctx.workspaceId, projectId, q), q.limit);
  }

  /** PATCH /api/items/{id}: editable fields; issueKey, project, reporter and column are not editable here. */
  async updateItem(ctx: RequestContext, itemId: string, dto: UpdateItemDto): Promise<WorkItemDoc> {
    const { expectedVersion, ...rest } = dto;
    const set: Partial<WorkItemDoc> = {};
    const changed: string[] = [];
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) { (set as Record<string, unknown>)[k] = v; changed.push(k); }
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActiveItem(ctx, itemId, session);
      if (!changed.length) return before;
      const item = await this.repo.updateVersioned(ctx.workspaceId, itemId, expectedVersion, set, session);
      if (!item) throw DomainError.stale(before.version, expectedVersion);
      await this.outbox.append(session, [this.itemEvent(ctx, item, 'workitem.updated', { changedFields: changed })]);
      return item;
    });
  }

  async assignItem(ctx: RequestContext, itemId: string, dto: AssignItemDto): Promise<WorkItemDoc> {
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActiveItem(ctx, itemId, session);
      const project = await this.projects.getActive(ctx, before.projectId, session);
      await this.assertAssignable(ctx, project, dto.assigneeId, session);
      if (before.assigneeId === dto.assigneeId) return before;
      const item = await this.repo.updateVersioned(ctx.workspaceId, itemId, dto.expectedVersion, { assigneeId: dto.assigneeId }, session);
      if (!item) throw DomainError.stale(before.version, dto.expectedVersion);
      await this.outbox.append(session, [this.itemEvent(ctx, item, 'workitem.assigned', { previousAssigneeId: before.assigneeId })]);
      return item;
    });
  }

  /**
   * POST /api/items/{id}/move (TM-08). The new rank is computed from the target column's current
   * neighbours inside the transaction, then written only if the item's version is still expectedVersion.
   * Two users moving the same card: the second one gets 409 and must refresh.
   */
  async moveItem(ctx: RequestContext, itemId: string, dto: MoveItemDto): Promise<WorkItemDoc> {
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActiveItem(ctx, itemId, session);
      await this.projects.getActive(ctx, before.projectId, session);
      const board = await this.projects.getBoard(ctx, before.projectId, session);
      this.column(board, dto.toColumnId);
      const siblings = (await this.repo.columnItems(ctx.workspaceId, before.projectId, dto.toColumnId, session)).filter((i) => i._id !== itemId);
      let rank: string;
      if (dto.afterItemId === undefined) {
        rank = siblings.length ? rankAfter(siblings.at(-1)!.rank) : FIRST_RANK;            // bottom
      } else if (dto.afterItemId === null) {
        rank = siblings.length ? rankBefore(siblings[0]!.rank) : FIRST_RANK;               // top
      } else {
        const idx = siblings.findIndex((i) => i._id === dto.afterItemId);
        if (idx < 0) throw DomainError.invalid('anchor_not_in_column', `afterItemId ${dto.afterItemId} is not in column ${dto.toColumnId}`);
        // Concurrent moves can leave equal ranks (ties are ordered by _id, so the board stays deterministic).
        // Anchor on the first strictly greater rank so rankBetween never sees prev >= next; the card lands
        // right after the tied group, which is the closest valid "after X" position.
        const anchor = siblings[idx]!;
        const upper = siblings.slice(idx + 1).find((s) => s.rank > anchor.rank);
        rank = upper ? rankBetween(anchor.rank, upper.rank) : rankAfter(anchor.rank);
      }
      const item = await this.repo.updateVersioned(ctx.workspaceId, itemId, dto.expectedVersion, { columnId: dto.toColumnId, rank }, session);
      if (!item) throw DomainError.stale(before.version, dto.expectedVersion);
      await this.outbox.append(session, [this.itemEvent(ctx, item, 'workitem.moved', { fromColumnId: before.columnId, toColumnId: dto.toColumnId })]);
      return item;
    });
  }

  async archiveItem(ctx: RequestContext, itemId: string, dto: ArchiveItemDto): Promise<WorkItemDoc> {
    return this.mongo.withTransaction(async (session) => {
      const before = await this.getActiveItem(ctx, itemId, session);
      const item = await this.repo.updateVersioned(ctx.workspaceId, itemId, dto.expectedVersion, { archivedAt: new Date() }, session);
      if (!item) throw DomainError.stale(before.version, dto.expectedVersion);
      await this.outbox.append(session, [this.itemEvent(ctx, item, 'workitem.archived')]);
      return item;
    });
  }
}

export const itemView = (i: WorkItemDoc) => ({
  id: i._id, issueKey: i.issueKey, projectId: i.projectId, boardId: i.boardId, columnId: i.columnId, rank: i.rank, type: i.type,
  priority: i.priority, title: i.title, description: i.description, acceptanceNotes: i.acceptanceNotes, reporterId: i.reporterId,
  assigneeId: i.assigneeId, labels: i.labels, dueDate: i.dueDate, archivedAt: i.archivedAt, version: i.version, createdAt: i.createdAt, updatedAt: i.updatedAt,
});
