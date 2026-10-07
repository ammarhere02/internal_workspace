import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../common/context.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import type { BoardDoc } from '../projects/projects.types.js';
import type { ProjectDoc } from '../projects/projects.types.js';
import type { WorkItemDoc } from '../boards/boards.types.js';
import type { TeamDoc } from '../teams/teams.types.js';

/**
 * Authoritative dashboard counts (PDF §12 Dashboard row), read from management_db only.
 * "Open" = not archived and not in the board's last column (boards are configurable, so the last
 * column plays the role of Done). "Overdue" = open with dueDate before today (UTC date).
 * Projection freshness is NOT computed here: the browser asks /api/projects/{id}/insights per project,
 * so the dashboard shows the Python service's own freshness metadata rather than a NestJS guess.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly mongo: MongoService) {}

  async summary(ctx: RequestContext) {
    const ws = ctx.workspaceId;
    const [teams, projects, boards] = await Promise.all([
      this.mongo.collection<TeamDoc>('teams').countDocuments({ workspaceId: ws, archivedAt: null }),
      this.mongo.collection<ProjectDoc>('projects').find({ workspaceId: ws, archivedAt: null }).sort({ _id: -1 }).toArray(),
      this.mongo.collection<BoardDoc>('boards').find({ workspaceId: ws }, { projection: { projectId: 1, columns: 1 } }).toArray(),
    ]);
    const doneColumns = boards.map((b) => ({ projectId: b.projectId, columnId: [...b.columns].sort((a, c) => a.order - c.order).at(-1)?.columnId ?? '' }));
    const open: Record<string, unknown> = { workspaceId: ws, archivedAt: null };
    if (doneColumns.length) open.$nor = doneColumns.map((d) => ({ projectId: d.projectId, columnId: d.columnId })); // $nor rejects an empty array
    const items = this.mongo.collection<WorkItemDoc>('work_items');
    const today = new Date().toISOString().slice(0, 10);
    const [openItems, overdueItems, latestByProject] = await Promise.all([
      items.countDocuments(open),
      items.countDocuments({ ...open, dueDate: { $ne: null, $lt: today } }),
      items.aggregate<{ _id: string; latest: Date }>([{ $match: { workspaceId: ws } }, { $group: { _id: '$projectId', latest: { $max: '$updatedAt' } } }]).toArray(),
    ]);
    const latestItem = new Map(latestByProject.map((r) => [r._id, r.latest]));
    return {
      teams,
      activeProjects: projects.filter((p) => p.status === 'ACTIVE').length,
      projects: projects.length,
      openItems,
      overdueItems,
      asOf: new Date().toISOString(),
      source: 'authoritative',
      // the browser queries freshness for these (newest first, bounded so the dashboard stays cheap);
      // latestChangeAt = newest authoritative change of project or any of its items, what the projection should have folded
      recentProjects: projects.slice(0, 6).map((p) => {
        const i = latestItem.get(p._id);
        return { id: p._id, projectKey: p.projectKey, name: p.name, status: p.status, latestChangeAt: i && i > p.updatedAt ? i : p.updatedAt };
      }),
    };
  }
}
