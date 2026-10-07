import { describe, expect, it } from 'vitest';
import { FIRST_RANK, rankAfter, rankBefore, rankBetween } from './rank.js';

describe('rank', () => {
  it('generates ranks strictly between neighbours', () => {
    expect(rankBetween('a', 'c')).toBe('b');
    const r = rankBetween('n', 'o');
    expect(r > 'n' && r < 'o').toBe(true);
  });
  it('is deterministic', () => {
    expect(rankBetween('h', 'n')).toBe(rankBetween('h', 'n'));
  });
  it('never ends in 0 and never collides under many inserts at the same spot', () => {
    let prev = FIRST_RANK;
    let next = rankAfter(prev);
    const seen = new Set([prev, next]);
    for (let k = 0; k < 500; k++) {
      const r = rankBetween(prev, next);
      expect(r > prev && r < next).toBe(true);
      expect(r.endsWith('0')).toBe(false);
      expect(seen.has(r)).toBe(false);
      seen.add(r);
      next = r; // keep squeezing into the same gap
    }
  });
  it('appends at the top and bottom', () => {
    expect(rankBefore('n') < 'n').toBe(true);
    expect(rankAfter('zz') > 'zz').toBe(true);
    let r = 'n';
    for (let k = 0; k < 50; k++) { const nr = rankAfter(r); expect(nr > r).toBe(true); r = nr; }
  });
  it('random sequences stay ordered', () => {
    const ranks = [FIRST_RANK];
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let k = 0; k < 300; k++) {
      const pos = Math.floor(rnd() * (ranks.length + 1));
      const r = rankBetween(ranks[pos - 1] ?? '', ranks[pos] ?? '');
      ranks.splice(pos, 0, r);
    }
    for (let k = 1; k < ranks.length; k++) expect(ranks[k - 1]! < ranks[k]!).toBe(true);
  });
});
