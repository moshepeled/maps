/**
 * React access to the services and the per-user workspace. Components read store slices through `useStore` with
 * narrow selectors (primitives or stable references) and call workspace commands from event handlers only.
 */
import type { ReactNode } from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { WorkspaceLayout } from '../state/workspaceStore';
import type { Workspace } from '../workspace/Workspace';
import type { AppServices } from './services';

const ServicesContext = createContext<AppServices | null>(null);
const WorkspaceContext = createContext<Workspace | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

export function WorkspaceProvider({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  return <WorkspaceContext value={workspace}>{children}</WorkspaceContext>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error('useServices() outside <ServicesProvider>');
  return services;
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (workspace === null) throw new Error('useWorkspace() outside <WorkspaceProvider>');
  return workspace;
}

/** `true` while `query` matches (layout decisions that CSS alone cannot make, e.g. short copy). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = globalThis.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    () => globalThis.matchMedia(query).matches,
    () => false,
  );
}

/** Below 600 px: phone rules (short copy, one-line HUD strip, UX section 3.2). */
export function usePhone(): boolean {
  return useMediaQuery('(max-width: 599.98px)');
}

/**
 * The Studio frame's layout (UX section 3.2; SPEC section 8.6 breakpoints 600 / 1,200): `docked` inspector from 1,200 px, an
 * `overlay` inspector from 600 px, and the `phone` frame (bottom bar, sheet, docked HUD) below 600 px.
 */
export function useLayout(): WorkspaceLayout {
  const phone = useMediaQuery('(max-width: 599.98px)');
  const docked = useMediaQuery('(min-width: 1200px)');
  if (phone) return 'phone';
  return docked ? 'docked' : 'overlay';
}

/** A fine pointer (mouse, trackpad) is available: key hints are shown only then (UX C-05, C-29). */
export function useFinePointer(): boolean {
  return useMediaQuery('(any-pointer: fine)');
}

export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}
