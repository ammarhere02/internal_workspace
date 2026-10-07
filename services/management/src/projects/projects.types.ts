export type ProjectStatus = 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
export const PROJECT_STATUSES: ProjectStatus[] = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];

export interface ProjectDoc {
  _id: string; workspaceId: string; projectKey: string; name: string; description: string;
  teamId: string; ownerId: string; status: ProjectStatus; startDate: string | null; targetDate: string | null;
  boardId: string; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}

export interface ColumnDef { columnId: string; name: string; order: number; wipLimit: number | null }
export interface BoardDoc {
  _id: string; workspaceId: string; projectId: string; columns: ColumnDef[]; version: number; createdAt: Date; updatedAt: Date;
}

export const DEFAULT_COLUMNS: Array<[string, string]> = [['backlog', 'Backlog'], ['todo', 'To Do'], ['in_progress', 'In Progress'], ['review', 'Review'], ['done', 'Done']];
