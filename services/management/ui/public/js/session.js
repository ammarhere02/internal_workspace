/**
 * Session timeout UX. The server runs two clocks (docs/auth.md): a sliding idle window and an absolute limit.
 * Every API response carries `x-session-expires`; this module re-arms two timers from it:
 *   - a warning (alert with "Stay signed in") when 5 minutes are left,
 *   - a modal at expiry, which signs out on the server and opens the login page.
 * The modal also opens when the API answers 401 unauthenticated / invalid_token (api.js).
 * Real activity (click, key, scroll) pings the API at most once a minute so working in a form without server calls
 * does not time the user out; idle time (no activity) is exactly what the server measures.
 */
let shown = false;
let warnTimer, endTimer;
let lastContact = Date.now();
const WARN_MS = 5 * 60_000;
const PING_EVERY_MS = 60_000;

export function showSessionExpired() {
  if (shown) return;
  shown = true;
  clearTimeout(warnTimer); clearTimeout(endTimer);
  document.getElementById('session-warn')?.remove();
  const el = document.createElement('div');
  el.className = 'modal fade'; el.tabIndex = -1; el.setAttribute('aria-labelledby', 'expired-title'); el.setAttribute('data-bs-backdrop', 'static'); el.setAttribute('data-bs-keyboard', 'false');
  el.innerHTML = `<div class="modal-dialog modal-dialog-centered"><div class="modal-content">
    <div class="modal-body text-center p-4">
      <div class="display-5 text-warning mb-2"><i class="bi bi-hourglass-bottom"></i></div>
      <h2 class="h4" id="expired-title">Your session has expired</h2>
      <p class="text-secondary mb-4">For your security you have been signed out after a period without activity. Sign in again to continue.</p>
      <button type="button" class="btn btn-primary btn-lg px-4" id="expired-signin"><i class="bi bi-box-arrow-in-right"></i> Sign in again</button>
    </div></div></div>`;
  document.body.append(el);
  // always end any server-side session first, so the login page is shown even if the clock and the server disagree
  el.querySelector('#expired-signin').addEventListener('click', () => { fetch('/auth/logout', { method: 'POST', redirect: 'manual' }).catch(() => {}).finally(() => { location.href = '/login?error=session_expired'; }); });
  if (window.bootstrap) new window.bootstrap.Modal(el).show(); else el.style.display = 'block';
}

function showWarning(minutes) {
  const box = document.getElementById('alerts');
  if (!box) return;
  document.getElementById('session-warn')?.remove();
  const el = document.createElement('div');
  el.id = 'session-warn'; el.className = 'alert alert-warning d-flex align-items-center gap-3'; el.setAttribute('role', 'alert');
  const text = document.createElement('div'); text.className = 'flex-grow-1';
  text.innerHTML = '<strong>Your session is about to expire.</strong> ';
  text.append(document.createTextNode(`You will be signed out in about ${minutes} minute${minutes === 1 ? '' : 's'} because of inactivity. Save your work.`));
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-sm btn-warning'; btn.textContent = 'Stay signed in';
  btn.addEventListener('click', () => { btn.disabled = true; keepAlive(); });
  el.append(text, btn);
  box.prepend(el);
}

/** Arms the warning and the expiry dialog from an ISO time; null = no expiry (dev mode). Called after every API response. */
export function watchSession(expiresAtIso) {
  clearTimeout(warnTimer); clearTimeout(endTimer);
  if (!expiresAtIso || shown) return;
  const left = Date.parse(expiresAtIso) - Date.now();
  if (Number.isNaN(left)) return;
  if (left <= 0) return showSessionExpired();
  if (left > WARN_MS) document.getElementById('session-warn')?.remove(); // renewed: the warning no longer applies
  if (left > WARN_MS) warnTimer = setTimeout(() => showWarning(5), left - WARN_MS);
  else showWarning(Math.max(1, Math.ceil(left / 60_000)));
  endTimer = setTimeout(showSessionExpired, Math.min(left, 2 ** 31 - 1));
}

/** Called by api.js for every response. */
export function noteSessionResponse(res) {
  lastContact = Date.now();
  const iso = res.headers.get('x-session-expires');
  if (iso) watchSession(iso);
}

/** Renews the window with the cheapest authenticated call. */
export async function keepAlive() {
  try {
    const res = await fetch('/api/me', { headers: { accept: 'application/json' } });
    if (res.status === 401) return showSessionExpired();
    noteSessionResponse(res);
  } catch { /* offline: the timers still end the session on time */ }
}

for (const ev of ['click', 'keydown', 'scroll']) {
  addEventListener(ev, () => { if (!shown && Date.now() - lastContact > PING_EVERY_MS && document.getElementById('actor-name')) keepAlive(); }, { passive: true, capture: true });
}
