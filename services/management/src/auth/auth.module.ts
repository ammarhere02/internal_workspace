import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { LocalAuthController } from './local-auth.controller.js';
import { RolesGuard } from './roles.js';

/** Google OAuth login (Passport) + role guard. Session/passport wiring is in auth.setup.ts (main.ts and tests). */
@Module({ controllers: [AuthController, LocalAuthController], providers: [{ provide: APP_GUARD, useClass: RolesGuard }] })
export class AuthModule {}
