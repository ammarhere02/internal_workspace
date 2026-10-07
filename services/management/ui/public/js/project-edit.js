import { api } from './api.js';
import { $, h, clear, toast, alertBox, explain, withCid } from './dom.js';
import { projectNav } from './shell.js';

/** Project Edit (AdminLTE demo layout): name/status/leader/dates via PATCH, team via PUT /team, both with expectedVersion. */
const projectId = $('#project-form').dataset.projectId;
const pid = encodeURIComponent(projectId);
let project, members = [];

async function load() {
  project = await api('GET', `/api/projects/${pid}`);
  // load everything before filling the form, so a quick Save can never submit half-loaded pickers
  const [{ items: teams }, { items: ms }] = await Promise.all([api('GET', '/api/teams?limit=100'), api('GET', `/api/teams/${encodeURIComponent(project.teamId)}/members`)]);
  projectNav(project, 'edit');
  $('#page-title').textContent = `Project Edit · ${project.projectKey}`;
  $('#pe-key').value = project.projectKey; $('#pe-name').value = project.name; $('#pe-desc').value = project.description; $('#pe-status').value = project.status;
  $('#pe-start').value = project.startDate ?? ''; $('#pe-target').value = project.targetDate ?? '';
  $('#pe-version').textContent = project.version;
  $('#pe-cancel').href = `/projects/${pid}`; $('#pe-board-link').href = `/projects/${pid}/board`;
  members = ms;
  $('#pe-team').replaceChildren(...teams.map((t) => h('option', { value: t.id, text: `${t.code} · ${t.name}`, selected: t.id === project.teamId })));
  $('#pe-owner').replaceChildren(...members.map((m) => h('option', { value: m.userId, text: `${m.name} (${m.role})`, selected: m.userId === project.ownerId })));
  const rows = clear($('#pe-members'));
  for (const m of members) rows.append(h('tr', {}, h('td', { class: 'ps-3', text: m.name }), h('td', {}, h('span', { class: 'badge text-bg-light', text: m.role }))));
  if (!members.length) rows.append(h('tr', {}, h('td', { colspan: 2, class: 'ps-3 text-secondary', text: 'No members' })));
  if (project.archivedAt) { alertBox('secondary', 'Archived project.', ' Fields are read-only.', { id: 'archived' }); for (const el of $('#project-form').querySelectorAll('input,select,textarea,button')) el.disabled = true; }
}

$('#project-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  try {
    let version = project.version;
    if (fd.get('teamId') && fd.get('teamId') !== project.teamId) { const v = await api('PUT', `/api/projects/${pid}/team`, { expectedVersion: version, teamId: fd.get('teamId') }); version = v.version; }
    const patch = { expectedVersion: version };
    for (const k of ['name', 'status', 'description', 'ownerId']) if (fd.get(k) !== project[k]) patch[k] = fd.get(k);
    for (const k of ['startDate', 'targetDate']) { const v = fd.get(k) || null; if (v !== project[k]) patch[k] = v; }
    if (Object.keys(patch).length > 1) await api('PATCH', `/api/projects/${pid}`, patch);
    toast('success', 'Project saved');
    location.href = `/projects/${pid}`;
  } catch (e) {
    if (e.code === 'version_conflict') { alertBox('warning', 'Project changed elsewhere.', ` ${explain(e)} ${withCid(e)}`, { id: 'conflict' }); await load(); }
    else toast('danger', explain(e), withCid(e));
  }
});
$('#pe-archive').addEventListener('click', async () => {
  if (!confirm(`Archive project ${project.projectKey}? The board becomes read-only.`)) return;
  try { await api('POST', `/api/projects/${pid}/archive`, { expectedVersion: project.version }); toast('success', 'Project archived'); location.href = `/projects/${pid}`; }
  catch (e) { toast('danger', explain(e), withCid(e)); }
});
load().catch((e) => toast('danger', explain(e), withCid(e)));
