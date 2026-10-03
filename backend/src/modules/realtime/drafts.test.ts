import { describe, expect, it } from 'vitest';

import { toFrame } from './drafts.js';

const DRAFT_ID = '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

describe('toFrame (section 7.6: 6 dp re-quantisation, bbox of vertices + cursor)', () => {
  it('quantises every position to 6 decimals and includes the cursor in the bbox', () => {
    const frame = toFrame({
      draftId: DRAFT_ID,
      rev: 3,
      vertices: [
        [34.781_201_49, 32.081_102_51],
        [34.785_133_4, 32.081_344],
      ],
      cursor: [34.790_000_4, 32.070_000_6],
    });
    expect(frame.rev).toBe(3);
    expect(frame.vertices).toEqual([
      [34.781_201, 32.081_103],
      [34.785_133, 32.081_344],
    ]);
    expect(frame.cursor).toEqual([34.79, 32.070_001]);
    expect(frame.bbox).toEqual([34.781_201, 32.070_001, 34.79, 32.081_344]);
  });

  it('has no bbox while the draft has neither vertices nor a cursor', () => {
    expect(toFrame({ draftId: DRAFT_ID, rev: 1, vertices: [], cursor: null })).toEqual({
      rev: 1,
      vertices: [],
      cursor: null,
      bbox: null,
    });
  });
});
