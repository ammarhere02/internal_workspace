import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Validates events against the shared JSON Schemas in /contracts, the same files
 * the Python consumer loads. Producer-side validation catches a bad payload
 * before it is ever committed to the outbox.
 */
export type ContractResult =
  | { ok: true }
  | { ok: false; classification: 'malformed' | 'unsupported_schema' | 'unknown_event_type'; errors: string[] };

export const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

export function resolveContractsDir(explicit?: string): string {
  if (explicit) return explicit;
  // Local dev: services/management -> ../../contracts. Docker sets CONTRACTS_DIR.
  return path.resolve(process.cwd(), '..', '..', 'contracts');
}

export class ContractValidator {
  private readonly envelope: ValidateFunction;
  private readonly payloads = new Map<string, ValidateFunction>();

  constructor(contractsDir: string) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv2020) => void)(ajv);
    const schemasDir = path.join(contractsDir, 'schemas');
    const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
    ajv.addSchema(load(path.join(schemasDir, 'events', 'common.schema.json')));
    this.envelope = ajv.compile(load(path.join(schemasDir, 'envelope.schema.json')));
    for (const file of readdirSync(path.join(schemasDir, 'events'))) {
      if (file === 'common.schema.json' || !file.endsWith('.schema.json')) continue;
      const eventType = file.replace('.schema.json', '');
      this.payloads.set(eventType, ajv.compile(load(path.join(schemasDir, 'events', file))));
    }
  }

  validate(event: unknown): ContractResult {
    const e = event as { schemaVersion?: unknown; eventType?: unknown; payload?: unknown } | null;
    if (!e || typeof e !== 'object') return { ok: false, classification: 'malformed', errors: ['event is not an object'] };
    if (typeof e.schemaVersion !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.has(e.schemaVersion)) {
      return { ok: false, classification: 'unsupported_schema', errors: [`schemaVersion ${String(e.schemaVersion)} not supported`] };
    }
    if (!this.envelope(event)) {
      return { ok: false, classification: 'malformed', errors: fmt(this.envelope.errors) };
    }
    const payloadValidator = this.payloads.get(String(e.eventType));
    if (!payloadValidator) return { ok: false, classification: 'unknown_event_type', errors: [`no payload schema for ${String(e.eventType)}`] };
    if (!payloadValidator(e.payload)) return { ok: false, classification: 'malformed', errors: fmt(payloadValidator.errors) };
    return { ok: true };
  }
}

function fmt(errors: ValidateFunction['errors']): string[] {
  return (errors ?? []).map((err) => `${err.instancePath || '/'} ${err.message ?? ''}`.trim());
}
