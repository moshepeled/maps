/**
 * Moves keyboard focus when a flow asks for it (UX section 8.3): flows only record *what* should receive focus
 * (`workspace.requestFocus(target, key)`); the component that renders that element performs the focus once it exists.
 * A request with a key focuses the element registered with the same key; a request without a key focuses the
 * element registered without one.
 */
import type { RefObject } from 'react';
import { useEffect } from 'react';
import { useStore } from 'zustand';

import { useWorkspace } from '../app/AppContext';
import type { FocusTarget } from '../state/workspaceStore';

export function useFocusTarget(
  target: FocusTarget,
  ref: RefObject<HTMLElement | null>,
  key?: string | number,
): void {
  const workspace = useWorkspace();
  const request = useStore(workspace.ctx.stores.workspace, (state) => state.focusRequest);
  useEffect(() => {
    if (request?.target !== target || request.key !== key) return;
    ref.current?.focus();
  }, [request, target, ref, key]);
}
