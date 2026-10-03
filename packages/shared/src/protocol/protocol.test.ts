import { describe, expect, it } from 'vitest';

import { ALICE, CLIENT_MESSAGE_EXAMPLES, SERVER_MESSAGE_EXAMPLES } from '../testing/protocol-examples.js';
import { CLIENT_MESSAGE_TYPES, ClientMessageSchema, parseClientMessage } from './client-messages.js';
import { peekEnvelope } from './envelope.js';
import { SERVER_MESSAGE_TYPES, ServerMessageSchema, parseServerMessage } from './server-messages.js';

const clone = <T>(value: T): T => structuredClone(value);

describe('section 7.4 client examples (strict schemas)', () => {
  it.each(CLIENT_MESSAGE_EXAMPLES.map((example) => [example.type, example] as const))(
    '%s parses strictly',
    (_type, example) => {
      const result = parseClientMessage(clone(example));
      expect(result.ok).toBe(true);
      expect(ClientMessageSchema.parse(clone(example))).toEqual(example);
    },
  );

  it('includes the draft.touch keepalive', () => {
    expect(
      parseClientMessage({ type: 'draft.touch', data: { draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' } })
        .ok,
    ).toBe(true);
  });

  it('rejects an unknown type, an extra key, a missing areaId on commit and a bad ref', () => {
    expect(parseClientMessage({ type: 'draft.explode', ref: 'c-1', data: {} })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_MESSAGE_TYPE',
      ref: 'c-1',
      type: 'draft.explode',
    });
    expect(parseClientMessage({ type: 'ping', data: { t: 1 }, extra: true })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(parseClientMessage({ type: 'ping', data: { t: 1, x: 2 } })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    const commitWithoutArea = {
      type: 'draft.end',
      data: { draftId: ALICE.id, outcome: 'committed', areaId: null },
    };
    expect(parseClientMessage(commitWithoutArea)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(parseClientMessage({ type: 'ping', ref: 'bad ref!', data: { t: 1 } })).toMatchObject({
      ok: false,
      ref: null,
    });
    expect(parseClientMessage('not an object')).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      type: null,
    });
    expect(parseClientMessage({ data: {} })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('range-checks draft vertices and viewports (topology is not validated)', () => {
    const update = {
      type: 'draft.update',
      data: { draftId: ALICE.id, rev: 1, vertices: [[181, 0]], cursor: null },
    };
    expect(parseClientMessage(update).ok).toBe(false);
    const inverted = { type: 'viewport.set', data: { bbox: [35, 32, 34, 33], zoom: 10 } };
    expect(parseClientMessage(inverted).ok).toBe(false);
    const selfCrossing = {
      type: 'draft.update',
      data: {
        draftId: ALICE.id,
        rev: 2,
        vertices: [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ],
        cursor: [0.5, 0.5],
      },
    };
    expect(parseClientMessage(selfCrossing).ok).toBe(true);
  });
});

describe('section 7.5 server examples (loose schemas)', () => {
  it.each(SERVER_MESSAGE_EXAMPLES.map((example, index) => [`${index}:${example.type}`, example] as const))(
    '%s parses loosely',
    (_label, example) => {
      const result = parseServerMessage(clone(example));
      expect(result.kind === 'message' || result.kind === 'batch').toBe(true);
      expect(ServerMessageSchema.safeParse(clone(example)).success).toBe(true);
    },
  );

  it('types welcome.serverTime and pong.serverTime as epoch-ms numbers', () => {
    for (const type of ['welcome', 'pong'] as const) {
      const example = SERVER_MESSAGE_EXAMPLES.find((candidate) => candidate.type === type);
      const result = parseServerMessage(clone(example));
      if (result.kind !== 'message') throw new Error(`${type} did not parse`);
      const data = result.message.data as { serverTime: unknown };
      expect(typeof data.serverTime).toBe('number');
    }
    const stringTime = { type: 'pong', data: { t: 1, serverTime: '2026-09-27T10:00:00.000Z' } };
    expect(parseServerMessage(stringTime).kind).toBe('invalid');
  });

  it('tolerates and preserves unknown fields; unknown types yield { kind: "unknown" }', () => {
    const extended = {
      type: 'ack',
      ref: 'c-1',
      data: { drawActionsRemaining: 3, futureField: 'x' },
      meta: 1,
    };
    const result = parseServerMessage(extended);
    expect(result).toEqual({ kind: 'message', message: extended });
    expect(parseServerMessage({ type: 'area.exploded', data: {} })).toEqual({
      kind: 'unknown',
      type: 'area.exploded',
    });
    expect(parseServerMessage({ data: {} })).toMatchObject({ kind: 'invalid', type: null });
    expect(parseServerMessage({ type: 'ack', data: { drawActionsRemaining: 'many' } })).toMatchObject({
      kind: 'invalid',
      type: 'ack',
    });
  });

  it('parses batch members one by one, so an unknown inner type does not drop the batch', () => {
    const batch = {
      type: 'batch',
      data: {
        messages: [
          { type: 'pong', data: { t: 1, serverTime: 2 } },
          { type: 'future.event', data: {} },
        ],
      },
    };
    const result = parseServerMessage(batch);
    if (result.kind !== 'batch') throw new Error('expected a batch');
    expect(result.results.map((inner) => inner.kind)).toEqual(['message', 'unknown']);
  });
});

describe('envelope helpers and message type lists', () => {
  it('peeks type and ref without validating the rest', () => {
    expect(peekEnvelope({ type: 'ping', ref: 'c-2' })).toEqual({ type: 'ping', ref: 'c-2' });
    expect(peekEnvelope(null)).toEqual({ type: null, ref: null });
    expect(peekEnvelope({ type: 1 })).toEqual({ type: null, ref: null });
  });

  it('derives the message type lists from the union schemas (every type has a SPEC example)', () => {
    expect(CLIENT_MESSAGE_TYPES).toEqual(CLIENT_MESSAGE_EXAMPLES.map((example) => example.type));
    expect(new Set(SERVER_MESSAGE_TYPES)).toEqual(
      new Set(SERVER_MESSAGE_EXAMPLES.map((example) => example.type)),
    );
  });
});
