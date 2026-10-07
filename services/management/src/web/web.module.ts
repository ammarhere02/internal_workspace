import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { WebController } from './web.controller.js';

/** Web/BFF slice: AdminLTE page shells + the dashboard summary endpoint. Views and assets live in ../../ui. */
@Module({ controllers: [WebController, DashboardController], providers: [DashboardService] })
export class WebModule {}
