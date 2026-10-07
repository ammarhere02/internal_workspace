import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

@Module({ imports: [ProjectsModule], controllers: [InsightsController], providers: [InsightsService] })
export class InsightsModule {}
