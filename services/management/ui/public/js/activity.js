import { api, userName, humanize } from './api.js';
import { $, h, clear, fmtDateTime, toast, explain, withCid } from './dom.js';
import { runProjectionPage, stateNotice } from './projection-page.js';

const projectId = $('#activity-page').dataset.projectId;
const pid = encodeURIComponent(projectId);
let nextCursor = null;

async function row(ev, project) {
  const who = await userName(ev.actorId);
  const item = ev.item ? h('a', { href: `/projects/${pid}/board`, class: 'font-monospace', text: ev.item.issueKey, title: ev.item.title }) : '—';
  return h('tr', {}, h('td', { class: 'text-nowrap small', text: fmtDateTime(ev.occurredAt), title: ev.occurredAt }), h('td', { text: who }), h('td', { text: await humanize(ev.summary) }), h('td', {}, item),
    h('td', { class: 'd-none d-md-table-cell small text-secondary font-monospace', text: `${ev.eventType} v${ev.aggregate?.version ?? '?'}`, title: `eventId ${ev.eventId} · correlationId ${ev.correlationId}` }));
}

async function renderRows(items, project, append = false) {
  const rows = append ? $('#activity-rows') : clear($('#activity-rows'));
  for (const ev of items) rows.append(await row(ev, project));
  if (!rows.children.length) rows.append(h('tr', {}, h('td', { colspan: 5, class: 'text-secondary', text: 'No activity recorded yet.' })));
}

$('#more-activity').addEventListener('click', async () => {
  try {
    const page = await api('GET', `/api/projects/${pid}/activity?limit=25&cursor=${encodeURIComponent(nextCursor)}`);
    await renderRows(page.items ?? [], null, true);
    nextCursor = page.nextCursor;
    $('#more-activity').hidden = !nextCursor;
  } catch (e) { toast('danger', explain(e), withCid(e)); }
});

runProjectionPage({
  projectId, active: 'activity',
  query: () => api('GET', `/api/projects/${pid}/activity?limit=25`),
  render: async ({ reply, state, project }) => {
    const notice = $('#activity-notice');
    notice.hidden = state.state === 'fresh';
    if (!notice.hidden) notice.replaceChildren(stateNotice(state));
    await renderRows(reply?.items ?? [], project);
    nextCursor = reply?.nextCursor ?? null;
    $('#more-activity').hidden = !nextCursor;
  },
}).catch((e) => toast('danger', explain(e), withCid(e)));
