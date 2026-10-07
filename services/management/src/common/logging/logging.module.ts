import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ulid } from 'ulid';
import { Env } from '../../config/env.js';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Structured JSON logs (pino). Every HTTP log line carries the correlation id,
 * which the same request later writes into outbox rows and NATS headers.
 * Secrets are redacted by path so a stray log of config can't leak the Atlas URI.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          base: { service: 'management-service' },
          genReqId: (req, res) => {
            const incoming = req.headers[CORRELATION_HEADER];
            const id = (Array.isArray(incoming) ? incoming[0] : incoming) || `req_${ulid()}`;
            res.setHeader(CORRELATION_HEADER, id);
            return id;
          },
          customProps: (req) => ({ correlationId: req.id }),
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', '*.MONGODB_URI', '*.password', '*.uri'],
            censor: '[redacted]',
          },
          autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
          transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
