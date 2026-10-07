export interface WorkspaceDoc { _id: string; name: string; slug: string; createdAt: Date }
export type UserRole = 'ADMIN' | 'EMPLOYEE';
export const USER_ROLES: UserRole[] = ['ADMIN', 'EMPLOYEE'];

export interface UserDoc {
  _id: string; workspaceId: string; name: string; email: string; emailNormalized: string; active: boolean; createdAt: Date;
  /** ADMIN manages teams/projects/boards; EMPLOYEE works on the boards of the teams they belong to. */
  role: UserRole;
  /** Set when the user signed in with Google (AUTH_MODE=google). */
  googleId?: string | null;
  /** scrypt hash for e-mail/password sign-in (employees); absent for Google-only or seeded users. */
  passwordHash?: string | null;
  lastLoginAt?: Date | null;
}
