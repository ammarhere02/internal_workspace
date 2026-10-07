import { Global, Module } from '@nestjs/common';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';

@Global()
@Module({ providers: [IdentityService], controllers: [IdentityController], exports: [IdentityService] })
export class IdentityModule {}
