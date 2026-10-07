import { api, userName } from './api.js';
import { $, h, clear, toast, explain, withCid } from './dom.js';
import { runProjectionPage, stateNotice } from './projection-page.js';

const projectId = $('#insights-page').dataset.projectId;
const pid = encodeURIComponent(projectId);
$('#board-link').href = `/projects/${pid}/board`;

function bar(label, value, total) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return h('li', { class: 'list-group-item py-1' }, h('div', { class: 'd-flex justify-content-between small' }, h('span', { text: label }), h('strong', { text: value })),
    h('div', { class: 'progress', style: 'height: 4px', role: 'progressbar', 'aria-label': label, 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { class: 'progress-bar', style: `width: ${pct}%` })));
}

runProjectionPage({
  projectId, active: 'insights',
  query: () => api('GET', `/api/projects/${pid}/insights`),
  render: async ({ reply, state, board }) => {
    const notice = $('#insights-notice');
    notice.hidden = state.state === 'fresh';
    if (!notice.hidden) notice.replaceChildren(stateNotice(state));
    const w = reply?.workload;
    const columns = board.columns.map((c) => ({ id: c.columnId, name: c.name }));
    for (const k of Object.keys(w?.byColumn ?? {})) if (!columns.some((c) => c.id === k)) columns.push({ id: k, name: k });
    $('#assignee-head').replaceChildren(h('tr', {}, h('th', { text: 'Assignee' }), h('th', { class: 'text-end', text: 'Active' }), ...columns.map((c) => h('th', { class: 'text-end d-none d-md-table-cell', text: c.name }))));
    const rows = clear($('#assignee-rows'));
    if (!w) { rows.append(h('tr', {}, h('td', { colspan: 2 + columns.length, class: 'text-secondary', text: 'No workload data available.' }))); clear($('#by-column')); clear($('#by-priority')); return; }
    for (const a of w.byAssignee) {
      rows.append(h('tr', {}, h('td', { text: await userName(a.assigneeId) }), h('td', { class: 'text-end fw-semibold', text: a.total }), ...columns.map((c) => h('td', { class: 'text-end d-none d-md-table-cell text-secondary', text: a.byColumn[c.id] ?? 0 }))));
    }
    rows.append(h('tr', { class: 'table-light' }, h('td', { text: 'Total active' }), h('td', { class: 'text-end fw-bold', text: w.totalActive }), ...columns.map((c) => h('td', { class: 'text-end d-none d-md-table-cell', text: w.byColumn[c.id] ?? 0 }))));
    const byCol = clear($('#by-column'));
    for (const c of columns) byCol.append(bar(c.name, w.byColumn[c.id] ?? 0, w.totalActive));
    const byPrio = clear($('#by-priority'));
    for (const p of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) byPrio.append(bar(p, w.byPriority[p] ?? 0, w.totalActive));
  },
}).catch((e) => toast('danger', explain(e), withCid(e)));
