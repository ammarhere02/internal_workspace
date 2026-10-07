export type Role = 'OWNER' | 'LEAD' | 'MEMBER';
export const ROLES: Role[] = ['OWNER', 'LEAD', 'MEMBER'];

export interface TeamDoc {
  _id: string; workspaceId: string; name: string; code: string; description: string;
  archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}
export interface MembershipDoc {
  _id: string; // `${teamId}:${userId}`
  workspaceId: string; teamId: string; userId: string; role: Role; joinedAt: Date;
}
