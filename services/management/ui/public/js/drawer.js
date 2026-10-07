import { api } from './api.js';
import { $, h, toast, alertBox, explain, withCid } from './dom.js';
import { store } from './board-store.js';
import { openMoveDialog } from './board.js';

/**
 * Work-item drawer (PDF §12): create and edit with every field, issue key and version visible.
 * Editable fields go through PATCH with expectedVersion; assignee changes go through POST /assign
 * (its own event, workitem.assigned); archive through POST /archive. The assignee picker lists only
 * members of the owning team; the server enforces the same rule (422 assignee_not_in_team).
 */
let drawer, current = null; // current = item being edited, or null for create
const f = (id) => $(`#${id}`);

function fillAssignees(selected) {
  const sel = f('i-assignee');
  sel.replaceChildren(h('option', { value: '', text: 'Unassigned' }), ...store.members.map((m) => h('option', { value: m.userId, text: `${m.name} (${m.role})`, selected: m.userId === selected })));
  if (selected && !store.members.some((m) => m.userId === selected)) sel.append(h('option', { value: selected, text: `${store.userName(selected)} (no longer in team)`, selected: true }));
}

export function openDrawer(itemId) {
  drawer ??= new bootstrap.Offcanvas('#item-drawer');
  const found = itemId ? store.findItem(itemId) : null;
  current = found?.item ?? null;
  const it = current;
  f('drawer-title').textContent = it ? `${it.issueKey} · version ${it.version}` : 'New work item';
  f('i-key').textContent = it?.issueKey ?? 'assigned on save';
  f('i-version').textContent = it?.version ?? '—';
  f('i-reporter').textContent = it ? store.userName(it.reporterId) : 'you';
  f('i-column').textContent = it ? found.column.name : '—';
  f('i-title').value = it?.title ?? '';
  f('i-type').value = it?.type ?? 'TASK';
  f('i-priority').value = it?.priority ?? 'MEDIUM';
  f('i-due').value = it?.dueDate ?? '';
  f('i-labels').value = it?.labels.join(', ') ?? '';
  f('i-desc').value = it?.description ?? '';
  f('i-notes').value = it?.acceptanceNotes ?? '';
  fillAssignees(it?.assigneeId ?? '');
  f('i-column-wrap').hidden = Boolean(it);
  f('i-column-select').replaceChildren(...store.board.columns.map((c) => h('option', { value: c.columnId, text: c.name })));
  f('i-move').hidden = !it; f('i-archive').hidden = !it;
  const readOnly = Boolean(it?.archivedAt || store.project.archivedAt);
  for (const el of f('item-form').querySelectorAll('input,select,textarea,button')) el.disabled = readOnly && el.type !== 'button';
  drawer.show();
  setTimeout(() => f('i-title').focus(), 300);
}

const labelsFrom = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

async function save(ev) {
  ev.preventDefault();
  const form = f('item-form');
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  const fields = { title: fd.get('title'), type: fd.get('type'), priority: fd.get('priority'), labels: labelsFrom(fd.get('labels')), description: fd.get('description'), acceptanceNotes: fd.get('acceptanceNotes'), dueDate: fd.get('dueDate') || null };
  const assigneeId = fd.get('assigneeId') || null;
  f('i-save').disabled = true;
  try {
    if (!current) {
      const body = { ...fields, assigneeId, columnId: fd.get('columnId') };
      const view = await api('POST', `/api/projects/${encodeURIComponent(store.projectId)}/items`, body);
      toast('success', `${view.issueKey} created`);
      await store.reload();
      drawer.hide();
      return;
    }
    let version = current.version, view = current;
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k])));
    if (Object.keys(changed).length) { view = await api('PATCH', `/api/items/${encodeURIComponent(current.id)}`, { expectedVersion: version, ...changed }); version = view.version; store.replaceItem(view); }
    if (assigneeId !== current.assigneeId) { view = await api('POST', `/api/items/${encodeURIComponent(current.id)}/assign`, { expectedVersion: version, assigneeId }); store.replaceItem(view); }
    toast('success', `${view.issueKey} saved (version ${view.version})`);
    drawer.hide();
  } catch (e) {
    if (e.code === 'version_conflict') {
      alertBox('warning', `Conflict on ${current.issueKey}.`, ` ${explain(e)} ${withCid(e)}`, { id: 'conflict' });
      await store.reload();
      openDrawer(current.id); // re-open with the current version so the user can redo the edit
    } else toast('danger', explain(e), withCid(e));
  } finally { f('i-save').disabled = false; }
}

async function archive() {
  if (!current || !confirm(`Archive ${current.issueKey}? It leaves the board and the workload counts; its history stays in the activity feed.`)) return;
  try {
    await api('POST', `/api/items/${encodeURIComponent(current.id)}/archive`, { expectedVersion: current.version });
    toast('success', `${current.issueKey} archived`);
    drawer.hide();
    await store.reload();
  } catch (e) {
    if (e.code === 'version_conflict') { alertBox('warning', `Conflict on ${current.issueKey}.`, ` ${explain(e)}`, { id: 'conflict' }); await store.reload(); openDrawer(current.id); }
    else toast('danger', explain(e), withCid(e));
  }
}

f('item-form').addEventListener('submit', save);
f('i-archive').addEventListener('click', archive);
f('i-move').addEventListener('click', () => { const id = current?.id; drawer.hide(); if (id) openMoveDialog(id); });
