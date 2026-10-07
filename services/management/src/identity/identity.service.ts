import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { DomainError } from '../common/errors/domain-error.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import type { UserDoc, UserRole, WorkspaceDoc } from './identity.types.js';
import { newId } from '../common/ids.js';

/**
 * Identity / Workspace module (PDF §9): seeds ONE development workspace with fictional users and
 * resolves the trusted request context. The workspace comes from server config (WORKSPACE_SLUG),
 * never from the browser. Full RBAC is a stretch goal; workspace isolation is mandatory.
 */
@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly log = new Logger(IdentityService.name);
  private workspace!: WorkspaceDoc;
  /** Every /api call needs the actor + their team ids; a short-lived cache saves 1–2 database round trips per request. */
  private readonly userCache = new TtlCache<UserDoc | null>(CACHE_TTL_MS);
  private readonly teamCache = new TtlCache<string[]>(CACHE_TTL_MS);

  constructor(private readonly mongo: MongoService, private readonly config: ConfigService<Env, true>) {}

  get workspaces() { return this.mongo.collection<WorkspaceDoc>('workspaces'); }
  get users() { return this.mongo.collection<UserDoc>('users'); }

  async onModuleInit() {
    await this.workspaces.createIndexes([{ key: { slug: 1 }, name: 'uniq_slug', unique: true }]);
    await this.users.createIndexes([
      { key: { workspaceId: 1, emailNormalized: 1 }, name: 'uniq_email_per_workspace', unique: true },
      { key: { workspaceId: 1, _id: 1 }, name: 'ws_id' },
    ]);
    await this.mongo.ensureValidator('users', {
      bsonType: 'object', required: ['workspaceId', 'name', 'email', 'emailNormalized', 'active'],
      properties: { workspaceId: { bsonType: 'string' }, name: { bsonType: 'string' }, email: { bsonType: 'string' }, active: { bsonType: 'bool' } },
    });
    this.workspace = await this.seed(this.config.get('WORKSPACE_SLUG'));
  }

  /** Deterministic ids so demos, docs and tests can refer to the same fictional people. */
  async seed(slug: string): Promise<WorkspaceDoc> {
    const wsId = `ws_${slug}`;
    await this.workspaces.updateOne({ _id: wsId }, { $setOnInsert: { name: `${slug} workspace`, slug, createdAt: new Date() } }, { upsert: true });
    const people: Array<[string, string, string, UserRole]> = [
      ['usr_admin', 'Avery Admin', 'avery.admin@example.test', 'ADMIN'],
      ['usr_blake', 'Blake Lead', 'blake.lead@example.test', 'EMPLOYEE'],
      ['usr_casey', 'Casey Dev', 'casey.dev@example.test', 'EMPLOYEE'],
      ['usr_dana', 'Dana Dev', 'dana.dev@example.test', 'EMPLOYEE'],
      ['usr_eli', 'Eli Outsider', 'eli.outsider@example.test', 'EMPLOYEE'],
    ];
    for (const [id, name, email, role] of people) {
      await this.users.updateOne(
        { _id: `${id}_${slug}` },
        { $setOnInsert: { workspaceId: wsId, name, email, emailNormalized: email.toLowerCase(), active: true, createdAt: new Date() }, $set: { role } },
        { upsert: true },
      );
    }
    // users created before roles existed default to EMPLOYEE
    await this.users.updateMany({ workspaceId: wsId, role: { $exists: false } }, { $set: { role: 'EMPLOYEE' } });
    this.log.log(`workspace ${wsId} seeded with ${people.length} users`);
    return (await this.workspaces.findOne({ _id: wsId }))!;
  }

  currentWorkspace(): WorkspaceDoc {
    return this.workspace;
  }

  /** Dev identity: optional x-dev-user header picks a seeded user; default is the admin. Must belong to the workspace. */
  async resolveActor(devUser?: string): Promise<UserDoc> {
    const id = `${devUser || 'usr_admin'}_${this.workspace.slug}`;
    const user = await this.findActive(id);
    if (!user) throw new DomainError(401, 'unknown_actor', `no active user ${id} in this workspace`);
    return user;
  }

  /** Role rule for Google sign-in: ADMIN_EMAILS allowlist, everyone else EMPLOYEE. */
  roleFor(email: string): UserRole {
    return roleForEmail(email, this.config.get('ADMIN_EMAILS'));
  }

  /** Google sign-in: find the workspace user by e-mail or create one (auto-enrol). Role follows the allowlist on every login. */
  async upsertGoogleUser(profile: { id: string; email: string; name: string }): Promise<UserDoc> {
    const emailNormalized = profile.email.trim().toLowerCase();
    const role = this.roleFor(emailNormalized);
    const now = new Date();
    const existing = await this.users.findOne({ workspaceId: this.workspace._id, emailNormalized });
    if (existing) {
      if (!existing.active) throw new DomainError(403, 'user_inactive', 'this account has been deactivated in the workspace');
      await this.users.updateOne({ _id: existing._id }, { $set: { role, googleId: profile.id, lastLoginAt: now } });
      this.userCache.delete(existing._id); // role may have changed with the allowlist
      return { ...existing, role, googleId: profile.id, lastLoginAt: now };
    }
    const user: UserDoc = { _id: newId('usr'), workspaceId: this.workspace._id, name: profile.name || emailNormalized, email: profile.email, emailNormalized, active: true, createdAt: now, role, googleId: profile.id, lastLoginAt: now };
    await this.users.insertOne(user);
    this.log.log(`new ${role} user enrolled via Google in ${this.workspace._id}`); // no e-mail in logs
    return user;
  }

  /** E-mail/password sign-up (role from the same allowlist as Google). 409 if the e-mail already exists. */
  async createLocalUser(input: { name: string; email: string; passwordHash: string }): Promise<UserDoc> {
    const emailNormalized = input.email.trim().toLowerCase();
    if (await this.users.findOne({ workspaceId: this.workspace._id, emailNormalized })) throw new DomainError(409, 'email_taken', 'an account with this e-mail already exists; sign in instead');
    const now = new Date();
    const user: UserDoc = { _id: newId('usr'), workspaceId: this.workspace._id, name: input.name, email: input.email.trim(), emailNormalized, active: true, createdAt: now, role: this.roleFor(emailNormalized), passwordHash: input.passwordHash, lastLoginAt: now };
    await this.users.insertOne(user);
    this.log.log(`new ${user.role} user registered with e-mail/password in ${this.workspace._id}`);
    return user;
  }

  /** The e-mail is already a validated string here (LoginDto); normalising keeps the lookup a plain equality match. */
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.findOne({ workspaceId: this.workspace._id, emailNormalized: String(email).trim().toLowerCase() });
  }

  async touchLogin(userId: string) {
    await this.users.updateOne({ _id: userId }, { $set: { lastLoginAt: new Date() } });
  }

  /** Session rehydration: the session stores only the user id; the record is re-read on every request. */
  async findActive(userId: string): Promise<UserDoc | null> {
    return this.userCache.get(userId, () => this.users.findOne({ _id: userId, workspaceId: this.workspace._id, active: true }));
  }

  /** Teams the user belongs to: the read scope of an EMPLOYEE. */
  async teamIdsOf(workspaceId: string, userId: string): Promise<string[]> {
    return this.teamCache.get(`${workspaceId}:${userId}`, () => this.mongo.db.collection('team_memberships').find({ workspaceId, userId }, { projection: { teamId: 1 } }).map((m) => String(m.teamId)).toArray());
  }

  /** Membership changed: the user's read scope must apply on their very next request. */
  forgetTeams(workspaceId: string, userId: string) {
    this.teamCache.delete(`${workspaceId}:${userId}`);
  }

  async listUsers(workspaceId: string): Promise<UserDoc[]> {
    return this.users.find({ workspaceId, active: true }).sort({ name: 1 }).toArray();
  }

  async getActiveUser(workspaceId: string, userId: string): Promise<UserDoc> {
    const u = await this.users.findOne({ _id: userId, workspaceId, active: true });
    if (!u) throw DomainError.notFound('user', userId);
    return u;
  }
}

/** Pure rule, unit-tested: an e-mail is ADMIN when it is on the comma-separated allowlist (case-insensitive). */
export function roleForEmail(email: string, adminEmails: string): UserRole {
  const allow = adminEmails.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allow.includes(email.trim().toLowerCase()) ? 'ADMIN' : 'EMPLOYEE';
}

const CACHE_TTL_MS = 5_000;

/** Tiny TTL cache that also shares an in-flight lookup between concurrent requests. */
class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key), now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    if (this.entries.size > 1000) this.entries.clear();
    const value = load();
    this.entries.set(key, { at: now, value });
    value.catch(() => this.entries.delete(key)); // never cache a failure
    return value;
  }
  delete(key: string) { this.entries.delete(key); }
}
