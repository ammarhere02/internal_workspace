import { Controller, Get } from '@nestjs/common';
import { AdminOnly } from '../auth/roles.js';
import { Ctx, type RequestContext } from '../common/context.js';
import { DashboardService } from './dashboard.service.js';

@Controller('api')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get('dashboard') @AdminOnly() summary(@Ctx() ctx: RequestContext) { return this.dashboard.summary(ctx); }
}
