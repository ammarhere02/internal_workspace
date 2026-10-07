import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientSession } from 'mongodb';
import { ContractValidator, resolveContractsDir } from '../contracts/validator.js';
import type { Env } from '../config/env.js';
import { DomainError } from '../common/errors/domain-error.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import { type EventEnvelope, subjectFor } from './envelope.js';

/** OutboxEvent document (PDF §7): the whole envelope is kept so the relay republishes it byte-for-byte. */
export interface OutboxDoc {
  _id: string; // = eventId
  subject: string;
  eventType: string;
  schemaVersion: number;
  aggregateId: string;
  workspaceId: string;
  correlationId: string;
  occurredAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  /** Backoff deadline after a failed publish; null/missing = ready now. */
  nextAttemptAt: Date | null;
  /** Set after OUTBOX_MAX_ATTEMPTS failures: excluded from polling, visible on GET /health/relay. */
  failedAt: Date | null;
  /** JetStream sequence from the PubAck (proof of durable acceptance). */
  streamSeq: number | null;
  envelope: EventEnvelope;
}

/**
 * Domain services call append() INSIDE their transaction. The relay (phase 4) reads rows where
 * publishedAt is null. Validation here means a malformed event is rejected together with the command.
 */
@Injectable()
export class OutboxService {
  private readonly validator: ContractValidator;
  constructor(private readonly mongo: MongoService, config: ConfigService<Env, true>) {
    this.validator = new ContractValidator(resolveContractsDir(config.get('CONTRACTS_DIR') || undefined));
  }

  get collection() {
    return this.mongo.collection<OutboxDoc>('outbox');
  }

  async onModuleInit() {
    // Indexes live with the relay store (outbox-relay.store.ts), which owns the polling query.
  }

  async append(session: ClientSession, events: EventEnvelope[]) {
    if (!events.length) return;
    const docs: OutboxDoc[] = events.map((e) => {
      const result = this.validator.validate(e);
      if (!result.ok) throw DomainError.invalid('event_contract_violation', `event ${e.eventType} violates its contract`, { errors: result.errors });
      return {
        _id: e.eventId, subject: subjectFor(e.eventType), eventType: e.eventType, schemaVersion: e.schemaVersion,
        aggregateId: e.aggregate.id, workspaceId: e.workspaceId, correlationId: e.correlationId,
        occurredAt: new Date(e.occurredAt), publishedAt: null, attempts: 0, lastError: null, nextAttemptAt: null, failedAt: null, streamSeq: null, envelope: e,
      };
    });
    await this.collection.insertMany(docs, { session });
  }
}
