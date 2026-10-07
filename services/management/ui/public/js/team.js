import { live } from './live.js';
import { api, userMap } from './api.js';
import { $, h, clear, submit, toast, explain, withCid, fmtDateTime } from './dom.js';

const teamId = $('#team-page').dataset.teamId;
const path = `/api/teams/${encodeURIComponent(teamId)}`;
let team;

async function loadTeam() {
  const prev = team;
  team = await api('GET', path);
  document.title = `${team.code} · Team Management`;
  $('#page-title').textContent = `${team.code} · ${team.name}`;
  $('#team-code').textContent = team.code;
  $('#team-version').textContent = team.version;
  $('#team-status').replaceChildren(team.archivedAt ? h('span', { class: 'badge text-bg-secondary', text: `archived ${fmtDateTime(team.archivedAt)}` }) : h('span', { class: 'badge text-bg-success', text: 'active' }));
  if (!prev || $('#team-name').value === prev.name) $('#team-name').value = team.name; // a refresh never overwrites what the user is typing
  if (!prev || $('#team-desc').value === prev.description) $('#team-desc').value = team.description;
  const archived = Boolean(team.archivedAt);
  for (const el of $('#edit-team').querySelectorAll('input,textarea,button')) el.disabled = archived;
  for (const el of $('#add-member').querySelectorAll('select,button')) el.disabled = archived;
}

async function loadMembers() {
  const [{ items }, users] = await Promise.all([api('GET', `${path}/members`), userMap()]);
  const rows = clear($('#member-rows'));
  for (const m of items) {
    const roleSel = h('select', { class: 'form-select form-select-sm w-auto', 'aria-label': `Role of ${m.name}` },
      ...['OWNER', 'LEAD', 'MEMBER'].map((r) => h('option', { value: r, selected: r === m.role, text: r })));
    roleSel.addEventListener('change', async () => {
      roleSel.disabled = true;
      try { await api('PATCH', `${path}/members/${encodeURIComponent(m.userId)}`, { role: roleSel.value }); toast('success', `${m.name} is now ${roleSel.value}`); }
      catch (e) { toast('danger', explain(e), withCid(e)); roleSel.value = m.role; }
      finally { roleSel.disabled = false; }
    });
    const remove = h('button', { class: 'btn btn-sm btn-outline-danger', type: 'button', 'aria-label': `Remove ${m.name}` }, h('i', { class: 'bi bi-person-dash' }), ' Remove');
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${m.name} from ${team.code}?`)) return;
      remove.disabled = true;
      try { await api('DELETE', `${path}/members/${encodeURIComponent(m.userId)}`); toast('success', `${m.name} removed`); await Promise.all([loadMembers(), fillUserPicker()]); }
      catch (e) { toast('danger', explain(e), withCid(e)); remove.disabled = false; }
    });
    rows.append(h('tr', {}, h('td', { text: m.name }), h('td', { class: 'font-monospace small text-secondary', text: m.userId }), h('td', {}, roleSel), h('td', { class: 'small', text: fmtDateTime(m.joinedAt) }), h('td', { class: 'text-end' }, remove)));
  }
  if (!items.length) rows.append(h('tr', {}, h('td', { colspan: 5, class: 'text-secondary', text: 'No members yet. A project needs at least its owner in the team.' })));
  return new Set(items.map((m) => m.userId));
}

async function fillUserPicker() {
  const [users, { items }] = await Promise.all([userMap(), api('GET', `${path}/members`)]);
  const taken = new Set(items.map((m) => m.userId));
  const sel = clear($('#member-user'));
  for (const u of users.values()) if (!taken.has(u.id)) sel.append(h('option', { value: u.id, text: `${u.name} (${u.email})` }));
  if (!sel.children.length) sel.append(h('option', { value: '', text: 'Everyone is already a member', disabled: true, selected: true }));
}

async function loadProjects() {
  const { items } = await api('GET', `/api/projects?teamId=${encodeURIComponent(teamId)}&limit=50`);
  const ul = clear($('#team-projects'));
  for (const p of items) ul.append(h('li', { class: 'list-group-item d-flex justify-content-between' }, h('a', { href: `/projects/${encodeURIComponent(p.id)}/board`, text: `${p.projectKey} · ${p.name}` }), h('span', { class: 'badge text-bg-light', text: p.status })));
  if (!items.length) ul.append(h('li', { class: 'list-group-item text-secondary', text: 'None' }));
}

$('#edit-team').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!ev.target.reportValidity()) return;
  await submit(ev.target, (fd) => api('PATCH', path, { expectedVersion: team.version, name: fd.get('name'), description: fd.get('description') || '' }), { success: 'Team saved' }).catch(() => null);
  await loadTeam(); // on 409 this shows the current version so the user can retry
});
$('#archive-team').addEventListener('click', async () => {
  if (!confirm(`Archive ${team.code}? Archived teams accept no new members or projects.`)) return;
  try { await api('POST', `${path}/archive`, { expectedVersion: team.version }); toast('success', 'Team archived'); } catch (e) { toast('danger', explain(e), withCid(e)); }
  await loadTeam();
});
$('#add-member').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  if (!fd.get('userId')) return;
  await submit(ev.target, () => api('POST', `${path}/members`, { userId: fd.get('userId'), role: fd.get('role') }), { success: 'Member added' }).catch(() => null);
  await Promise.all([loadMembers(), fillUserPicker()]);
});

(async () => {
  try { await loadTeam(); await Promise.all([loadMembers(), fillUserPicker(), loadProjects()]); }
  catch (e) { toast('danger', explain(e), withCid(e)); }
})();
live(() => Promise.all([loadTeam(), loadMembers(), fillUserPicker(), loadProjects()]), { everyMs: 15_000 });
