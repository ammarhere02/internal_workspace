import { api } from './api.js';
import { $, h, clear, submit, toast, explain, withCid, avatar } from './dom.js';

/**
 * Project Add in one screen: choose or create the owning team, tick the employees from the workspace, pick the
 * leader, create. Behind it: POST /api/teams (new team) -> POST /api/teams/:id/members (each new person) ->
 * POST /api/projects. The calls are separate commands (each atomic with its own outbox event); if one fails the
 * earlier ones stay, which is reported to the user. The server still enforces owner-in-team and admin-only rules.
 */
const NEW = '__new__';
let users = [], me = null, existing = new Map(); // existing: userId -> role of members already in the selected team

const checked = () => [...document.querySelectorAll('#people input[type=checkbox]:checked')].map((c) => c.value);

/** reset=true on a team change: the new team starts empty (you stay ticked for a brand-new team), so the previous team's people never leak into it. */
function renderPeople(reset = false) {
  const keep = reset ? new Set($('#p-team').value === NEW && me ? [me] : []) : new Set(checked());
  const box = clear($('#people'));
  for (const u of users) {
    const locked = existing.has(u.id);
    const on = locked || keep.has(u.id);
    const cb = h('input', { class: 'form-check-input', type: 'checkbox', id: `pp-${u.id}`, value: u.id, checked: on, disabled: locked });
    cb.addEventListener('change', renderLeader);
    box.append(h('label', { class: 'people-row', for: `pp-${u.id}` }, cb, avatar(u.name, 'avatar-sm'), h('span', { class: 'flex-grow-1' }, h('span', { class: 'fw-semibold', text: u.name }), h('small', { class: 'text-secondary d-block', text: u.email })),
      locked ? h('span', { class: 'badge text-bg-light', text: existing.get(u.id) }) : null, u.id === me ? h('span', { class: 'badge text-bg-primary ms-1', text: 'you' }) : null));
  }
  renderLeader();
}
function renderLeader() {
  const sel = $('#p-owner'), prev = sel.value;
  const ids = checked();
  sel.replaceChildren(...ids.map((id) => h('option', { value: id, text: users.find((u) => u.id === id)?.name ?? id })));
  if (!ids.length) sel.append(h('option', { value: '', text: 'Tick at least one team member', disabled: true, selected: true }));
  else sel.value = ids.includes(prev) ? prev : ids.includes(me) ? me : ids[0];
}

async function onTeamChange() {
  const teamId = $('#p-team').value;
  $('#new-team').hidden = teamId !== NEW;
  existing = new Map();
  if (teamId && teamId !== NEW) {
    const { items } = await api('GET', `/api/teams/${encodeURIComponent(teamId)}/members`);
    existing = new Map(items.map((m) => [m.userId, m.role]));
  }
  renderPeople(true);
  if (teamId === NEW) $('#nt-name').focus();
}

async function load() {
  const [{ items: teams }, { items: us }, meRes] = await Promise.all([api('GET', '/api/teams?limit=100'), api('GET', '/api/users'), api('GET', '/api/me')]);
  users = us; me = meRes.actorId;
  const sel = clear($('#p-team'));
  for (const t of teams) sel.append(h('option', { value: t.id, text: `${t.code} · ${t.name}` }));
  sel.append(h('option', { value: NEW, text: '+ Create a new team…' }));
  sel.value = teams[0]?.id ?? NEW;
  await onTeamChange();
}

$('#p-team').addEventListener('change', () => onTeamChange().catch((e) => toast('danger', explain(e), withCid(e))));
$('#nt-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

$('#create-project').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const creating = $('#p-team').value === NEW;
  $('#nt-name').required = creating; $('#nt-code').required = creating;
  if (!form.reportValidity()) return;
  const ids = checked(), leader = $('#p-owner').value;
  if (!ids.length || !leader) return toast('warning', 'Tick at least one team member and choose the project leader.');
  const progress = [];
  const p = await submit(form, async (fd) => {
    let teamId = fd.get('teamId');
    if (creating) {
      const t = await api('POST', '/api/teams', { name: $('#nt-name').value.trim(), code: $('#nt-code').value.trim().toUpperCase() });
      teamId = t.id; progress.push(`team ${t.code} created`);
    }
    for (const userId of ids.filter((id) => !existing.has(id))) {
      await api('POST', `/api/teams/${encodeURIComponent(teamId)}/members`, { userId, role: userId === leader ? 'LEAD' : 'MEMBER' });
      progress.push(`${users.find((u) => u.id === userId)?.name} added`);
    }
    const body = { projectKey: String(fd.get('projectKey')).toUpperCase(), name: fd.get('name'), teamId, ownerId: leader, status: fd.get('status'), description: fd.get('description') || '' };
    if (fd.get('startDate')) body.startDate = fd.get('startDate');
    if (fd.get('targetDate')) body.targetDate = fd.get('targetDate');
    return api('POST', '/api/projects', body);
  }, { success: 'Project and default board created' }).catch((e) => {
    if (progress.length) toast('warning', `Already done before the error: ${progress.join(', ')}.`, 'These steps are saved; fix the problem and submit again (existing members are skipped).');
    return null;
  });
  if (p) location.href = `/projects/${encodeURIComponent(p.id)}/board`;
});

load().catch((e) => toast('danger', explain(e), withCid(e)));
