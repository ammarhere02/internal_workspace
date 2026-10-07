import { Controller, Get, Param, Query } from '@nestjs/common';
import { Ctx, type RequestContext } from '../common/context.js';
import { PageQuery } from '../common/pagination.js';
import { InsightsService } from './insights.service.js';

/** Read-only projection routes of the minimum API table; both cross the service boundary over NATS. */
@Controller('api/projects/:projectId')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('insights')
  insightsFor(@Ctx() ctx: RequestContext, @Param('projectId') projectId: string) {
    return this.insights.insights(ctx, projectId);
  }

  @Get('activity')
  activityFor(@Ctx() ctx: RequestContext, @Param('projectId') projectId: string, @Query() q: PageQuery) {
    return this.insights.activity(ctx, projectId, q.limit, q.cursor);
  }
}
