import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Env } from '../config/env.js';
import { NatsService } from './nats.service.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import { OutboxService } from './outbox.service.js';

export const INSIGHTS_CLIENT = 'INSIGHTS_CLIENT';

/**
 * Messaging module (PDF §9): NATS connection, stream bootstrap, publisher.
 * INSIGHTS_CLIENT is the official NestJS NATS transport client used by the BFF
 * for Core NATS request/reply (tm.query.v1.*). Durable events do NOT go through it,
 * because the Nest transport has no JetStream support; NatsService handles those.
 */
@Global()
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: INSIGHTS_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => ({
          transport: Transport.NATS,
          options: { servers: [config.get('NATS_URL')], name: 'management-bff' },
        }),
      },
    ]),
  ],
  providers: [NatsService, OutboxService, OutboxRelayService],
  exports: [NatsService, OutboxService, OutboxRelayService, ClientsModule],
})
export class MessagingModule {}
