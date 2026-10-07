import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jetstream, jetstreamManager, RetentionPolicy, StorageType, type JetStreamClient, type JetStreamManager, type StreamConfig } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { Env } from '../config/env.js';

export const STREAM_NAME = 'TEAM_EVENTS';
export const STREAM_SUBJECTS = ['tm.v1.>'];
/** 7 days / 100 MB keeps the Compose volume small while leaving a replay window that covers the demo. */
export const STREAM_MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
export const STREAM_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Owns the NATS connection, bootstraps the TEAM_EVENTS stream, and publishes
 * durable events. Only the outbox relay (outbox-relay.service.ts) publishes; domain code
 * never talks to NATS directly, it only writes outbox rows.
 */
@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NatsService.name);
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onModuleInit() {
    this.nc = await connect({ servers: this.config.get('NATS_URL'), name: 'management-service', maxReconnectAttempts: -1 });
    this.jsm = await jetstreamManager(this.nc);
    this.js = jetstream(this.nc);
    await this.ensureStream();
    this.log.log(`connected to NATS, stream ${STREAM_NAME} ready`);
  }

  /** Idempotent: creates the stream on first run, otherwise verifies/updates it. */
  async ensureStream(name = STREAM_NAME, subjects = STREAM_SUBJECTS) {
    return ensureStream(this.manager(), name, subjects);
  }

  isConnected(): boolean {
    return !!this.nc && !this.nc.isClosed();
  }

  connection(): NatsConnection {
    if (!this.nc) throw new Error('NATS not connected');
    return this.nc;
  }
  client(): JetStreamClient {
    if (!this.js) throw new Error('NATS not connected');
    return this.js;
  }
  manager(): JetStreamManager {
    if (!this.jsm) throw new Error('NATS not connected');
    return this.jsm;
  }

  async onModuleDestroy() {
    await this.nc?.drain().catch(() => this.nc?.close());
  }
}

/** Idempotent stream bootstrap shared by the app and the integration tests. Python mirrors this config. */
export async function ensureStream(jsm: JetStreamManager, name: string, subjects: string[]) {
  {
    const cfg: Partial<StreamConfig> & { name: string } = {
      name,
      subjects,
      storage: StorageType.File,
      retention: RetentionPolicy.Limits, // events are kept until age/size limits, NOT deleted on ack -> replay is possible
      max_age: STREAM_MAX_AGE_NS,
      max_bytes: STREAM_MAX_BYTES,
      duplicate_window: 2 * 60 * 1_000_000_000, // Nats-Msg-Id dedup window: 2 minutes
      num_replicas: 1,
    };
    try {
      await jsm.streams.info(name);
      await jsm.streams.update(name, cfg);
    } catch {
      await jsm.streams.add(cfg);
    }
  }
}
