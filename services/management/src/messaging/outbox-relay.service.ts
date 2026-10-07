import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import type { Env } from '../config/env.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import { NatsService } from './nats.service.js';
import { OutboxRelay, type RelayPublisher } from './outbox-relay.js';
import { MongoRelayStore } from './outbox-relay.store.js';
import type { OutboxDoc } from './outbox.service.js';
import { publishEnvelope } from './publish.js';

/** Publishes the stored envelope byte-for-byte to its stored subject; resolves after the PubAck. */
export class JetStreamRelayPublisher implements RelayPublisher {
  constructor(private readonly nats: NatsService) {}
  async publish(doc: OutboxDoc) {
    const ack = await publishEnvelope(this.nats.client(), doc.subject, doc.envelope);
    return { seq: ack.seq, duplicate: ack.duplicate === true };
  }
}

/**
 * Starts/stops the background loop
 * Runs the relay loop inside the management process (one timer, no overlapping ticks).
 * OUTBOX_RELAY_ENABLED=false turns it off (request tests, or a deployment with a dedicated relay process).
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutboxRelayService.name);
  readonly store: MongoRelayStore;
  readonly relay: OutboxRelay;
  readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running: Promise<void> = Promise.resolve();
  private readonly pollMs: number;

  constructor(mongo: MongoService, nats: NatsService, config: ConfigService<Env, true>) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED');
    this.pollMs = config.get('OUTBOX_POLL_MS');
    this.store = new MongoRelayStore(mongo.db);
    this.relay = new OutboxRelay(this.store, new JetStreamRelayPublisher(nats), {
      owner: `${hostname()}:${process.pid}`,
      batch: config.get('OUTBOX_BATCH'),
      maxAttempts: config.get('OUTBOX_MAX_ATTEMPTS'),
      leaseMs: Math.max(5000, this.pollMs * 6),
    }, this.log);
  }

  async onModuleInit() {
    await this.store.ensureIndexes();
    if (!this.enabled) { this.log.warn('outbox relay disabled (OUTBOX_RELAY_ENABLED=false)'); return; }
    this.schedule(0);
    this.log.log(`outbox relay started (poll ${this.pollMs} ms)`);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.running = this.runOnce(); }, delay);
  }

  private async runOnce() {
    let delay = this.pollMs;
    try {
      const r = await this.relay.tick();
      if (r.leader && r.published > 0 && r.failed === 0) delay = 0; // drain a backlog without waiting
    } catch (e) {
      this.relay.stats.lastError = e instanceof Error ? e.message : String(e);
      this.log.error(`outbox relay tick failed: ${this.relay.stats.lastError}`);
    }
    this.schedule(delay);
  }

  snapshot() { return this.relay.snapshot(); }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
    await this.relay.release().catch(() => undefined);
  }
}
