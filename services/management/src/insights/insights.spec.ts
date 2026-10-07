import { describe, expect, it } from 'vitest';
import { TimeoutError } from 'rxjs';
import { classify } from './insights.service.js';

describe('insights failure classification', () => {
  it('maps rxjs timeout, Nest no-responder, responder error objects and anything else', () => {
    expect(classify(new TimeoutError())).toBe('timeout');
    expect(classify(new Error('Empty response. There are no subscribers listening to that message.'))).toBe('no_responders');
    expect(classify({ code: 'internal', message: 'insights query failed' })).toBe('responder_error');
    expect(classify(new Error('socket hang up'))).toBe('transport');
  });
});
