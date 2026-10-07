import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MongoService } from '../infra/mongo/mongo.module.js';
import { NatsService } from '../messaging/nats.service.js';
import { OutboxRelayService } from '../messaging/outbox-relay.service.js';

/**
 * Liveness = process is up (no dependency checks, PDF §13).
 * Readiness = owned database and NATS are reachable; 503 otherwise.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly mongo: MongoService,
    private readonly nats: NatsService,
    private readonly relay: OutboxRelayService,
  ) {}

  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok', service: 'management-service', uptimeSec: Math.round(process.uptime()) };
  }

  /** Operator view of the outbox relay: leadership, pending backlog, exhausted rows (PDF §13 visibility). */
  @Get('relay')
  async relayState() {
    return { enabled: this.relay.enabled, ...(await this.relay.snapshot()) };
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    const [mongo, nats] = await Promise.all([this.mongo.ping(), Promise.resolve(this.nats.isConnected())]);
    const ok = mongo && nats;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks: { management_db: mongo ? 'up' : 'down', nats: nats ? 'up' : 'down' } });
  }
}
