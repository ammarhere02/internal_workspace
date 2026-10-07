import { api, userName, userMap, humanize } from './api.js';
import { $, h, clear, toast, explain, withCid, fmtDate, avatar, statusBadge } from './dom.js';
import { runProjectionPage } from './projection-page.js';

/** Project Detail (AdminLTE demo layout): authoritative facts on the right, projection activity on the left. */
const projectId = $('#detail-page').dataset.projectId;
const pid = encodeURIComponent(projectId);
$('#activity-all').href = `/projects/${pid}/activity`; $('#d-board-btn').href = `/projects/${pid}/board`; $('#d-edit-btn').href = `/projects/${pid}/edit`;

async function post(ev) {
  const who = await userName(ev.actorId);
  return h('div', { class: 'post' },
    h('div', { class: 'user-block' }, avatar(who), h('div', {}, h('span', { class: 'username', text: who }), h('span', { class: 'description', text: `${ev.eventType} · ${new Date(ev.occurredAt).toLocaleString()}` }))),
    h('p', { class: 'mb-1', text: await humanize(ev.summary) }),
    ev.item ? h('a', { href: `/projects/${pid}/board`, class: 'link-dark small' }, h('i', { class: 'bi bi-link-45deg' }), ` ${ev.item.issueKey} · ${ev.item.title}`) : null);
}

runProjectionPage({
  projectId, active: 'detail',
  query: () => api('GET', `/api/projects/${pid}/activity?limit=5`),
  render: async ({ reply, board, project }) => {
    const posts = clear($('#activity-posts'));
    for (const ev of reply?.items ?? []) posts.append(await post(ev));
    if (!posts.children.length) posts.append(h('p', { class: 'text-secondary', text: 'No activity in the projection yet.' }));
  },
}).then(async ({ project, board }) => {
  const users = await userMap();
  $('#page-title').textContent = `Project Detail · ${project.projectKey}`;
  $('#detail-title').textContent = `${project.projectKey} · ${project.name}`;
  $('#d-name').textContent = project.name; $('#d-desc').textContent = project.description || 'No description.'; $('#d-key').textContent = project.projectKey;
  $('#d-owner').textContent = users.get(project.ownerId)?.name ?? project.ownerId;
  $('#d-status').replaceChildren(statusBadge(project.archivedAt ? 'ARCHIVED' : project.status));
  $('#d-dates').textContent = `${fmtDate(project.startDate)} → ${fmtDate(project.targetDate)}`;
  $('#d-version').textContent = `project ${project.version} · board ${board.version}`;
  const total = board.columns.reduce((s, c) => s + c.count, 0), done = board.columns.at(-1)?.count ?? 0;
  $('#ib-open').textContent = total - done; $('#ib-done').textContent = `${done} / ${total}`;
  $('#ib-days').textContent = project.targetDate ? Math.ceil((Date.parse(project.targetDate) - Date.now()) / 86_400_000) : '—';
  const links = clear($('#d-links'));
  for (const [sfx, label, icon, auth] of [['/board', 'Kanban board', 'bi-kanban', true], ['/activity', 'Activity feed', 'bi-clock-history', false], ['/insights', 'Workload insights', 'bi-bar-chart-fill', false]])
    links.append(h('a', { class: 'list-group-item list-group-item-action d-flex align-items-center gap-2', href: `/projects/${pid}${sfx}` }, h('i', { class: `bi ${icon} text-primary` }), label,
      h('span', { class: `src-tag ${auth ? 'src-auth' : 'src-proj'} ms-auto`, text: auth ? 'authoritative' : 'projection' }), h('i', { class: 'bi bi-chevron-right text-secondary small' })));
  const [team, { items: members }] = await Promise.all([api('GET', `/api/teams/${encodeURIComponent(project.teamId)}`), api('GET', `/api/teams/${encodeURIComponent(project.teamId)}/members`)]);
  $('#d-team').replaceChildren(h('a', { href: `/teams/${encodeURIComponent(team.id)}`, text: `${team.code} · ${team.name}` }));
  const ul = clear($('#d-members'));
  for (const m of members) ul.append(h('li', { class: 'd-flex align-items-center gap-2' }, avatar(m.name, 'avatar-sm'), h('span', { text: m.name }), h('span', { class: 'role-pill ms-auto', text: m.role })));
}).catch((e) => toast('danger', explain(e), withCid(e)));
