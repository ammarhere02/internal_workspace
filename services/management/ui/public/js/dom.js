/** Tiny DOM helpers. All user-authored text goes through textContent: never innerHTML with untrusted data (PDF §12). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'draggable') el.setAttribute('draggable', String(v)); // not a boolean attribute: must be "true"/"false"
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');
export function fmtAgo(ms) {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Bootstrap toast; kind ∈ success|danger|warning|info. */
export function toast(kind, message, detail) {
  const el = h('div', { class: `toast text-bg-${kind} border-0`, role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'd-flex' },
      h('div', { class: 'toast-body' }, h('div', { text: message }), detail ? h('small', { class: 'opacity-75', text: detail }) : null),
      h('button', { type: 'button', class: 'btn-close btn-close-white me-2 m-auto', 'data-bs-dismiss': 'toast', 'aria-label': 'Close' })));
  $('#toasts').append(el);
  const t = new bootstrap.Toast(el, { delay: kind === 'danger' ? 9000 : 4000 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

/** Persistent alert at the top of the content area (used for conflicts and outages the user must read). */
export function alertBox(kind, title, body, { id } = {}) {
  const box = $('#alerts');
  if (id) box.querySelector(`[data-alert="${id}"]`)?.remove();
  const el = h('div', { class: `alert alert-${kind} alert-dismissible`, role: 'alert', dataset: id ? { alert: id } : {} },
    h('strong', { text: title }), ' ', body,
    h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'alert', 'aria-label': 'Close' }));
  box.prepend(el);
  return el;
}

/** Human explanation for an ApiError; used everywhere so 409/422/503 read the same. */
export function explain(err) {
  if (!err || err.status === undefined) return err?.message || 'unexpected error';
  switch (err.code) {
    case 'version_conflict': return `Someone else changed this first (your version ${err.details?.expectedVersion}, current ${err.details?.currentVersion}). The screen was refreshed; please redo your change.`;
    case 'validation_error': return `Invalid input: ${(err.details?.violations || [err.message]).join('; ')}`;
    case 'assignee_not_in_team': return 'That user is not a member of the project’s team, so they cannot be assigned.';
    case 'owner_not_in_team': return 'The project owner must be a member of the owning team.';
    case 'member_has_assignments': return 'This member still has active work items in the team’s projects. Reassign them first.';
    case 'column_not_empty': return 'A column that still holds cards cannot be removed. Move the cards first.';
    case 'insights_unavailable': return `Insights are temporarily unavailable (${err.details?.reason || 'unknown'}). The board is still authoritative.`;
    case 'not_found': return 'Not found in this workspace.';
    default: return `${err.message} (${err.code})`;
  }
}
export const withCid = (err) => (err?.correlationId ? `correlation id ${err.correlationId}` : '');

/** Submit helper: disables the form while the request runs and reports the outcome. */
export async function submit(form, fn, { success } = {}) {
  const btn = form.querySelector('[type=submit]');
  const buttons = [...form.querySelectorAll('button,fieldset')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const r = await fn(new FormData(form));
    if (success) toast('success', success);
    return r;
  } catch (e) {
    toast('danger', explain(e), withCid(e));
    throw e;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    btn?.focus();
  }
}

/** Initials avatar (the demo uses photos; we have no personal images, so initials in a coloured circle). */
export function avatar(name, extra = '') {
  const parts = String(name || '?').trim().split(/\s+/);
  const initials = (parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '');
  let hash = 0; for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return h('span', { class: `avatar avatar-${hash % 6} ${extra}`, title: name, 'aria-label': name, text: initials.toUpperCase() });
}
export const STATUS_BADGE = { PLANNED: 'secondary', ACTIVE: 'success', ON_HOLD: 'warning', COMPLETED: 'primary', ARCHIVED: 'dark' };
export const statusBadge = (status) => h('span', { class: `badge text-bg-${STATUS_BADGE[status] ?? 'light'}`, text: status });
