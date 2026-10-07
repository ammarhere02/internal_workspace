import { api } from './api.js';
import { $, h, clear, toast, alertBox, explain, withCid, fmtDate, avatar, statusBadge } from './dom.js';
import { projectNav } from './shell.js';
import { store } from './board-store.js';
import { openDrawer } from './drawer.js';
import { initConfig } from './board-config.js';

store.projectId = $('#board-page').dataset.projectId;
try { localStorage.setItem('tm.lastBoard', store.projectId); } catch { /* ignore */ }
const today = new Date().toISOString().slice(0, 10);
const filters = { q: '', assigneeId: '', priority: '', type: '', label: '' };

// ---- header -------------------------------------------------------------------------------------
function renderHeader() {
  const p = store.project;
  document.title = `${p.projectKey} board · Team Management`;
  $('#page-title').textContent = `${p.projectKey} · ${p.name}`;
  $('#project-heading').textContent = `${p.projectKey} · ${p.name}`;
  $('#project-status').replaceChildren(statusBadge(p.archivedAt ? 'ARCHIVED' : p.status));
  projectNav(p, 'board');
  const meta = clear($('#project-meta'));
  const chip = (icon, k, v) => meta.append(h('div', { class: 'meta-chip' }, h('i', { class: `bi ${icon}` }), h('dt', { text: k }), h('dd', { text: v })));
  chip('bi-people', 'Team', store.members.length ? `${store.members.length} members` : 'no members');
  chip('bi-person-badge', 'Leader', store.userName(p.ownerId));
  chip('bi-calendar-event', 'Start', fmtDate(p.startDate));
  chip('bi-flag', 'Target', fmtDate(p.targetDate));
  chip('bi-hash', 'Version', `project ${p.version} · board ${store.board.version}`);
  $('#edit-project-btn').href = `/projects/${encodeURIComponent(p.id)}/edit`;
  fillSwitcher();
  if (p.archivedAt) alertBox('secondary', 'Archived project.', ' Cards are read-only.', { id: 'archived' });
}

let switcherFilled = false;
async function fillSwitcher() {
  if (switcherFilled) return;
  switcherFilled = true;
  const sel = $('#board-switcher');
  try {
    const { items } = await api('GET', '/api/projects?limit=100');
    sel.replaceChildren(...items.map((p) => h('option', { value: p.id, text: `${p.projectKey} · ${p.name}`, selected: p.id === store.projectId })));
    sel.addEventListener('change', () => { if (sel.value && sel.value !== store.projectId) location.href = `/projects/${encodeURIComponent(sel.value)}/board`; });
  } catch { sel.hidden = true; }
}

// ---- filters (TM-11) ------------------------------------------------------------------------------
function matches(it) {
  if (filters.assigneeId === 'unassigned' ? it.assigneeId !== null : filters.assigneeId && it.assigneeId !== filters.assigneeId) return false;
  if (filters.priority && it.priority !== filters.priority) return false;
  if (filters.type && it.type !== filters.type) return false;
  if (filters.label && !it.labels.includes(filters.label)) return false;
  if (filters.q) {
    const q = filters.q.toLowerCase();
    if (![it.issueKey, it.title, ...it.labels].some((s) => s.toLowerCase().includes(q))) return false;
  }
  return true;
}
function renderFilterOptions() {
  const sel = $('#f-assignee');
  const keep = sel.value;
  sel.replaceChildren(h('option', { value: '', text: 'All' }), h('option', { value: 'unassigned', text: 'Unassigned' }), ...store.members.map((m) => h('option', { value: m.userId, text: m.name })));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  const labels = new Set(store.board.columns.flatMap((c) => c.items.flatMap((i) => i.labels)));
  $('#label-list').replaceChildren(...[...labels].sort().map((l) => h('option', { value: l })));
}
$('#filters').addEventListener('input', (ev) => { filters[ev.target.name] = ev.target.value.trim(); renderBoard(); });
$('#filters').addEventListener('reset', () => { setTimeout(() => { for (const k in filters) filters[k] = ''; renderBoard(); }); });

