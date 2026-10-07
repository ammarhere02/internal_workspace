export type ItemType = 'STORY' | 'TASK' | 'BUG' | 'EPIC';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const ITEM_TYPES: ItemType[] = ['STORY', 'TASK', 'BUG', 'EPIC'];
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface WorkItemDoc {
  _id: string; workspaceId: string; projectId: string; boardId: string; issueKey: string; columnId: string; rank: string;
  type: ItemType; priority: Priority; title: string; description: string; acceptanceNotes: string;
  reporterId: string; assigneeId: string | null; labels: string[]; dueDate: string | null;
  archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}
export interface IssueSequenceDoc { _id: string; workspaceId: string; next: number }

/** Snapshot carried in every workitem.* event payload (contracts/events/common.schema.json#workItemState). */
export const toItemState = (i: WorkItemDoc) => ({
  itemId: i._id, issueKey: i.issueKey, projectId: i.projectId, boardId: i.boardId, columnId: i.columnId, rank: i.rank,
  type: i.type, priority: i.priority, title: i.title, reporterId: i.reporterId, assigneeId: i.assigneeId,
  labels: i.labels, dueDate: i.dueDate, archived: i.archivedAt !== null,
});
