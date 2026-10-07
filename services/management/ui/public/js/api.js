/**
 * The only way the browser talks to the backend: same-origin /api/* JSON calls.
 * Every error becomes an ApiError carrying the server envelope {code, message, details, correlationId},
 * so screens can explain 409/422/503 to the user and quote the correlation id.
 */
import { noteSessionResponse, showSessionExpired } from './session.js';

export class ApiError extends Error {
  constructor(status, body, correlationId) {
    const err = body?.error ?? {};
    super(err.message || `request failed (${status})`);
    this.status = status;
    this.code = err.code || `http_${status}`;
    this.details = err.details ?? null;
    this.correlationId = err.correlationId || correlationId || '';
  }
}

const DEV_USER_KEY = 'tm.devUser';
export const devUser = {
  get: () => { try { return localStorage.getItem(DEV_USER_KEY) || ''; } catch { return ''; } },
  set: (v) => { try { v ? localStorage.setItem(DEV_USER_KEY, v) : localStorage.removeItem(DEV_USER_KEY); } catch { /* storage blocked: header simply stays default */ } },
};

// ---- live updates: every successful write tells this tab and the others to refresh (see live.js) ----
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tm.data') : null;
const changeListeners = new Set();
export function onDataChanged(fn) { changeListeners.add(fn); }
function dataChanged() {
  for (const fn of changeListeners) fn();
  channel?.postMessage('changed');
}
channel?.addEventListener('message', () => { for (const fn of changeListeners) fn(); });

let passiveDepth = 0;
/** Runs fn with every api() call inside it marked passive (background refresh). */
export async function asPassive(fn) {
  passiveDepth++;
  try { return await fn(); } finally { passiveDepth--; }
}

/** opts.passive = true marks a background poll: the server validates the session but does NOT slide the idle window. */
export async function api(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' };
  if (opts.passive ?? passiveDepth > 0) headers['x-session-passive'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const u = devUser.get();
  if (u) headers['x-dev-user'] = u;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const correlationId = res.headers.get('x-correlation-id') || '';
  noteSessionResponse(res); // re-arms the expiry timers from x-session-expires
  if (res.ok && method !== 'GET') queueMicrotask(dataChanged);
  if (res.status === 204) return null;
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.status === 401 && ['unauthenticated', 'invalid_token'].includes(json?.error?.code)) showSessionExpired();
  if (!res.ok) throw new ApiError(res.status, json, correlationId);
  return json;
}

let usersPromise;
/** id → {id,name,email} for every active workspace user (cached per page load). */
export async function userMap() {
  usersPromise ??= api('GET', '/api/users').then((r) => new Map(r.items.map((u) => [u.id, u])));
  return usersPromise;
}
export async function userName(id) {
  if (!id) return 'Unassigned';
  const users = await userMap();
  return users.get(id)?.name ?? id;
}

/** Activity summaries come from events and mention user ids ("assigned PAY-1 to usr_blake_dev"); show names instead. */
export async function humanize(text) {
  const users = await userMap();
  return String(text).replace(/\busr_[A-Za-z0-9_]+/g, (id) => users.get(id)?.name ?? id);
}
