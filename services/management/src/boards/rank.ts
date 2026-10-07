/**
 * Deterministic string ranks (LexoRank-style). A card's position is one string; sorting
 * by (columnId, rank, _id) gives the board order. Moving a card = writing one new rank
 * strictly between its new neighbours, so other cards are never rewritten.
 * Alphabet 0-9a-z; generated ranks never end in '0', which guarantees a gap always exists.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
const idx = (c: string) => ALPHABET.indexOf(c);

export const FIRST_RANK = 'n';

/** Strictly between prev and next. '' for prev = before everything, '' for next = after everything. */
export function rankBetween(prev: string, next: string): string {
  if (prev && next && prev >= next) throw new Error(`rankBetween: prev ${prev} must be < next ${next}`);
  let rank = '';
  let i = 0;
  let upper = next;
  for (;;) {
    const p = i < prev.length ? idx(prev[i]!) : 0;
    const n = i < upper.length ? idx(upper[i]!) : BASE;
    if (p === n) { rank += ALPHABET[p]; i++; continue; }        // shared prefix so far
    const mid = Math.floor((p + n) / 2);
    if (mid === p) { rank += ALPHABET[p]; i++; upper = ''; continue; } // adjacent: go one char deeper, unbounded above
    return rank + ALPHABET[mid];
  }
}
export const rankAfter = (prev: string) => rankBetween(prev, '');
export const rankBefore = (next: string) => rankBetween('', next);
