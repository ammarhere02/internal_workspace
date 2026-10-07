import { Controller, Get, Param, Render } from '@nestjs/common';

/**
 * Page shells only. Each view receives route parameters and a page key; the browser loads data from
 * /api/* (identity, workspace scope and validation stay server-side, exactly as for any API client).
 * Route parameters are rendered with EJS escaping (<%= %>), never as raw HTML.
 * Screens mirror the AdminLTE demo pages: Projects, Project Add, Project Edit, Project Detail, Kanban Board.
 */
@Controller()
export class WebController {
  @Get() @Render('pages/dashboard') dashboard() { return { page: 'dashboard', title: 'Dashboard' }; }
  @Get('my') @Render('pages/my') my() { return { page: 'my', title: 'My Work' }; }
  @Get('teams') @Render('pages/teams') teams() { return { page: 'teams', title: 'Teams' }; }
  @Get('teams/:teamId') @Render('pages/team') team(@Param('teamId') teamId: string) { return { page: 'teams', title: 'Team', teamId }; }
  @Get('board') @Render('pages/board-pick') boardPick() { return { page: 'board', title: 'Kanban Board' }; }
  @Get('projects') @Render('pages/projects') projects() { return { page: 'projects', title: 'Projects' }; }
  @Get('projects/new') @Render('pages/project-add') projectAdd() { return { page: 'project-add', title: 'Project Add' }; }
  @Get('projects/:projectId') @Render('pages/project-detail') projectDetail(@Param('projectId') projectId: string) { return { page: 'projects', title: 'Project Detail', projectId }; }
  @Get('projects/:projectId/edit') @Render('pages/project-edit') projectEdit(@Param('projectId') projectId: string) { return { page: 'projects', title: 'Project Edit', projectId }; }
  @Get('projects/:projectId/board') @Render('pages/board') board(@Param('projectId') projectId: string) { return { page: 'board', title: 'Kanban Board', projectId }; }
  @Get('projects/:projectId/activity') @Render('pages/activity') activity(@Param('projectId') projectId: string) { return { page: 'projects', title: 'Activity', projectId }; }
  @Get('projects/:projectId/insights') @Render('pages/insights') insights(@Param('projectId') projectId: string) { return { page: 'projects', title: 'Insights', projectId }; }
}
