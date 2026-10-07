import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientSession, Filter } from 'mongodb';
import { keysetFilter, keysetSort } from '../common/pagination.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import type { MembershipDoc, TeamDoc } from './teams.types.js';

/** All reads filter by workspaceId (PDF §13 cross-workspace access). */
@Injectable()
export class TeamsRepository implements OnModuleInit {
  constructor(private readonly mongo: MongoService) {}
  get teams() { return this.mongo.collection<TeamDoc>('teams'); }
  get memberships() { return this.mongo.collection<MembershipDoc>('team_memberships'); }

  async onModuleInit() {
    await this.teams.createIndexes([
      { key: { workspaceId: 1, code: 1 }, name: 'uniq_code_per_workspace', unique: true },
      { key: { workspaceId: 1, archivedAt: 1, _id: 1 }, name: 'list' },
    ]);
    await this.memberships.createIndexes([
      { key: { teamId: 1, userId: 1 }, name: 'uniq_member', unique: true },
      { key: { workspaceId: 1, userId: 1 }, name: 'by_user' },
    ]);
    await this.mongo.ensureValidator('teams', {
      bsonType: 'object', required: ['workspaceId', 'name', 'code', 'version'],
      properties: { workspaceId: { bsonType: 'string' }, name: { bsonType: 'string' }, code: { bsonType: 'string', pattern: '^[A-Z][A-Z0-9]{1,9}$' }, version: { bsonType: 'int', minimum: 1 } },
    });
  }

  findById(workspaceId: string, teamId: string, session?: ClientSession) {
    return this.teams.findOne({ _id: teamId, workspaceId }, { session });
  }

  async list(workspaceId: string, includeArchived: boolean, limit: number, cursor?: string, teamIds?: string[]) {
    const base: Filter<TeamDoc> = { workspaceId, ...(includeArchived ? {} : { archivedAt: null }), ...(teamIds ? { _id: { $in: teamIds } } : {}) };
    return this.teams.find(keysetFilter(base, cursor)).sort(keysetSort).limit(limit + 1).toArray();
  }

  /** Conditional update: only applies if the stored version still equals expectedVersion. */
  updateVersioned(workspaceId: string, teamId: string, expectedVersion: number, set: Partial<TeamDoc>, session: ClientSession) {
    return this.teams.findOneAndUpdate(
      { _id: teamId, workspaceId, version: expectedVersion },
      { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    );
  }

  members(workspaceId: string, teamId: string) {
    return this.memberships.find({ workspaceId, teamId }).sort({ joinedAt: 1, _id: 1 }).toArray();
  }
  membership(teamId: string, userId: string, session?: ClientSession) {
    return this.memberships.findOne({ _id: `${teamId}:${userId}` }, { session });
  }

  /**
   * Read-only check across this service's own collections (projects, work_items) used by the
   * member-removal rule. The "no shared collections" rule is between the two microservices;
   * inside the Management service all collections belong to management_db.
   */
  async countActiveAssignments(workspaceId: string, teamId: string, userId: string, session?: ClientSession) {
    const projectIds = await this.mongo.db.collection('projects').find({ workspaceId, teamId, archivedAt: null }, { projection: { _id: 1 }, session }).map((p) => String(p._id)).toArray();
    if (!projectIds.length) return 0;
    return this.mongo.db.collection('work_items').countDocuments({ workspaceId, projectId: { $in: projectIds }, assigneeId: userId, archivedAt: null }, { session });
  }
}
