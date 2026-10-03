/**
 * Test-only: the protocol examples of SPEC section 7.4 (client -> server) and section 7.5 (server -> client), verbatim. Tests import
 * them from `@snapland/shared/testing`; they are not part of the runtime API (excluded from the build and coverage).
 * `protocol.test.ts` parses every one (client ones strictly, server ones loosely), so the SPEC examples can never drift
 * from the schemas. Actors: Alice (#c44f9d, plum) and Bob (#b86e3d, copper), both USER_PALETTE colours.
 */

export const ALICE = {
  id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
  displayName: 'Alice',
  color: '#c44f9d',
} as const;
export const BOB = {
  id: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
  displayName: 'Bob',
  color: '#b86e3d',
} as const;

export const CLIENT_MESSAGE_EXAMPLES = [
  { type: 'viewport.set', ref: 'c-1', data: { bbox: [34.7612, 32.0655, 34.8021, 32.0998], zoom: 15 } },
  { type: 'presence.update', data: { status: 'viewing' } },
  {
    type: 'draft.start',
    ref: 'c-7',
    data: { draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', areaId: null, resume: false },
  },
  {
    type: 'draft.update',
    data: {
      draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      rev: 12,
      vertices: [
        [34.781201, 32.081102],
        [34.785133, 32.081344],
        [34.784977, 32.084621],
      ],
      cursor: [34.781502, 32.084955],
    },
  },
  { type: 'draft.touch', data: { draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' } },
  {
    type: 'draft.end',
    ref: 'c-9',
    data: {
      draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      outcome: 'committed',
      areaId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    },
  },
  {
    type: 'lock.acquire',
    ref: 'c-10',
    data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d', scope: 'geometry' },
  },
  { type: 'lock.release', ref: 'c-11', data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d' } },
  { type: 'ping', data: { t: 1790000000000 } },
] as const;

export const SERVER_MESSAGE_EXAMPLES = [
  {
    type: 'welcome',
    data: {
      connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
      instanceId: 'backend-2',
      user: { id: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b', displayName: 'Bob', color: '#b86e3d' },
      serverTime: 1790000000000,
      latestChangeSeq: 1043,
      heartbeatIntervalMs: 20000,
      limits: {
        maxPayloadBytes: 65536,
        drawActionsPerWindow: 50,
        drawWindowMs: 60000,
        draftUpdateMinIntervalMs: 100,
        draftTouchIntervalMs: 20000,
        maxPositions: 2000,
      },
    },
  },
  { type: 'ack', ref: 'c-7', data: { drawActionsRemaining: 49 } },
  {
    type: 'error',
    ref: 'c-7',
    data: {
      code: 'RATE_LIMITED',
      message: 'Drawing action limit reached (50 per 60 s).',
      retryAfterMs: 8421,
    },
  },
  {
    type: 'error',
    data: {
      code: 'DRAFT_NOT_FOUND',
      message: 'Draft 4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d is not active on this connection.',
    },
  },
  { type: 'pong', data: { t: 1790000000000, serverTime: 1790000000012 } },
  {
    type: 'presence.snapshot',
    data: {
      items: [
        {
          connectionId: 'c4d3b2a1-2222-4b3c-8d4e-5f6a7b8c9d0e',
          userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
          displayName: 'Alice',
          color: '#c44f9d',
          status: 'viewing',
          activeAreaId: null,
          viewport: { bbox: [34.7612, 32.0655, 34.8021, 32.0998], zoom: 15 },
          connectedAt: '2026-09-27T09:58:00.000Z',
          updatedAt: '2026-09-27T09:59:40.000Z',
        },
      ],
      onlineCount: 1,
      truncated: false,
    },
  },
  {
    type: 'lock.snapshot',
    data: {
      items: [
        {
          areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
          holder: { userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' },
          scope: 'geometry',
          expiresAt: '2026-09-27T10:00:30.000Z',
        },
      ],
    },
  },
  {
    type: 'presence.joined',
    data: {
      presence: {
        connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
        userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
        displayName: 'Bob',
        color: '#b86e3d',
        status: 'viewing',
        activeAreaId: null,
        viewport: null,
        connectedAt: '2026-09-27T10:00:00.000Z',
        updatedAt: '2026-09-27T10:00:00.000Z',
      },
    },
  },
  {
    type: 'presence.updated',
    data: {
      presence: {
        connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
        userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
        displayName: 'Bob',
        color: '#b86e3d',
        status: 'drawing',
        activeAreaId: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0',
        viewport: { bbox: [34.7612, 32.0655, 34.8021, 32.0998], zoom: 15 },
        connectedAt: '2026-09-27T10:00:00.000Z',
        updatedAt: '2026-09-27T10:00:05.000Z',
      },
    },
  },
  {
    type: 'presence.left',
    data: {
      connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
      userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
    },
  },
  {
    type: 'draft.updated',
    data: {
      draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      user: { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' },
      areaId: null,
      rev: 12,
      vertices: [
        [34.781201, 32.081102],
        [34.785133, 32.081344],
        [34.784977, 32.084621],
      ],
      cursor: [34.781502, 32.084955],
    },
  },
  {
    type: 'area.changed',
    data: {
      changeSeq: 1044,
      op: 'update',
      area: {
        id: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
        name: 'Rabin Square',
        description: null,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [34.78, 32.08],
              [34.792, 32.08],
              [34.792, 32.09],
              [34.78, 32.09],
              [34.78, 32.08],
            ],
          ],
        },
        areaKm2: 1.2562206688394546,
        perimeterKm: 4.483506686395568,
        vertexCount: 4,
        bbox: [34.78, 32.08, 34.792, 32.09],
        version: 5,
        changeSeq: 1044,
        createdBy: { id: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b', displayName: 'Bob', color: '#b86e3d' },
        updatedBy: { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' },
        createdAt: '2026-09-27T09:00:00.000Z',
        updatedAt: '2026-09-27T10:00:07.000Z',
        deletedAt: null,
        deletedBy: null,
      },
      changedFields: ['geometry'],
      merged: true,
      previousName: null,
      actor: { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' },
    },
  },
  {
    type: 'draft.ended',
    data: {
      draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
      outcome: 'committed',
      areaId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    },
  },
  {
    type: 'lock.acquired',
    ref: 'c-10',
    data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d', expiresAt: '2026-09-27T10:00:30.000Z' },
  },
  {
    type: 'lock.changed',
    data: {
      areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
      holder: { userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' },
      scope: 'geometry',
      expiresAt: '2026-09-27T10:00:30.000Z',
    },
  },
  { type: 'resync.required', data: { reason: 'bus_reconnected', latestChangeSeq: 1050 } },
  {
    type: 'batch',
    data: {
      messages: [
        {
          type: 'draft.updated',
          data: {
            draftId: '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
            user: { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' },
            areaId: null,
            rev: 13,
            vertices: [
              [34.781201, 32.081102],
              [34.785133, 32.081344],
              [34.784977, 32.084621],
              [34.782011, 32.085102],
            ],
            cursor: null,
          },
        },
        {
          type: 'presence.left',
          data: {
            connectionId: 'b3c2a1d0-1111-4a2b-9c3d-4e5f6a7b8c9d',
            userId: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
          },
        },
      ],
    },
  },
] as const;
