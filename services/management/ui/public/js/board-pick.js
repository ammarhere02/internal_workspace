import { api } from './api.js';
import { $, h, clear, toast, explain, withCid, statusBadge } from './dom.js';

/** Top-level "Kanban Board" entry (like the AdminLTE demo): pick a project, open its board. Remembers the last board. */
const LAST = 'tm.lastBoard';
async function load() {
  const { items } = await api('GET', '/api/projects?limit=100');
  const sel = clear($('#pick-project'));
  let last = ''; try { last = localStorage.getItem(LAST) || ''; } catch { /* ignore */ }
  for (const p of items) sel.append(h('option', { value: p.id, text: `${p.projectKey} · ${p.name}`, selected: p.id === last }));
  if (!items.length) sel.append(h('option', { value: '', text: 'No projects available', disabled: true, selected: true }));
  const ul = clear($('#pick-list'));
  for (const p of items) ul.append(h('li', { class: 'list-group-item d-flex align-items-center gap-2' }, h('span', { class: 'font-monospace fw-semibold', text: p.projectKey }), p.name, statusBadge(p.status), h('a', { class: 'btn btn-sm btn-primary ms-auto', href: `/projects/${encodeURIComponent(p.id)}/board` }, h('i', { class: 'bi bi-kanban' }), ' Open')));
  if (!items.length) ul.append(h('li', { class: 'list-group-item text-secondary', text: 'No projects yet.' }));
}
$('#pick-open').addEventListener('click', () => { const id = $('#pick-project').value; if (id) location.href = `/projects/${encodeURIComponent(id)}/board`; });
$('#pick-project').addEventListener('change', (e) => { if (e.target.value) location.href = `/projects/${encodeURIComponent(e.target.value)}/board`; });
load().catch((e) => toast('danger', explain(e), withCid(e)));
