import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from './common/errors/http-exception.filter.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { IdentityMiddleware, PageAuthMiddleware } from './identity/identity.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { MongoModule } from './infra/mongo/mongo.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { BoardsModule } from './boards/boards.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { WebModule } from './web/web.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env'] }),
    LoggingModule,
    MongoModule,
    MessagingModule,
    IdentityModule,
    TeamsModule,
    ProjectsModule,
    BoardsModule,
    InsightsModule,
    WebModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(IdentityMiddleware).forRoutes('api');
    consumer.apply(PageAuthMiddleware).exclude('api/{*path}', 'auth/{*path}', 'login', 'register', 'health/{*path}', 'assets/{*path}', 'vendor/{*path}').forRoutes('{*path}');
  }
}
