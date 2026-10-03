/**
 * This tab's own area writes (UX C-14, C-20, F-09 step 1). A change event whose actor is me is either the echo of a
 * write this tab made, or a change I made in another tab or on another device. Only the echo may be ignored: the rest
 * must refresh this tab like anyone else's change. Change events carry no session id (SPEC section 7), so the tab remembers
 * which areas it is writing and the versions its writes produced.
 */
import type { AreaDto, AreaMutationResponse } from '@snapland/shared';

import type { AreasApi } from '../api/areas';
import { isApiError } from '../api/http';

/** A write the server refused with a 4xx was not applied; after any other failure it may have been. */
function answeredWithoutApplying(error: unknown): boolean {
  return isApiError(error) && error.kind === 'http' && error.status < 500;
}

export class OwnWrites {
  /** Writes in flight per area: their echo may arrive before the response. */
  private readonly pending = new Map<string, number>();
  /** Areas whose last write failed without an answer (it may have been applied): until the next write settles. */
  private readonly uncertain = new Set<string>();
  /** The newest version each area reached through this tab's writes. */
  private readonly produced = new Map<string, number>();

  /** Whether `area`, from a change event whose actor is me, is what one of this tab's writes produced. */
  isEcho(area: Pick<AreaDto, 'id' | 'version'>): boolean {
    return (
      (this.pending.get(area.id) ?? 0) > 0 ||
      this.uncertain.has(area.id) ||
      (this.produced.get(area.id) ?? 0) >= area.version
    );
  }

  /** `api` with its four writes recorded; reads pass through. */
  wrap(api: AreasApi): AreasApi {
    return {
      ...api,
      create: (body) => this.track(body.id ?? null, () => api.create(body)),
      update: (id, body) => this.track(id, () => api.update(id, body)),
      remove: (id, baseVersion) => this.track(id, () => api.remove(id, baseVersion)),
      restore: (id, baseVersion) => this.track(id, () => api.restore(id, baseVersion)),
    };
  }

  private async track(
    areaId: string | null,
    write: () => Promise<AreaMutationResponse>,
  ): Promise<AreaMutationResponse> {
    if (areaId !== null) this.pending.set(areaId, (this.pending.get(areaId) ?? 0) + 1);
    try {
      const response = await write();
      const { id, version } = response.area;
      this.produced.set(id, Math.max(version, this.produced.get(id) ?? 0));
      this.uncertain.delete(id);
      return response;
    } catch (error) {
      if (areaId !== null) {
        if (answeredWithoutApplying(error)) this.uncertain.delete(areaId);
        else this.uncertain.add(areaId);
      }
      throw error;
    } finally {
      if (areaId !== null) {
        const left = (this.pending.get(areaId) ?? 1) - 1;
        if (left > 0) this.pending.set(areaId, left);
        else this.pending.delete(areaId);
      }
    }
  }
}
