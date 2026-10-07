/**
 * Session expiry UX. Two triggers: (1) the API answers 401 unauthenticated / invalid_token (cookie gone, JWT expired
 * or the user was deactivated), (2) the clock reaches `sessionExpiresAt` from /api/me. Either way the user sees one
 * clear dialog and is sent to the login page; unsaved forms are not silently lost because a warning appears 5 minutes before.
 */
let shown = false;
let warnTimer, endTimer;

export function showSessionExpired() {
  if (shown) return;
  shown = true;
  clearTimeout(warnTimer); clearTimeout(endTimer);
  const el = document.createElement('div');
  el.className = 'modal fade'; el.tabIndex = -1; el.setAttribute('aria-labelledby', 'expired-title'); el.setAttribute('data-bs-backdrop', 'static'); el.setAttribute('data-bs-keyboard', 'false');
  el.innerHTML = `<div class="modal-dialog modal-dialog-centered"><div class="modal-content">
    <div class="modal-body text-center p-4">
      <div class="display-5 text-warning mb-2"><i class="bi bi-hourglass-bottom"></i></div>
      <h2 class="h4" id="expired-title">Your session has expired</h2>
      <p class="text-secondary mb-4">For your security you have been signed out. Sign in again to continue where you left off.</p>
      <button type="button" class="btn btn-primary btn-lg px-4" id="expired-signin"><i class="bi bi-box-arrow-in-right"></i> Sign in again</button>
    </div></div></div>`;
  document.body.append(el);
  // always end any server-side session first, so the login page is shown even if the clock and the server disagree
  el.querySelector('#expired-signin').addEventListener('click', () => { fetch('/auth/logout', { method: 'POST', redirect: 'manual' }).catch(() => {}).finally(() => { location.href = '/login?error=session_expired'; }); });
  if (window.bootstrap) new window.bootstrap.Modal(el).show(); else el.style.display = 'block';
}

/** Arms the warning (5 min before) and the expiry dialog from the ISO time returned by /api/me; null = no expiry (dev mode). */
export function watchSession(expiresAtIso, onWarn) {
  clearTimeout(warnTimer); clearTimeout(endTimer);
  if (!expiresAtIso) return;
  const left = Date.parse(expiresAtIso) - Date.now();
  if (Number.isNaN(left)) return;
  if (left <= 0) return showSessionExpired();
  const warnIn = left - 5 * 60_000;
  if (warnIn > 0) warnTimer = setTimeout(() => onWarn?.(5), warnIn);
  else onWarn?.(Math.max(1, Math.ceil(left / 60_000)));
  endTimer = setTimeout(showSessionExpired, Math.min(left, 2 ** 31 - 1));
}
