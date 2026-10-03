/**
 * The three screen-reader live regions (UX section 6.6), mounted once for the whole app: `status` (polite), `collab` (log)
 * and `alert` (assertive). Each announcement replaces the region's child node (keyed by its sequence number), so an
 * identical text is announced again when the store allows it.
 */
import { useStore } from 'zustand';

import type { LiveRegionStoreApi } from '../state/liveRegionStore';

export function LiveRegions({ live }: { live: LiveRegionStoreApi }) {
  const status = useStore(live, (state) => state.status);
  const collab = useStore(live, (state) => state.collab);
  const alert = useStore(live, (state) => state.alert);
  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" data-testid="live-status">
        <span key={status.seq}>{status.text}</span>
      </div>
      <div role="log" aria-live="polite" aria-relevant="additions" data-testid="live-collab">
        <span key={collab.seq}>{collab.text}</span>
      </div>
      <div role="alert" aria-live="assertive" data-testid="live-alert">
        <span key={alert.seq}>{alert.text}</span>
      </div>
    </div>
  );
}
