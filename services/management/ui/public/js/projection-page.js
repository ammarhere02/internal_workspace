import { api } from './api.js';
import { $, h, fmtDateTime, explain } from './dom.js';
import { projectNav } from './shell.js';
import { classify, latestAuthoritative } from './freshness.js';

/**
 * Shared driver for the two projection screens (activity, insights). It loads the authoritative project
 * + board (to know the newest change the projection should contain), queries the projection endpoint,
 * classifies freshness, and keeps polling while the state is pending/not_ready so the screen catches up
 * on its own (TM-12). "Last query" (did the request succeed) is shown separately from freshness.
 */
export async function runProjectionPage({ projectId, active, query, render, pollMs = 4000 }) {
  const pid = encodeURIComponent(projectId);
  const [project, board] = await Promise.all([api('GET', `/api/projects/${pid}`), api('GET', `/api/projects/${pid}/board`)]);
  document.title = `${project.projectKey} ${active} · Team Management`;
  $('#page-title').textContent = `${project.projectKey} · ${project.name} — ${active}`;
  projectNav(project, active);
  const authoritativeLatest = latestAuthoritative(project, board);
  let timer = null, lastGood = null;

  async function refresh(background = false) {
    clearTimeout(timer);
    let reply = null, error = null;
    try { reply = await query({ passive: background }); lastGood = reply; $('#fresh-last-query').textContent = `last query ok ${new Date().toLocaleTimeString()}`; }
    catch (e) { error = { detail: `${explain(e)} ${e.correlationId ? `(correlation id ${e.correlationId})` : ''}` }; $('#fresh-last-query').textContent = `last query failed ${new Date().toLocaleTimeString()}`; }
    const f = classify({ reply, error, authoritativeLatest });
    const badge = $('#fresh-badge');
    badge.className = `badge text-bg-${f.kind}`;
    badge.textContent = f.label;
    $('#fresh-detail').textContent = f.detail + (f.state === 'unavailable' && lastGood ? ' Showing the last successful reply; it may be outdated.' : '');
    render({ reply: reply ?? lastGood, state: f, project, board });
    // keep polling until fresh: pending/stale catch up when the consumer folds the events, unavailable recovers when the responder is back
    if (f.state !== 'fresh') timer = setTimeout(() => refresh(true), f.state === 'unavailable' ? pollMs * 2 : pollMs); // background polling must not keep an idle session alive
  }
  $('#fresh-refresh').addEventListener('click', () => refresh(false));
  await refresh(false);
  return { project, board };
}

export const stateNotice = (state) => h('div', { class: `alert alert-${state.kind} mb-0`, role: 'status' }, h('strong', { text: `${state.label}: ` }), state.detail);
export { fmtDateTime };
