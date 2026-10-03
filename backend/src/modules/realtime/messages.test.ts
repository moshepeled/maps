import { parseServerMessage } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { ackMessage, criticalMessage, ephemeralKey, ephemeralMessage, errorMessage } from './messages.js';

describe('server message construction (section 7.5, section 7.8)', () => {
  it('serialises once, with the ref only when given, and records the UTF-8 size', () => {
    const withRef = ackMessage('c-7', { drawActionsRemaining: 49 });
    expect(JSON.parse(withRef.json)).toEqual({ type: 'ack', ref: 'c-7', data: { drawActionsRemaining: 49 } });
    expect(withRef.lane).toBe('critical');
    const hebrew = criticalMessage('error', { code: 'LOCK_HELD', message: 'אליס עורכת' });
    expect(hebrew.bytes).toBe(Buffer.byteLength(hebrew.json, 'utf8'));
    expect(hebrew.bytes).toBeGreaterThan(hebrew.json.length);
    expect(JSON.parse(hebrew.json)).not.toHaveProperty('ref');
  });

  it('builds error messages that the loose shared schema accepts', () => {
    const message = errorMessage('RATE_LIMITED', 'Drawing action limit reached.', {
      ref: 'c-1',
      retryAfterMs: 8420.2,
      details: { limit: 50 },
    });
    const parsed = parseServerMessage(JSON.parse(message.json));
    expect(parsed.kind).toBe('message');
    expect(JSON.parse(message.json)).toEqual({
      type: 'error',
      ref: 'c-1',
      data: {
        code: 'RATE_LIMITED',
        message: 'Drawing action limit reached.',
        retryAfterMs: 8421,
        details: { limit: 50 },
      },
    });
  });

  it('puts ephemeral messages on the keyed lane and critical ones may supersede a key', () => {
    const left = ephemeralMessage(
      'presence.left',
      {
        connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
        userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
      },
      ephemeralKey.presence('b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d'),
    );
    expect(left.lane).toBe('ephemeral');
    expect(left.key).toBe('presence:b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d');
    const ended = criticalMessage(
      'draft.ended',
      {
        draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
        userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
        outcome: 'expired',
        areaId: null,
      },
      { supersedes: ephemeralKey.draft('4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d') },
    );
    expect(ended.supersedes).toBe('draft:4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');
    expect(ephemeralKey.lock('x')).toBe('lock:x');
    expect(parseServerMessage(JSON.parse(ended.json)).kind).toBe('message');
  });
});
