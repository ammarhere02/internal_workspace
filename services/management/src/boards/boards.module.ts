import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { TeamsModule } from '../teams/teams.module.js';
import { BoardsController } from './boards.controller.js';
import { BoardsRepository } from './boards.repository.js';
import { BoardsService } from './boards.service.js';

@Module({ imports: [TeamsModule, ProjectsModule], controllers: [BoardsController], providers: [BoardsService, BoardsRepository], exports: [BoardsService] })
export class BoardsModule {}
