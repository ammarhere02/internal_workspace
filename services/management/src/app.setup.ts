import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared between main.ts and the request tests so tests exercise the real pipeline. */
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  return app;
}
