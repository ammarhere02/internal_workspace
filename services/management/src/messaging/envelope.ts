import { ulid } from 'ulid';

export type AggregateType = 'Team' | 'Project' | 'Board' | 'WorkItem';

/** Mirrors contracts/schemas/envelope.schema.json. */
export interface EventEnvelope<P extends object = object> {
  eventId: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: string;
  producer: 'management-service';
  workspaceId: string;
  aggregate: { type: AggregateType; id: string; version: number };
  correlationId: string;
  causationId: string;
  actorId: string;
  payload: P;
}

export const EVENT_SUBJECT_PREFIX = 'tm.v1.';
export const subjectFor = (eventType: string) => `${EVENT_SUBJECT_PREFIX}${eventType}`;

export function buildEnvelope<P extends object>(input: {
  eventType: string;
  workspaceId: string;
  aggregate: { type: AggregateType; id: string; version: number };
  correlationId: string;
  causationId: string;
  actorId: string;
  payload: P;
  occurredAt?: Date;
}): EventEnvelope<P> {
  return {
    eventId: ulid(),
    eventType: input.eventType,
    schemaVersion: 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    producer: 'management-service',
    workspaceId: input.workspaceId,
    aggregate: input.aggregate,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actorId: input.actorId,
    payload: input.payload,
  };
}
