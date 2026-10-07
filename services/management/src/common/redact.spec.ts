import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets (PDF §13 secret leakage)', () => {
  it('strips the password from Atlas and NATS URLs wherever they appear in a message', () => {
    expect(redactSecrets('MongoServerError: bad auth mongodb+srv://mgmt_user:Sup3r%24ecret@cluster0.x.mongodb.net/?w=majority'))
      .toBe('MongoServerError: bad auth mongodb+srv://mgmt_user:[redacted]@cluster0.x.mongodb.net/?w=majority');
    expect(redactSecrets('connect nats://svc:tok3n@nats:4222 failed')).toBe('connect nats://svc:[redacted]@nats:4222 failed');
  });
  it('leaves credential-free text untouched', () => {
    expect(redactSecrets('nats://localhost:4222 unreachable')).toBe('nats://localhost:4222 unreachable');
  });
});
