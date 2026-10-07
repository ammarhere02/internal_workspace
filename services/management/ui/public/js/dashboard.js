import { live } from './live.js';
import { api } from './api.js';
import { $, h, clear, fmtDateTime, fmtAgo, explain, toast, withCid } from './dom.js';
import { classify } from './freshness.js';

async function load() {
  let summary;
  try {
    summary = await api('GET', '/api/dashboard');
  } catch (e) {
    toast('danger', explain(e), withCid(e));
    return;
  }
  for (const k of ['teams', 'activeProjects', 'openItems', 'overdueItems']) $(`#stat-${k}`).textContent = summary[k];
  const rows = clear($('#freshness-rows'));
  if (!summary.recentProjects.length) { rows.append(h('tr', {}, h('td', { colspan: 6, class: 'text-secondary', text: 'No projects yet.' }))); return; }
  await Promise.all(summary.recentProjects.map(async (p) => {
    const row = h('tr', {}, h('td', {}, h('a', { href: `/projects/${encodeURIComponent(p.id)}/insights`, text: `${p.projectKey} ${p.name}` })), h('td', { text: p.status }), h('td', { text: '…' }), h('td'), h('td'), h('td'));
    rows.append(row);
    let reply = null, error = null;
    try { reply = await api('GET', `/api/projects/${encodeURIComponent(p.id)}/insights`); } catch (e) { error = { detail: explain(e) }; }
    const f = classify({ reply, error, authoritativeLatest: p.latestChangeAt });
    const cells = row.children;
    cells[2].replaceChildren(h('span', { class: `badge text-bg-${f.kind}`, text: f.label }));
    cells[3].textContent = fmtDateTime(f.freshness?.lastEventOccurredAt);
    cells[4].textContent = fmtDateTime(f.freshness?.lastProcessedAt);
    const fr = f.freshness;
    cells[5].textContent = f.state === 'fresh' && fr ? `up to date · consumer processed ${fmtAgo(fr.processingAgeMs)} · stream seq ${fr.lastStreamSeq ?? '—'}` : f.detail;
    cells[5].className = 'small text-secondary';
  }));
}
$('#refresh-freshness').addEventListener('click', load);
load();
live(load, { everyMs: 30_000 });
