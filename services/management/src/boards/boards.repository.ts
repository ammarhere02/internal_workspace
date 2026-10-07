import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientSession, Filter } from 'mongodb';
import { keysetFilter, keysetSort } from '../common/pagination.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import type { IssueSequenceDoc, WorkItemDoc } from './boards.types.js';
import type { ListItemsQuery } from './dto/boards.dto.js';

@Injectable()
export class BoardsRepository implements OnModuleInit {
  constructor(private readonly mongo: MongoService) {}
  get items() { return this.mongo.collection<WorkItemDoc>('work_items'); }
  get sequences() { return this.mongo.collection<IssueSequenceDoc>('issue_sequences'); }

  async onModuleInit() {
    await this.items.createIndexes([
      { key: { workspaceId: 1, issueKey: 1 }, name: 'uniq_issue_key', unique: true },
      { key: { workspaceId: 1, projectId: 1, archivedAt: 1, columnId: 1, rank: 1, _id: 1 }, name: 'board_order' },
      { key: { workspaceId: 1, projectId: 1, assigneeId: 1, archivedAt: 1 }, name: 'by_assignee' },
      { key: { workspaceId: 1, projectId: 1, dueDate: 1 }, name: 'by_due' },
      { key: { title: 'text', description: 'text', issueKey: 'text' }, name: 'text_search' },
    ]);
    await this.mongo.ensureValidator('work_items', {
      bsonType: 'object', required: ['workspaceId', 'projectId', 'boardId', 'issueKey', 'columnId', 'rank', 'type', 'priority', 'title', 'reporterId', 'labels', 'version'],
      properties: {
        issueKey: { bsonType: 'string', pattern: '^[A-Z][A-Z0-9]{1,9}-[0-9]+$' },
        type: { enum: ['STORY', 'TASK', 'BUG', 'EPIC'] }, priority: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        labels: { bsonType: 'array', items: { bsonType: 'string' } }, version: { bsonType: 'int', minimum: 1 },
      },
    });
  }

  /** Atomic per-project counter; runs inside the item-creation transaction so a rolled-back item never burns a visible gap in the demo. */
  async nextIssueNumber(workspaceId: string, projectId: string, session: ClientSession): Promise<number> {
    const r = await this.sequences.findOneAndUpdate({ _id: projectId }, { $inc: { next: 1 }, $setOnInsert: { workspaceId } }, { upsert: true, returnDocument: 'after', session });
    return r!.next;
  }

  findById(workspaceId: string, itemId: string, session?: ClientSession) {
    return this.items.findOne({ _id: itemId, workspaceId }, { session });
  }

  /** Active items of one project in board order. */
  boardItems(workspaceId: string, projectId: string, session?: ClientSession) {
    return this.items.find({ workspaceId, projectId, archivedAt: null }, { session }).sort({ columnId: 1, rank: 1, _id: 1 }).toArray();
  }

  columnItems(workspaceId: string, projectId: string, columnId: string, session: ClientSession) {
    return this.items.find({ workspaceId, projectId, columnId, archivedAt: null }, { session }).sort({ rank: 1, _id: 1 }).toArray();
  }

  countInColumns(workspaceId: string, projectId: string, columnIds: string[], session: ClientSession) {
    return this.items.countDocuments({ workspaceId, projectId, archivedAt: null, columnId: { $in: columnIds } }, { session });
  }

  async list(workspaceId: string, projectId: string, q: ListItemsQuery) {
    const f: Filter<WorkItemDoc> = { workspaceId, projectId };
    if (q.includeArchived !== 'true') f.archivedAt = null;
    if (q.assigneeId) f.assigneeId = q.assigneeId === 'unassigned' ? null : q.assigneeId;
    if (q.priority) f.priority = q.priority;
    if (q.type) f.type = q.type;
    if (q.label) f.labels = q.label;
    if (q.columnId) f.columnId = q.columnId;
    if (q.q) f.$text = { $search: q.q };
    return this.items.find(keysetFilter(f, q.cursor)).sort(keysetSort).limit(q.limit + 1).toArray();
  }

  updateVersioned(workspaceId: string, itemId: string, expectedVersion: number, set: Partial<WorkItemDoc>, session: ClientSession) {
    return this.items.findOneAndUpdate(
      { _id: itemId, workspaceId, version: expectedVersion },
      { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    );
  }
}
