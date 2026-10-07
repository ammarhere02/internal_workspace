import { api, devUser, userMap } from './api.js';
import { $, h, clear, avatar } from './dom.js';
import { watchSession } from './session.js';

/** Header: workspace label + dev identity switcher (x-dev-user). Sidebar: user panel + per-project links. */
async function init() {
  try {
    const [me, users] = await Promise.all([api('GET', '/api/me'), userMap()]);
    $('#workspace-label').textContent = `${me.workspace.name} (${me.workspace.slug})`;
    const actor = users.get(me.actorId);
    $('#actor-name').textContent = actor?.name ?? me.actorId;
    $('#actor-avatar').replaceWith(avatar(actor?.name ?? '?', 'avatar-lg'));
    $('#actor-role').replaceChildren(h('span', { class: `badge ${me.role === 'ADMIN' ? 'text-bg-primary' : 'text-bg-secondary'} me-1`, text: me.role }), actor?.email ?? '');
    document.body.dataset.role = me.role;
    watchSession(me.sessionExpiresAt);
    if (me.role !== 'ADMIN') {
      $('#nav-home').href = '/my'; // an employee's home is My Work
      for (const el of document.querySelectorAll('[data-admin-only]')) el.hidden = true; // server enforces this too (403 forbidden)
      if (ADMIN_PAGES.some((re) => re.test(location.pathname))) { location.replace('/my'); return; }
    }
    const sel = $('#actor-select');
    if (me.authMode === 'google') {
      sel.replaceWith(h('form', { method: 'post', action: '/auth/logout', class: 'd-inline' }, h('button', { type: 'submit', class: 'btn btn-sm btn-outline-secondary' }, h('i', { class: 'bi bi-box-arrow-right' }), ' Sign out')));
    } else {
      for (const u of users.values()) sel.append(h('option', { value: u.id.replace(`_${me.workspace.slug}`, ''), text: `act as ${u.name}` }));
      const current = devUser.get() || 'usr_admin';
      sel.value = [...sel.options].some((o) => o.value === current) ? current : 'usr_admin';
      sel.addEventListener('change', () => { devUser.set(sel.value === 'usr_admin' ? '' : sel.value); location.href = '/my'; });
    }
  } catch {
    $('#workspace-label').textContent = 'identity unavailable';
    $('#actor-name').textContent = 'unknown user';
  }
}
const ADMIN_PAGES = [/^\/$/, /^\/teams/, /^\/projects\/new$/, /^\/projects\/[^/]+\/edit$/];
init();

export function projectNav(project, active) {
  const nav = clear($('#project-nav'));
  nav.hidden = false;
  nav.append(h('li', { class: 'nav-header', text: `${project.projectKey} · ${project.name}` }));
  const links = [['', 'detail', 'Project Detail', 'bi-file-earmark-text'], ['/board', 'board', 'Kanban Board', 'bi-kanban'], ['/activity', 'activity', 'Activity', 'bi-clock-history'], ['/insights', 'insights', 'Insights', 'bi-bar-chart-fill'], ['/edit', 'edit', 'Project Edit', 'bi-pencil-square']];
  for (const [suffix, key, label, icon] of links) {
    nav.append(h('li', { class: 'nav-item', 'data-admin-only': key === 'edit' ? true : undefined, hidden: key === 'edit' && document.body.dataset.role === 'EMPLOYEE' }, h('a', { href: `/projects/${encodeURIComponent(project.id)}${suffix}`, class: `nav-link${active === key ? ' active' : ''}` }, h('i', { class: `nav-icon bi ${icon}` }), h('p', { text: label }))));
  }
  const titles = { detail: 'Project Detail', board: 'Kanban Board', activity: 'Activity', insights: 'Insights', edit: 'Project Edit' };
  $('#breadcrumb').replaceChildren(
    h('li', { class: 'breadcrumb-item' }, h('a', { href: '/' }, 'Home')),
    h('li', { class: 'breadcrumb-item' }, h('a', { href: '/projects' }, 'Projects')),
    h('li', { class: 'breadcrumb-item active', 'aria-current': 'page', text: titles[active] ?? active }));
}
