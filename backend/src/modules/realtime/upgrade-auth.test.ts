import { describe, expect, it } from 'vitest';

import { offeredSubprotocols } from './upgrade-auth.js';

describe('offeredSubprotocols (Sec-WebSocket-Protocol parsing, section 7.1)', () => {
  it('splits and trims a comma-separated header, ignoring empty entries', () => {
    expect(offeredSubprotocols('snapland.v1')).toEqual(['snapland.v1']);
    expect(offeredSubprotocols(' other.v2 ,snapland.v1 ')).toEqual(['other.v2', 'snapland.v1']);
    expect(offeredSubprotocols('a, ,b')).toEqual(['a', 'b']);
  });

  it('is empty without a header', () => {
    expect(offeredSubprotocols(undefined)).toEqual([]);
    expect(offeredSubprotocols('')).toEqual([]);
  });
});
