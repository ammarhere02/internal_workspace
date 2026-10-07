import { live } from './live.js';
import { api, userMap } from './api.js';
import { $, h, clear, toast, explain, withCid, avatar, statusBadge } from './dom.js';

/** Projects list in the AdminLTE "Projects" page style: avatars = owning-team members, progress = done ÷ active cards. */
const teams = new Map(), members = new Map();
let admin = null; // null until /api/me answers; the shell hides [data-admin-only] for employees, this keeps late-rendered rows consistent
let cursor = null, n = 0;

async function teamMembers(teamId) {
  if (!members.has(teamId)) members.set(teamId, api('GET', `/api/teams/${encodeURIComponent(teamId)}/members`).then((r) => r.items).catch(() => []));
  return members.get(teamId);
}
async function progress(projectId) {
  try {
    const b = await api('GET', `/api/projects/${encodeURIComponent(projectId)}/board`);
    const total = b.columns.reduce((s, c) => s + c.count, 0);
    const done = b.columns.at(-1)?.count ?? 0;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  } catch { return null; }
}

function row(p, users) {
  const pid = encodeURIComponent(p.id);
  const tr = h('tr', { class: p.archivedAt ? 'text-secondary' : '' },
    h('td', { text: `#${++n}` }),
    h('td', {}, h('a', { href: `/projects/${pid}`, text: `${p.projectKey} · ${p.name}` }), h('br'), h('small', { text: `Created ${new Date(p.createdAt).toLocaleDateString()} · owner ${users.get(p.ownerId)?.name ?? p.ownerId}` })),
    h('td', {}, h('ul', { class: 'list-inline' }, h('li', { class: 'list-inline-item text-secondary small', text: '…' }))),
    h('td', { class: 'project_progress' }, h('div', { class: 'progress progress-sm' }, h('div', { class: 'progress-bar bg-green', role: 'progressbar', 'aria-valuenow': 0, 'aria-valuemin': 0, 'aria-valuemax': 100, style: 'width: 0%' })), h('small', { text: 'loading…' })),
    h('td', { class: 'project-state text-center' }, statusBadge(p.archivedAt ? 'ARCHIVED' : p.status)),
    h('td', { class: 'project-actions text-end text-nowrap' },
      h('a', { class: 'btn btn-primary btn-sm', href: `/projects/${pid}` }, h('i', { class: 'bi bi-folder-fill' }), ' View'),
      h('a', { class: 'btn btn-info btn-sm', href: `/projects/${pid}/board`, title: 'Kanban board' }, h('i', { class: 'bi bi-kanban' }), ' Board'),
      h('a', { class: 'btn btn-info btn-sm', href: `/projects/${pid}/edit`, 'data-admin-only': true, hidden: admin === false }, h('i', { class: 'bi bi-pencil-fill' }), ' Edit'),
      p.archivedAt ? null : h('button', { type: 'button', class: 'btn btn-danger btn-sm', 'data-admin-only': true, hidden: admin === false, onclick: () => archive(p) }, h('i', { class: 'bi bi-trash-fill' }), ' Archive')));
  teamMembers(p.teamId).then((ms) => {
    const ul = clear(tr.children[2].firstChild);
    for (const m of ms.slice(0, 6)) ul.append(h('li', { class: 'list-inline-item' }, avatar(m.name, 'table-avatar')));
    if (ms.length > 6) ul.append(h('li', { class: 'list-inline-item small text-secondary', text: `+${ms.length - 6}` }));
    if (!ms.length) ul.append(h('li', { class: 'list-inline-item small text-secondary', text: teams.get(p.teamId) ? `${teams.get(p.teamId).code}: no members` : 'no team' }));
    ul.title = `Team ${teams.get(p.teamId)?.code ?? p.teamId}: ${ms.map((m) => m.name).join(', ')}`;
  });
  progress(p.id).then((pr) => {
    const td = tr.children[3];
    const bar = td.querySelector('.progress-bar');
    if (!pr) { td.lastChild.textContent = 'board unavailable'; return; }
    bar.style.width = `${pr.pct}%`; bar.setAttribute('aria-valuenow', pr.pct);
    td.lastChild.textContent = `${pr.pct}% Complete (${pr.done}/${pr.total} cards done)`;
  });
  return tr;
}

async function archive(p) {
  if (!confirm(`Archive project ${p.projectKey}? The board becomes read-only; nothing is deleted.`)) return;
  try { await api('POST', `/api/projects/${encodeURIComponent(p.id)}/archive`, { expectedVersion: p.version }); toast('success', `${p.projectKey} archived`); load(); }
  catch (e) { toast('danger', explain(e), withCid(e)); }
}

let busy = false; // a second "Load more" click while a page is in flight would append the same page twice
async function load(reset = true) {
  if (busy) return;
  busy = true;
  try { await loadPage(reset); } finally { busy = false; }
}
async function loadPage(reset) {
  const rows = $('#project-rows');
  if (reset) { cursor = null; n = 0; }
  const q = new URLSearchParams({ limit: 25, includeArchived: $('#include-archived').checked });
  if (cursor) q.set('cursor', cursor);
  try {
    if (!teams.size) for (const t of (await api('GET', '/api/teams?includeArchived=true&limit=100')).items) teams.set(t.id, t);
    const [page, users, me] = await Promise.all([api('GET', `/api/projects?${q}`), userMap(), api('GET', '/api/me')]);
    if (reset) clear(rows); // cleared only once the data is here, so a refresh never flashes an empty table
    admin = me.role === 'ADMIN';
    for (const p of page.items) rows.append(row(p, users));
    if (!rows.children.length) rows.append(h('tr', {}, h('td', { colspan: 6, class: 'text-secondary p-3' }, 'No projects yet. ', h('a', { href: '/projects/new' }, 'Add the first project'), '.')));
    cursor = page.nextCursor;
    $('#more-projects').hidden = !cursor;
  } catch (e) { toast('danger', explain(e), withCid(e)); }
}
$('#include-archived').addEventListener('change', () => load());
$('#more-projects').addEventListener('click', () => load(false));
load();
live(() => { if (!cursor) return load(); }, { everyMs: 15_000 }); // only while the list fits one page: never drop rows the user loaded with "Load more"
