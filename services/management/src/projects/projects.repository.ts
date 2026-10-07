import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientSession, Filter } from 'mongodb';
import { keysetFilter, keysetSort } from '../common/pagination.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import type { BoardDoc, ProjectDoc } from './projects.types.js';

@Injectable()
export class ProjectsRepository implements OnModuleInit {
  constructor(private readonly mongo: MongoService) {}
  get projects() { return this.mongo.collection<ProjectDoc>('projects'); }
  get boards() { return this.mongo.collection<BoardDoc>('boards'); }

  async onModuleInit() {
    await this.projects.createIndexes([
      { key: { workspaceId: 1, projectKey: 1 }, name: 'uniq_key_per_workspace', unique: true },
      { key: { workspaceId: 1, teamId: 1, archivedAt: 1 }, name: 'by_team' },
      { key: { workspaceId: 1, archivedAt: 1, _id: 1 }, name: 'list' },
    ]);
    await this.boards.createIndexes([{ key: { workspaceId: 1, projectId: 1 }, name: 'uniq_board_per_project', unique: true }]);
    await this.mongo.ensureValidator('projects', {
      bsonType: 'object', required: ['workspaceId', 'projectKey', 'name', 'teamId', 'ownerId', 'status', 'boardId', 'version'],
      properties: { workspaceId: { bsonType: 'string' }, projectKey: { bsonType: 'string', pattern: '^[A-Z][A-Z0-9]{1,9}$' }, status: { enum: ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] }, version: { bsonType: 'int', minimum: 1 } },
    });
  }

  findById(workspaceId: string, projectId: string, session?: ClientSession) {
    return this.projects.findOne({ _id: projectId, workspaceId }, { session });
  }
  findBoard(workspaceId: string, projectId: string, session?: ClientSession) {
    return this.boards.findOne({ workspaceId, projectId }, { session });
  }
  async list(workspaceId: string, opts: { includeArchived: boolean; teamId?: string; teamIds?: string[] }, limit: number, cursor?: string) {
    const base: Filter<ProjectDoc> = { workspaceId, ...(opts.includeArchived ? {} : { archivedAt: null }), ...(opts.teamId ? { teamId: opts.teamId } : {}) };
    if (opts.teamIds) base.teamId = opts.teamId && opts.teamIds.includes(opts.teamId) ? opts.teamId : { $in: opts.teamIds }; // employee scope
    return this.projects.find(keysetFilter(base, cursor)).sort(keysetSort).limit(limit + 1).toArray();
  }
  updateVersioned(workspaceId: string, projectId: string, expectedVersion: number, set: Partial<ProjectDoc>, session: ClientSession) {
    return this.projects.findOneAndUpdate(
      { _id: projectId, workspaceId, version: expectedVersion },
      { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    );
  }
  updateBoardVersioned(workspaceId: string, boardId: string, expectedVersion: number, set: Partial<BoardDoc>, session: ClientSession) {
    return this.boards.findOneAndUpdate(
      { _id: boardId, workspaceId, version: expectedVersion },
      { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    );
  }
  /** Items assigned to users who would be outside the new team (used by team reassignment). */
  countActiveItemsAssignedOutside(workspaceId: string, projectId: string, allowedUserIds: string[], session: ClientSession) {
    return this.mongo.db.collection('work_items').countDocuments({ workspaceId, projectId, archivedAt: null, assigneeId: { $nin: [null, ...allowedUserIds] } }, { session });
  }
}
