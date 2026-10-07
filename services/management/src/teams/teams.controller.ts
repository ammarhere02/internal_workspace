import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../auth/roles.js';
import { Ctx, type RequestContext } from '../common/context.js';
import { AddMemberDto, ArchiveDto, ChangeRoleDto, CreateTeamDto, ListTeamsQuery, UpdateTeamDto } from './dto/teams.dto.js';
import { TeamsService } from './teams.service.js';
import type { TeamDoc } from './teams.types.js';

const view = (t: TeamDoc) => ({ id: t._id, name: t.name, code: t.code, description: t.description, archivedAt: t.archivedAt, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt });

@Controller('api/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post() @AdminOnly() async create(@Ctx() ctx: RequestContext, @Body() dto: CreateTeamDto) { return view(await this.teams.create(ctx, dto)); }

  @Get() async list(@Ctx() ctx: RequestContext, @Query() q: ListTeamsQuery) {
    const page = await this.teams.list(ctx, q.includeArchived === 'true', q.limit, q.cursor);
    return { items: page.items.map(view), nextCursor: page.nextCursor };
  }

  @Get(':teamId') async get(@Ctx() ctx: RequestContext, @Param('teamId') id: string) { return view(await this.teams.get(ctx, id)); }
  @Patch(':teamId') @AdminOnly() async update(@Ctx() ctx: RequestContext, @Param('teamId') id: string, @Body() dto: UpdateTeamDto) { return view(await this.teams.update(ctx, id, dto)); }
  @Post(':teamId/archive') @AdminOnly() @HttpCode(200) async archive(@Ctx() ctx: RequestContext, @Param('teamId') id: string, @Body() dto: ArchiveDto) { return view(await this.teams.archive(ctx, id, dto.expectedVersion)); }

  @Get(':teamId/members') async members(@Ctx() ctx: RequestContext, @Param('teamId') id: string) { return { items: await this.teams.members(ctx, id) }; }
  @Post(':teamId/members') @AdminOnly() async addMember(@Ctx() ctx: RequestContext, @Param('teamId') id: string, @Body() dto: AddMemberDto) {
    const m = await this.teams.addMember(ctx, id, dto);
    return { teamId: m.teamId, userId: m.userId, role: m.role, joinedAt: m.joinedAt };
  }
  @Patch(':teamId/members/:userId') @AdminOnly() async changeRole(@Ctx() ctx: RequestContext, @Param('teamId') id: string, @Param('userId') userId: string, @Body() dto: ChangeRoleDto) {
    const m = await this.teams.changeRole(ctx, id, userId, dto);
    return { teamId: m.teamId, userId: m.userId, role: m.role, joinedAt: m.joinedAt };
  }
  @Delete(':teamId/members/:userId') @AdminOnly() @HttpCode(204) async removeMember(@Ctx() ctx: RequestContext, @Param('teamId') id: string, @Param('userId') userId: string) {
    await this.teams.removeMember(ctx, id, userId);
  }
}
