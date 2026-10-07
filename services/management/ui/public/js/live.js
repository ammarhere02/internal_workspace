/**
 * Keeps a screen current without a manual reload. `live(refresh)` re-runs refresh():
 *  - right after this or another tab changes data (api.js broadcasts every successful write),
 *  - when the tab becomes visible / focused again,
 *  - every `everyMs` while visible, to pick up changes made by other people.
 * Background refreshes are passive (they never keep an idle session alive) and are skipped while
 * `busy()` says the user is in the middle of something (dragging, editing in a modal, ...).
 */
import { asPassive, onDataChanged } from './api.js';

export function live(refresh, { everyMs = 10_000, busy = () => false } = {}) {
  let running = false, again = false, timer = null;
  const editing = () => document.activeElement?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea, select:not(#actor-select)');
  const userBusy = () => busy() || editing() || Boolean(document.querySelector('.modal.show, .offcanvas.show'));
  async function tick() {
    clearTimeout(timer);
    if (document.hidden) return; // resumed by visibilitychange
    if (running || userBusy()) { again = true; schedule(1_000); return; }
    running = true;
    try { await asPassive(refresh); } catch { /* the next tick retries; screens show their own errors on first load */ }
    finally { running = false; }
    schedule(again ? 300 : everyMs);
    again = false;
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  onDataChanged(() => schedule(150)); // coalesce bursts of writes
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  window.addEventListener('focus', () => schedule(0));
  schedule(everyMs);
  return { now: () => schedule(0) };
}
