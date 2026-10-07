import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminOnly } from '../auth/roles.js';
import { Ctx, type RequestContext } from '../common/context.js';
import { BoardsService, itemView } from './boards.service.js';
import { ArchiveItemDto, AssignItemDto, CreateItemDto, ListItemsQuery, MoveItemDto, UpdateColumnsDto, UpdateItemDto } from './dto/boards.dto.js';

@Controller('api')
export class BoardsController {
  constructor(private readonly boards: BoardsService) {}

  @Get('projects/:projectId/board') board(@Ctx() ctx: RequestContext, @Param('projectId') projectId: string) { return this.boards.board(ctx, projectId); }
  @Put('projects/:projectId/board/columns') @AdminOnly() async columns(@Ctx() ctx: RequestContext, @Param('projectId') projectId: string, @Body() dto: UpdateColumnsDto) {
    const b = await this.boards.updateColumns(ctx, projectId, dto);
    return { boardId: b._id, version: b.version, columns: b.columns };
  }

  @Post('projects/:projectId/items') async create(@Ctx() ctx: RequestContext, @Param('projectId') projectId: string, @Body() dto: CreateItemDto) { return itemView(await this.boards.createItem(ctx, projectId, dto)); }
  @Get('projects/:projectId/items') async list(@Ctx() ctx: RequestContext, @Param('projectId') projectId: string, @Query() q: ListItemsQuery) {
    const page = await this.boards.listItems(ctx, projectId, q);
    return { items: page.items.map(itemView), nextCursor: page.nextCursor };
  }

  @Get('items/:itemId') async get(@Ctx() ctx: RequestContext, @Param('itemId') id: string) { return itemView(await this.boards.getItem(ctx, id)); }
  @Patch('items/:itemId') async update(@Ctx() ctx: RequestContext, @Param('itemId') id: string, @Body() dto: UpdateItemDto) { return itemView(await this.boards.updateItem(ctx, id, dto)); }
  @Post('items/:itemId/assign') @HttpCode(200) async assign(@Ctx() ctx: RequestContext, @Param('itemId') id: string, @Body() dto: AssignItemDto) { return itemView(await this.boards.assignItem(ctx, id, dto)); }
  @Post('items/:itemId/move') @HttpCode(200) async move(@Ctx() ctx: RequestContext, @Param('itemId') id: string, @Body() dto: MoveItemDto) { return itemView(await this.boards.moveItem(ctx, id, dto)); }
  @Post('items/:itemId/archive') @HttpCode(200) async archive(@Ctx() ctx: RequestContext, @Param('itemId') id: string, @Body() dto: ArchiveItemDto) { return itemView(await this.boards.archiveItem(ctx, id, dto)); }
}
