import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContractValidator, resolveContractsDir } from './validator.js';

const dir = resolveContractsDir(process.env.CONTRACTS_DIR);
const validator = new ContractValidator(dir);
const fixtures = (sub: string) =>
  readdirSync(path.join(dir, 'examples', sub)).map((f) => [f, JSON.parse(readFileSync(path.join(dir, 'examples', sub, f), 'utf8'))] as const);

describe('shared contracts (TypeScript side)', () => {
  it.each(fixtures('valid'))('accepts %s', (_name, event) => {
    expect(validator.validate(event)).toEqual({ ok: true });
  });

  it('rejects an unsupported schema version as non-retryable', () => {
    const [, event] = fixtures('invalid').find(([n]) => n === 'unsupported-schema-version.json')!;
    const r = validator.validate(event);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.classification).toBe('unsupported_schema');
  });

  it('rejects a payload missing required fields', () => {
    const [, event] = fixtures('invalid').find(([n]) => n === 'missing-payload-field.json')!;
    const r = validator.validate(event);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.classification).toBe('malformed');
  });

  it('rejects something that is not an envelope at all', () => {
    const r = validator.validate({ hello: 'world' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.classification).toBe('unsupported_schema');
  });
});
