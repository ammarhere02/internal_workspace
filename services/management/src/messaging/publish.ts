import type { JetStreamClient, PubAck } from '@nats-io/jetstream';
import { headers } from '@nats-io/transport-node';
import { CORRELATION_HEADER } from '../common/logging/logging.module.js';
import type { EventEnvelope } from './envelope.js';

/**
 * Publish one event and wait for the JetStream acknowledgement (the broker has written it to disk).
 * Nats-Msg-Id = eventId lets the broker drop a re-publish inside the stream's duplicate window;
 * the Python inbox stays the real guard because that window is finite (2 min).
 */
export async function publishEnvelope(js: JetStreamClient, subject: string, event: EventEnvelope): Promise<PubAck> {
  const h = headers();
  h.set('Nats-Msg-Id', event.eventId);
  h.set(CORRELATION_HEADER, event.correlationId);
  h.set('x-event-type', event.eventType);
  h.set('x-schema-version', String(event.schemaVersion));
  h.set('x-aggregate-id', event.aggregate.id); // lets the consumer log aggregateId before it parses the body
  return js.publish(subject, JSON.stringify(event), { msgID: event.eventId, headers: h, timeout: 5000 });
}
