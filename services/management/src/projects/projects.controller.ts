import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../auth/roles.js';
import { Ctx, type RequestContext } from '../common/context.js';
import { ArchiveProjectDto, AssignTeamDto, CreateProjectDto, ListProjectsQuery, UpdateProjectDto } from './dto/projects.dto.js';
import { ProjectsService } from './projects.service.js';
import type { ProjectDoc } from './projects.types.js';

export const projectView = (p: ProjectDoc) => ({
  id: p._id, projectKey: p.projectKey, name: p.name, description: p.description, teamId: p.teamId, ownerId: p.ownerId, status: p.status,
  startDate: p.startDate, targetDate: p.targetDate, boardId: p.boardId, archivedAt: p.archivedAt, version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post() @AdminOnly() async create(@Ctx() ctx: RequestContext, @Body() dto: CreateProjectDto) { return projectView(await this.projects.create(ctx, dto)); }
  @Get() async list(@Ctx() ctx: RequestContext, @Query() q: ListProjectsQuery) {
    const page = await this.projects.list(ctx, { includeArchived: q.includeArchived === 'true', teamId: q.teamId }, q.limit, q.cursor);
    return { items: page.items.map(projectView), nextCursor: page.nextCursor };
  }
  @Get(':projectId') async get(@Ctx() ctx: RequestContext, @Param('projectId') id: string) { return projectView(await this.projects.get(ctx, id)); }
  @Patch(':projectId') @AdminOnly() async update(@Ctx() ctx: RequestContext, @Param('projectId') id: string, @Body() dto: UpdateProjectDto) { return projectView(await this.projects.update(ctx, id, dto)); }
  @Put(':projectId/team') @AdminOnly() async assignTeam(@Ctx() ctx: RequestContext, @Param('projectId') id: string, @Body() dto: AssignTeamDto) { return projectView(await this.projects.assignTeam(ctx, id, dto)); }
  @Post(':projectId/archive') @AdminOnly() @HttpCode(200) async archive(@Ctx() ctx: RequestContext, @Param('projectId') id: string, @Body() dto: ArchiveProjectDto) { return projectView(await this.projects.archive(ctx, id, dto)); }
}
