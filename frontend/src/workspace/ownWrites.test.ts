/** Telling this tab's own echoes apart from my changes made in another tab or on another device (UX C-14, C-20). */
import type { AreaMutationResponse } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import type { AreasApi } from '../api/areas';
import { ApiError } from '../api/http';
import { areaDto, uuid } from '../test/factories';
import { OwnWrites } from './ownWrites';

const ID = uuid(0x51);

function response(version: number): AreaMutationResponse {
  return { area: { ...areaDto({ id: ID }), version }, merged: false, noop: false, serverChangedFields: [] };
}

/** An API whose `update` answers only when the test says so. */
function controlledApi() {
  let settle: { resolve(value: AreaMutationResponse): void; reject(error: unknown): void } | null = null;
  const api = {
    update: () =>
      new Promise<AreaMutationResponse>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  } as Partial<AreasApi> as AreasApi;
  return {
    api,
    answer: (value: AreaMutationResponse) => settle?.resolve(value),
    fail: (error: unknown) => settle?.reject(error),
  };
}

describe('OwnWrites', () => {
  it('an echo that arrives before the response, and the version the write produced, are this tab’s own', async () => {
    const own = new OwnWrites();
    const { api, answer } = controlledApi();
    const write = own.wrap(api).update(ID, { baseVersion: 2, name: 'Renamed' });
    expect(own.isEcho({ id: ID, version: 3 })).toBe(true);
    answer(response(3));
    await write;
    expect(own.isEcho({ id: ID, version: 3 })).toBe(true);
    // The same user saving v4 from another tab is not an echo.
    expect(own.isEcho({ id: ID, version: 4 })).toBe(false);
    expect(own.isEcho({ id: uuid(0x52), version: 1 })).toBe(false);
  });

  it('a refused write produced nothing; a write that got no answer may have been applied', async () => {
    const own = new OwnWrites();
    const refused = controlledApi();
    const first = own.wrap(refused.api).update(ID, { baseVersion: 2, name: 'x' });
    refused.fail(new ApiError('http', 409, 'VERSION_CONFLICT', null, null, 'conflict'));
    await expect(first).rejects.toThrow();
    expect(own.isEcho({ id: ID, version: 3 })).toBe(false);
    const lost = controlledApi();
    const second = own.wrap(lost.api).update(ID, { baseVersion: 2, name: 'x' });
    lost.fail(new ApiError('network', 0, 'network', null, null, 'offline'));
    await expect(second).rejects.toThrow();
    expect(own.isEcho({ id: ID, version: 3 })).toBe(true);
  });
});