// ---- board ------------------------------------------------------------------------------------------
const COLUMN_COLORS = ['secondary', 'primary', 'info', 'success', 'warning', 'danger', 'dark'];
const PRIORITY_COLOR = { CRITICAL: 'danger', HIGH: 'warning', MEDIUM: 'primary', LOW: 'secondary' };

function card(it, col) {
  const overdue = it.dueDate && it.dueDate < today;
  const el = h('div', { class: `card card-${PRIORITY_COLOR[it.priority]} card-outline kanban-card${it.pending ? ' pending' : ''}`, draggable: !it.pending && !store.project.archivedAt, tabindex: 0, role: 'listitem', dataset: { id: it.id, column: col.columnId },
    'aria-label': `${it.issueKey} ${it.title}, ${it.priority} priority, ${store.userName(it.assigneeId)}, in ${col.name}` },
    h('div', { class: 'card-header' },
      h('h5', { class: 'card-title', text: it.title }),
      h('div', { class: 'card-tools d-flex align-items-center' },
        h('button', { type: 'button', class: 'btn btn-tool btn-link', title: 'Open', onclick: (e) => { e.stopPropagation(); openDrawer(it.id); } }, `#${it.issueKey}`),
        h('button', { type: 'button', class: 'btn btn-tool card-hover-tool', 'aria-label': `Edit ${it.issueKey}`, title: 'Edit', onclick: (e) => { e.stopPropagation(); openDrawer(it.id); } }, h('i', { class: 'bi bi-pencil' })),
        h('button', { type: 'button', class: 'btn btn-tool card-hover-tool', 'aria-label': `Move ${it.issueKey}`, title: 'Move (no drag needed)', onclick: (e) => { e.stopPropagation(); openMoveDialog(it.id); } }, h('i', { class: 'bi bi-arrows-move' })))),
    h('div', { class: 'card-body' },
      h('div', { class: 'meta' },
        h('span', { class: `prio-${it.priority}`, title: `${it.priority} priority` }, h('i', { class: 'bi bi-flag-fill' }), ` ${it.priority}`),
        h('span', { class: 'badge text-bg-light', text: it.type }),
        h('span', { title: 'assignee', class: 'd-inline-flex align-items-center gap-1' }, it.assigneeId ? avatar(store.userName(it.assigneeId), 'avatar-sm') : h('i', { class: 'bi bi-person' }), store.userName(it.assigneeId)),
        it.dueDate ? h('span', { class: overdue ? 'text-danger fw-semibold' : '', title: overdue ? 'overdue' : 'due' }, h('i', { class: 'bi bi-calendar-event' }), ` ${it.dueDate}`) : null,
        it.pending ? h('span', { class: 'badge text-bg-warning', text: 'saving…' }) : null),
      it.labels.length ? h('div', { class: 'labels' }, ...it.labels.map((l) => h('span', { class: 'badge text-bg-secondary me-1', text: l }))) : null));
  el.addEventListener('click', () => openDrawer(it.id));
  el.addEventListener('keydown', (e) => onCardKey(e, it, col));
  el.addEventListener('dragstart', (e) => { dragging = it.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.id); });
  el.addEventListener('dragend', () => { dragging = null; el.classList.remove('dragging'); clearDropMarks(); });
  return el;
}

