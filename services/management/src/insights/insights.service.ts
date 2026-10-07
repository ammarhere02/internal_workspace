import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import type { RequestContext } from '../common/context.js';
import { DomainError } from '../common/errors/domain-error.js';
import type { Env } from '../config/env.js';
import { INSIGHTS_CLIENT } from '../messaging/messaging.module.js';
import { ProjectsService } from '../projects/projects.service.js';

export const INSIGHTS_SUBJECT = 'tm.query.v1.project_insights';
export const ACTIVITY_SUBJECT = 'tm.query.v1.project_activity';

export interface Freshness { lastProcessedAt: string | null; lastStreamSeq: number | null; lastEventOccurredAt: string | null; processingAgeMs: number | null }
interface PyReply { status: 'ready' | 'not_ready' | 'error'; projectId: string; correlationId: string; freshness: Freshness; error?: { code: string; message: string }; [k: string]: unknown }

/**
 * BFF side of the query path (PDF §8, §13): Core NATS request/reply through the official Nest NATS client,
 * a bounded timeout, and a typed fallback. The projection is NOT authoritative: every reply carries
 * `freshness` so the UI can show how far behind the projection is, and `source: 'projection'`.
 *
 * Mapping: Python `ready`/`not_ready` → 200 with the same status (the UI renders "pending" for not_ready);
 * Python `error`, timeout, no responder, transport error → 503 `insights_unavailable` with `details.reason`.
 * The project itself is checked in management_db first, so unknown/foreign projects are a 404, never a query.
 */
@Injectable()
export class InsightsService {
  private readonly log = new Logger(InsightsService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(INSIGHTS_CLIENT) private readonly client: ClientProxy,
    private readonly projects: ProjectsService,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = config.get('NATS_REQUEST_TIMEOUT_MS');
  }

  async insights(ctx: RequestContext, projectId: string) {
    await this.projects.get(ctx, projectId); // 404 + workspace isolation before anything leaves the service
    return this.ask(INSIGHTS_SUBJECT, { workspaceId: ctx.workspaceId, projectId, correlationId: ctx.correlationId });
  }

  async activity(ctx: RequestContext, projectId: string, limit: number, cursor?: string) {
    await this.projects.get(ctx, projectId);
    return this.ask(ACTIVITY_SUBJECT, { workspaceId: ctx.workspaceId, projectId, correlationId: ctx.correlationId, limit, cursor: cursor ?? null });
  }

  private async ask(subject: string, data: Record<string, unknown>) {
    let reply: PyReply;
    try {
      reply = await firstValueFrom(this.client.send<PyReply>(subject, data).pipe(timeout(this.timeoutMs)));
    } catch (e) {
      const reason = classify(e);
      this.log.warn(`${subject} unavailable (${reason}) correlationId=${String(data.correlationId)}`);
      throw new DomainError(503, 'insights_unavailable', 'insights are temporarily unavailable', { reason, subject, timeoutMs: this.timeoutMs });
    }
    if (!reply || typeof reply !== 'object' || !reply.status) {
      throw new DomainError(503, 'insights_unavailable', 'insights are temporarily unavailable', { reason: 'malformed_reply', subject });
    }
    if (reply.status === 'error') {
      throw new DomainError(503, 'insights_unavailable', reply.error?.message ?? 'insights query failed', { reason: 'responder_error', code: reply.error?.code, subject });
    }
    return { ...reply, source: 'projection' };
  }
}

/** Why the query failed, for the error envelope and the logs. */
export function classify(e: unknown): 'timeout' | 'no_responders' | 'responder_error' | 'transport' {
  const err = e as { name?: string; message?: string; code?: string };
  if (err?.name === 'TimeoutError') return 'timeout';
  if (typeof err?.message === 'string' && /Empty response|no responders/i.test(err.message)) return 'no_responders';
  if (err?.code) return 'responder_error';
  return 'transport';
}
