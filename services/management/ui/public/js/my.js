import { api } from './api.js';
import { $, h, clear, toast, explain, withCid, statusBadge } from './dom.js';

/** Employee landing page: items assigned to me + the projects of my teams. Admins can open it too. */
async function load() {
  const [{ items }, { items: projects }, { items: teams }] = await Promise.all([api('GET', '/api/me/items'), api('GET', '/api/projects?limit=100'), api('GET', '/api/teams?limit=100')]);
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const rows = clear($('#my-items'));
  const today = new Date().toISOString().slice(0, 10);
  for (const it of items) {
    const p = byProject.get(it.projectId);
    rows.append(h('tr', {}, h('td', {}, h('a', { href: `/projects/${encodeURIComponent(it.projectId)}/board`, class: 'font-monospace', text: it.issueKey })), h('td', { text: it.title }), h('td', { text: p ? `${p.projectKey} · ${p.name}` : it.projectId }), h('td', { text: it.columnId }),
      h('td', {}, h('span', { class: `prio-${it.priority}` }, h('i', { class: 'bi bi-flag-fill' }), ` ${it.priority}`)), h('td', { class: it.dueDate && it.dueDate < today ? 'text-danger fw-semibold' : '', text: it.dueDate ?? '—' })));
  }
  if (!items.length) rows.append(h('tr', {}, h('td', { colspan: 6, class: 'text-secondary p-3', text: 'Nothing assigned to you right now.' })));
  const ul = clear($('#my-projects'));
  for (const t of teams) {
    ul.append(h('li', { class: 'list-group-item fw-semibold', text: `${t.code} · ${t.name}` }));
    for (const p of projects.filter((x) => x.teamId === t.id)) ul.append(h('li', { class: 'list-group-item d-flex align-items-center gap-2 ps-4' }, h('a', { href: `/projects/${encodeURIComponent(p.id)}/board`, text: `${p.projectKey} · ${p.name}` }), statusBadge(p.status), h('a', { class: 'btn btn-sm btn-primary ms-auto', href: `/projects/${encodeURIComponent(p.id)}/board` }, h('i', { class: 'bi bi-kanban' }), ' Board')));
  }
  if (!teams.length) ul.append(h('li', { class: 'list-group-item text-secondary', text: 'You are not a member of any team yet. Ask an administrator to add you.' }));
}
load().catch((e) => toast('danger', explain(e), withCid(e)));
