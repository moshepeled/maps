import { describe, expect, it } from 'vitest';

import { derivePresenceStatus } from './presence-status.js';

const DRAFT = 'd0000000-0000-4000-8000-000000000001';
const AREA = 'a0000000-0000-4000-8000-000000000001';
const LOCK_1 = 'a0000000-0000-4000-8000-000000000002';
const LOCK_2 = 'a0000000-0000-4000-8000-000000000003';

describe('derivePresenceStatus (section 7.7 v1.2 precedence)', () => {
  it('an edit draft (areaId set) -> editing that area', () => {
    expect(
      derivePresenceStatus({
        reported: 'viewing',
        draft: { draftId: DRAFT, areaId: AREA },
        lockedAreaIds: [],
      }),
    ).toEqual({ status: 'editing', activeAreaId: AREA });
  });

  it('a lock and an edit draft -> editing the draft area (UX-AC-87)', () => {
    expect(
      derivePresenceStatus({
        reported: 'idle',
        draft: { draftId: DRAFT, areaId: AREA },
        lockedAreaIds: [LOCK_1],
      }),
    ).toEqual({ status: 'editing', activeAreaId: AREA });
  });

  it('only locks -> editing the most recently acquired lock', () => {
    expect(
      derivePresenceStatus({ reported: 'viewing', draft: null, lockedAreaIds: [LOCK_1, LOCK_2] }),
    ).toEqual({ status: 'editing', activeAreaId: LOCK_2 });
  });

  it('a lock beats a new-area draft (editing wins over drawing)', () => {
    expect(
      derivePresenceStatus({
        reported: 'viewing',
        draft: { draftId: DRAFT, areaId: null },
        lockedAreaIds: [LOCK_1],
      }),
    ).toEqual({ status: 'editing', activeAreaId: LOCK_1 });
  });

  it('a new-area draft -> drawing with activeAreaId = draft id', () => {
    expect(
      derivePresenceStatus({ reported: 'idle', draft: { draftId: DRAFT, areaId: null }, lockedAreaIds: [] }),
    ).toEqual({ status: 'drawing', activeAreaId: DRAFT });
  });

  it('otherwise the client-reported status', () => {
    expect(derivePresenceStatus({ reported: 'viewing', draft: null, lockedAreaIds: [] })).toEqual({
      status: 'viewing',
      activeAreaId: null,
    });
    expect(derivePresenceStatus({ reported: 'idle', draft: null, lockedAreaIds: [] })).toEqual({
      status: 'idle',
      activeAreaId: null,
    });
  });
});
