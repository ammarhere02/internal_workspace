import { api } from './api.js';
import { $, h, clear, submit, toast, explain, withCid } from './dom.js';

let cursor = null;
let busy = false; // a second "Load more" click while a page is in flight would append the same page twice
async function load(reset = true) {
  if (busy) return;
  busy = true;
  try { await loadPage(reset); } finally { busy = false; }
}
async function loadPage(reset) {
  const rows = $('#team-rows');
  if (reset) { clear(rows); cursor = null; }
  const q = new URLSearchParams({ limit: 25, includeArchived: $('#include-archived').checked });
  if (cursor) q.set('cursor', cursor);
  try {
    const page = await api('GET', `/api/teams?${q}`);
    for (const t of page.items) rows.append(h('tr', {},
      h('td', {}, h('a', { href: `/teams/${encodeURIComponent(t.id)}`, class: 'font-monospace', text: t.code })),
      h('td', { text: t.name }), h('td', { class: 'text-secondary small', text: t.description }), h('td', { text: t.version }),
      h('td', {}, t.archivedAt ? h('span', { class: 'badge text-bg-secondary', text: 'archived' }) : h('span', { class: 'badge text-bg-success', text: 'active' }))));
    if (!rows.children.length) rows.append(h('tr', {}, h('td', { colspan: 5, class: 'text-secondary', text: 'No teams yet. Create one on the left.' })));
    cursor = page.nextCursor;
    $('#more-teams').hidden = !cursor;
  } catch (e) { toast('danger', explain(e), withCid(e)); }
}
$('#include-archived').addEventListener('change', () => load());
$('#more-teams').addEventListener('click', () => load(false));
$('#create-team').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  if (!form.reportValidity()) return;
  const t = await submit(form, (fd) => api('POST', '/api/teams', { name: fd.get('name'), code: String(fd.get('code')).toUpperCase(), description: fd.get('description') || '' }), { success: 'Team created' }).catch(() => null);
  if (t) { form.reset(); location.href = `/teams/${encodeURIComponent(t.id)}`; }
});
load();
