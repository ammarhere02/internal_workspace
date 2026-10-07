import { api } from './api.js';
import { $, h, clear, toast, alertBox, explain, withCid } from './dom.js';
import { store } from './board-store.js';

/** Column configuration (TM-05), version-checked. Project edit lives on /projects/:id/edit. */
let columnsModal;

function columnRow(c) {
  const row = h('li', { class: 'list-group-item d-flex gap-2 align-items-center', dataset: { columnId: c.columnId ?? '' } },
    h('input', { class: 'form-control form-control-sm', name: 'name', value: c.name, required: true, maxlength: 40, 'aria-label': 'Column name' }),
    h('input', { class: 'form-control form-control-sm', name: 'wipLimit', type: 'number', min: 1, max: 999, value: c.wipLimit ?? '', placeholder: 'WIP', style: 'width:5.5rem', 'aria-label': 'WIP limit' }),
    h('span', { class: 'small text-secondary text-nowrap', text: c.columnId ? `${c.count ?? 0} cards` : 'new' }),
    h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', 'aria-label': 'Move up', onclick: () => row.previousElementSibling?.before(row) }, h('i', { class: 'bi bi-arrow-up' })),
    h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', 'aria-label': 'Move down', onclick: () => row.nextElementSibling?.after(row) }, h('i', { class: 'bi bi-arrow-down' })),
    h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', 'aria-label': 'Remove column', onclick: () => row.remove() }, h('i', { class: 'bi bi-x-lg' })));
  return row;
}
function openColumns() {
  const list = clear($('#columns-list'));
  for (const c of store.board.columns) list.append(columnRow(c));
  $('#columns-version').textContent = `board version ${store.board.version}`;
  columnsModal ??= new bootstrap.Modal('#columns-modal');
  columnsModal.show();
}
async function saveColumns(ev) {
  ev.preventDefault();
  const columns = [...$('#columns-list').children].map((row) => {
    const c = { name: row.querySelector('[name=name]').value.trim() };
    if (row.dataset.columnId) c.columnId = row.dataset.columnId;
    const wip = row.querySelector('[name=wipLimit]').value;
    c.wipLimit = wip ? Number(wip) : null;
    return c;
  });
  try {
    await api('PUT', `/api/projects/${encodeURIComponent(store.projectId)}/board/columns`, { expectedVersion: store.board.version, columns });
    toast('success', 'Columns saved');
    columnsModal.hide();
    await store.reload();
  } catch (e) {
    if (e.code === 'version_conflict') { columnsModal.hide(); alertBox('warning', 'Board columns changed elsewhere.', ` ${explain(e)}`, { id: 'conflict' }); await store.reload(); }
    else toast('danger', explain(e), withCid(e));
  }
}

export function initConfig() {
  $('#columns-btn').addEventListener('click', openColumns);
  $('#add-column').addEventListener('click', () => $('#columns-list').append(columnRow({ name: '', wipLimit: null })));
  $('#columns-form').addEventListener('submit', saveColumns);
}
