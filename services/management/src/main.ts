import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';
import { configureWeb } from './web/web.setup.js';
import { configureAuth } from './auth/auth.setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app); // validation pipe (400 on unknown/invalid fields) + shutdown hooks (SIGTERM drains NATS, closes Mongo)
  configureWeb(app); // EJS views, AdminLTE/Bootstrap assets, CSP headers
  configureAuth(app); // sessions + Passport Google (only when AUTH_MODE=google)
  const port = app.get(ConfigService<Env, true>).get('PORT');
  await app.listen(port);
}
await bootstrap();