let focusAfterRender = null;
function renderBoard() {
  const root = clear($('#kanban'));
  let visible = 0, total = 0;
  store.board.columns.forEach((col, idx) => {
    const shown = col.items.filter(matches);
    visible += shown.length; total += col.items.length;
    const wip = col.wipLimit !== null ? h('span', { class: `badge ${col.wipExceeded ? 'text-bg-light text-danger' : 'text-bg-light'}`, title: col.wipExceeded ? 'WIP limit exceeded' : 'WIP limit' }, col.wipExceeded ? h('i', { class: 'bi bi-exclamation-triangle-fill' }) : null, ` WIP ${col.count}/${col.wipLimit}`) : null;
    const cards = h('div', { class: 'card-body kanban-cards', dataset: { column: col.columnId } }, ...shown.map((it) => card(it, col)));
    const colEl = h('section', { class: `card card-row card-${COLUMN_COLORS[idx % COLUMN_COLORS.length]} kanban-col${col.wipExceeded ? ' wip-exceeded' : ''}`, dataset: { column: col.columnId }, 'aria-label': `${col.name}, ${col.count} cards` },
      h('div', { class: 'card-header' }, h('h3', { class: 'card-title', text: col.name }), h('span', { class: 'd-flex gap-1' }, h('span', { class: 'badge text-bg-light', title: 'visible / total', text: shown.length === col.count ? `${col.count}` : `${shown.length}/${col.count}` }), wip)),
      cards);
    attachDrop(colEl, col);
    root.append(colEl);
  });
  $('#filter-summary').textContent = visible === total ? `${total} cards` : `${visible} of ${total} cards match the filters`;
  if (focusAfterRender) { root.querySelector(`[data-id="${CSS.escape(focusAfterRender)}"]`)?.focus(); focusAfterRender = null; }
}

// ---- moves: optimistic with rollback, expectedVersion on every call (TM-08, PDF §12) ---------------
/** afterItemId: null = top, undefined = bottom, id = after that card. */
export async function moveItem(itemId, toColumnId, afterItemId) {
  const found = store.findItem(itemId);
  if (!found || found.item.pending) return;
  const { column: from, item } = found;
  const to = store.column(toColumnId);
  const snap = store.snapshot();
  // optimistic placement
  from.items = from.items.filter((i) => i.id !== itemId);
  const idx = afterItemId === null ? 0 : afterItemId === undefined ? to.items.length : to.items.findIndex((i) => i.id === afterItemId) + 1;
  to.items.splice(idx, 0, item);
  item.pending = true;
  item.columnId = toColumnId; // rank stays unknown until the server replies; recount(false) keeps the optimistic order
  store.recount(false);
  if (to.wipLimit !== null && to.items.length > to.wipLimit) toast('warning', `WIP limit of ${to.name} exceeded (${to.items.length}/${to.wipLimit})`, 'The move is allowed; the limit is a warning.');
  focusAfterRender = itemId;
  store.notify();
  try {
    const body = { expectedVersion: item.version, toColumnId };
    if (afterItemId !== undefined) body.afterItemId = afterItemId;
    const view = await api('POST', `/api/items/${encodeURIComponent(itemId)}/move`, body);
    store.replaceItem(view);
  } catch (e) {
    if (e.code === 'version_conflict') {
      alertBox('warning', `Conflict on ${item.issueKey}.`, ` ${explain(e)} ${withCid(e)}`, { id: 'conflict' });
      await store.reload(); // the authoritative board replaces the optimistic one
    } else {
      store.restore(snap); // rollback: the UI must not pretend the move persisted
      toast('danger', `Move of ${item.issueKey} failed and was undone: ${explain(e)}`, withCid(e));
    }
    focusAfterRender = itemId;
    store.notify();
  }
}

