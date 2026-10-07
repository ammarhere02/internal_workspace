import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

@Module({ imports: [TeamsModule], controllers: [ProjectsController], providers: [ProjectsService, ProjectsRepository], exports: [ProjectsService, ProjectsRepository] })
export class ProjectsModule {}
