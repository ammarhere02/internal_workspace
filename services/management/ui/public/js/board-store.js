import { api, userMap } from './api.js';

/**
 * Shared state for the board page. The authoritative board (GET /api/projects/{id}/board) is the only
 * source of card positions; optimistic edits mutate it locally and are replaced by the server reply or
 * rolled back. `reload()` re-fetches everything and notifies every renderer.
 */
export const store = {
  projectId: null,
  project: null,
  board: null,
  members: [],   // [{userId,name,role}] of the owning team: the only valid assignees (PDF §12)
  users: new Map(),
  listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); },
  notify() { for (const fn of this.listeners) fn(); },
  async reload() {
    const pid = encodeURIComponent(this.projectId);
    const [project, board, users] = await Promise.all([api('GET', `/api/projects/${pid}`), api('GET', `/api/projects/${pid}/board`), userMap()]);
    const { items } = await api('GET', `/api/teams/${encodeURIComponent(project.teamId)}/members`);
    Object.assign(this, { project, board, users, members: items });
    this.notify();
  },
  column(id) { return this.board.columns.find((c) => c.columnId === id); },
  findItem(id) {
    for (const c of this.board.columns) { const i = c.items.find((x) => x.id === id); if (i) return { column: c, item: i }; }
    return null;
  },
  /** Replace a card with the server's view of it (after any successful command). */
  replaceItem(view) {
    const found = this.findItem(view.id);
    if (found) Object.assign(found.item, view, { pending: false });
    if (found && found.column.columnId !== view.columnId) {
      found.column.items = found.column.items.filter((i) => i.id !== view.id);
      this.column(view.columnId)?.items.push(found.item);
    }
    this.recount();
    this.notify();
  },
  recount(sort = true) {
    for (const c of this.board.columns) {
      if (sort) c.items.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.issueKey < b.issueKey ? -1 : 1));
      c.count = c.items.length;
      c.wipExceeded = c.wipLimit !== null && c.items.length > c.wipLimit;
    }
  },
  userName(id) { return id ? (this.users.get(id)?.name ?? id) : 'Unassigned'; },
  snapshot() { return JSON.stringify(this.board); },
  restore(snap) { this.board = JSON.parse(snap); this.notify(); },
};