// drag and drop (native HTML5)
let dragging = null;
function clearDropMarks() { for (const el of document.querySelectorAll('.drop-target,.drop-before,.drop-after')) el.classList.remove('drop-target', 'drop-before', 'drop-after'); }
function dropTarget(colEl, y) {
  const cards = [...colEl.querySelectorAll('.kanban-card')].filter((c) => c.dataset.id !== dragging);
  for (const c of cards) { const r = c.getBoundingClientRect(); if (y < r.top + r.height / 2) return { before: c }; }
  return { before: null };
}
function attachDrop(colEl, col) {
  colEl.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    colEl.classList.add('drop-target');
    const { before } = dropTarget(colEl, e.clientY);
    if (before) before.classList.add('drop-before'); else colEl.querySelectorAll('.kanban-card:not(.dragging)')[col.items.length - 1]?.classList.add('drop-after');
  });
  colEl.addEventListener('dragleave', (e) => { if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('drop-target'); });
  colEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragging; // dataTransfer first: `dragging` can go stale if the board re-rendered mid-drag
    const { before } = dropTarget(colEl, e.clientY);
    dragging = null;
    clearDropMarks();
    // anchor = the card before the drop point in the FULL column order (filters may hide cards)
    const others = col.items.filter((i) => i.id !== id);
    let after;
    if (before) { const i = others.findIndex((x) => x.id === before.dataset.id); after = i <= 0 ? null : others[i - 1].id; }
    else after = others.length ? others.at(-1).id : null;
    const cur = store.findItem(id);
    if (!cur) return;
    if (cur.column.columnId === col.columnId) { // dropping a card where it already is = no command
      const curIdx = col.items.findIndex((x) => x.id === id);
      const newIdx = after === null ? 0 : others.findIndex((x) => x.id === after) + 1;
      if (newIdx === curIdx) return;
    }
    moveItem(id, col.columnId, after);
  });
}

// keyboard (PDF §12: non-drag movement)
function onCardKey(e, it, col) {
  if (e.key === 'Enter') { e.preventDefault(); openDrawer(it.id); return; }
  if (e.key.toLowerCase() === 'm' && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openMoveDialog(it.id); return; }
  if (!e.altKey) return;
  const cols = store.board.columns, ci = cols.indexOf(col), idx = col.items.findIndex((x) => x.id === it.id);
  if (e.key === 'ArrowLeft' && ci > 0) { e.preventDefault(); moveItem(it.id, cols[ci - 1].columnId, undefined); }
  else if (e.key === 'ArrowRight' && ci < cols.length - 1) { e.preventDefault(); moveItem(it.id, cols[ci + 1].columnId, undefined); }
  else if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); moveItem(it.id, col.columnId, idx === 1 ? null : col.items[idx - 2].id); }
  else if (e.key === 'ArrowDown' && idx < col.items.length - 1) { e.preventDefault(); moveItem(it.id, col.columnId, col.items[idx + 1].id); }
}

// move dialog (non-drag action)
let moveModal, moveTarget;
export function openMoveDialog(itemId) {
  const found = store.findItem(itemId);
  if (!found) return;
  moveTarget = itemId;
  $('#move-what').textContent = `${found.item.issueKey} · ${found.item.title} (currently in ${found.column.name}, version ${found.item.version})`;
  const colSel = $('#move-column');
  colSel.replaceChildren(...store.board.columns.map((c) => h('option', { value: c.columnId, text: `${c.name} (${c.count})`, selected: c.columnId === found.column.columnId })));
  const fillPositions = () => {
    const col = store.column(colSel.value);
    const others = col.items.filter((i) => i.id !== itemId);
    $('#move-position').replaceChildren(h('option', { value: 'top', text: 'Top' }), ...others.map((i) => h('option', { value: i.id, text: `After ${i.issueKey} · ${i.title}` })), h('option', { value: 'bottom', text: 'Bottom', selected: true }));
  };
  colSel.onchange = fillPositions;
  fillPositions();
  moveModal ??= new bootstrap.Modal('#move-modal');
  moveModal.show();
}
$('#move-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const pos = $('#move-position').value;
  moveModal.hide();
  moveItem(moveTarget, $('#move-column').value, pos === 'top' ? null : pos === 'bottom' ? undefined : pos);
});
$('#move-modal').addEventListener('hidden.bs.modal', () => { focusAfterRender = moveTarget; renderBoard(); });

// ---- boot ---------------------------------------------------------------------------------------------
store.onChange(() => { renderHeader(); renderFilterOptions(); renderBoard(); });
$('#new-item-btn').addEventListener('click', () => openDrawer(null));
initConfig();
store.reload().catch((e) => { $('#project-heading').textContent = 'Project unavailable'; toast('danger', explain(e), withCid(e)); });
