/** E-mail/password sign-in and registration: POST JSON, the server sets the HttpOnly JWT cookie and tells us where to go. */
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? {};
    const msg = err.code === 'validation_error' ? (err.details?.violations ?? [err.message]).join('; ') : err.code === 'invalid_credentials' ? 'E-mail or password is incorrect.' : err.code === 'too_many_attempts' ? `Too many attempts. Try again in ${err.details?.retryAfterSec ?? 'a few'} seconds.` : err.code === 'email_taken' ? 'An account with this e-mail already exists. Sign in instead.' : err.message || 'Request failed';
    throw new Error(msg);
  }
  return json;
}
function wire(formId, errorId, path) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errBox = document.getElementById(errorId);
    errBox.hidden = true;
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try { const r = await post(path, body); location.href = r.landing || '/my'; }
    catch (e) { errBox.textContent = e.message; errBox.hidden = false; btn.disabled = false; }
  });
}
wire('login-form', 'login-error', '/auth/login');
wire('register-form', 'register-error', '/auth/register');
