/**
 * The map workspace in the Studio frame (user decision D-4; UX section 3.2, section 3.6, section 8.2; UI.md section 4, section 11). CSS grid places the
 * regions; the DOM keeps the UX section 8.2 tab order: skip link -> title bar -> tool rail (phones: bottom bar) -> map ->
 * options bar / phone HUD -> notice -> inspector (phones: sheet) -> map controls -> attribution -> toasts; the status bar
 * has no tab stops. `WorkspaceRoot` owns the per-user `Workspace` (created on sign-in, disposed on sign-out or user
 * switch).
 */
import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';

import { useLayout, useServices, useWorkspace, WorkspaceProvider } from '../app/AppContext';
import {
  DeletedWhileEditingDialog,
  SessionExpiredDialog,
  ShortcutsDialog,
  SignOutConfirmDialog,
} from '../components/Dialogs';
import { BottomBar, bottomBarShown } from '../components/frame/BottomBar';
import { OptionsBar, PhoneHud, phoneHudShown } from '../components/frame/OptionsBar';
import { StatusBar } from '../components/frame/StatusBar';
import { TitleBar } from '../components/frame/TitleBar';
import { ToolRail } from '../components/frame/ToolRail';
import { AreaSheet } from '../components/inspector/AreaSheet';
import { Inspector } from '../components/inspector/Inspector';
import { LiveRegions } from '../components/LiveRegions';
import { Attribution, MapControls } from '../components/MapChrome';
import { NoticeSlot, ProgressBar } from '../components/NoticeSlot';
import { Toasts } from '../components/Toasts';
import { config, E2E_HOOKS_BUILD } from '../config';
import { base } from '../base/en';
import { MapView } from '../map/MapView';
import type { WorkspaceLayout as Layout } from '../state/workspaceStore';
import { inspectorOpen } from '../state/workspaceStore';
import { installE2eHook } from './e2eHook';
import { browserEnv, Workspace } from './Workspace';

function useGlobalKeys(workspace: Workspace): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (workspace.handleGlobalKey(event)) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [workspace]);
}

function px(value: number): string {
  return `${Math.max(0, Math.round(value))}px`;
}

/**
 * Writes the runtime layout properties on the app root (UI.md section 4.4): what covers the map from inside its box - the
 * overlay inspector, the phone sheet, the attribution. Toasts, map controls and the map's own fits and pans read
 * them, so nothing important ends up underneath.
 */
function useMapInsets(root: RefObject<HTMLDivElement | null>, layoutKey: string): void {
  useLayoutEffect(() => {
    const app = root.current;
    if (app === null) return undefined;
    const measure = (): void => {
      const frame = app.querySelector<HTMLElement>('.map-frame')?.getBoundingClientRect();
      const attribution = app.querySelector<HTMLElement>('[data-testid="attribution"]');
      const overlay = app.querySelector<HTMLElement>(
        '[data-testid="inspector"][data-layout="overlay"][data-open="true"]',
      );
      const sheet = app.querySelector<HTMLElement>('[data-testid="area-sheet"]');
      app.style.setProperty('--map-attribution-h', px(attribution?.offsetHeight ?? 0));
      // The overlay floats 10 px inside the map's right edge: keep that gap clear too (UI.md section 10.8.8). Measured from
      // its layout box, not its screen box: while it slides in, its transform would shrink the inset (fix round 3).
      app.style.setProperty(
        '--map-inset-right',
        frame !== undefined && overlay !== null
          ? px(overlay.offsetWidth + (Number.parseFloat(getComputedStyle(overlay).marginRight) || 0) + 10)
          : '0px',
      );
      app.style.setProperty(
        '--map-inset-bottom',
        frame !== undefined && sheet !== null ? px(frame.bottom - sheet.getBoundingClientRect().top) : '0px',
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(app);
    for (const selector of [
      '[data-testid="attribution"]',
      '[data-testid="inspector"]',
      '[data-testid="area-sheet"]',
    ]) {
      const element = app.querySelector(selector);
      if (element !== null) observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
    // `layoutKey` changes whenever the measured elements may appear, disappear or move.
  }, [root, layoutKey]);
}

function WorkspaceLayout() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const layout: Layout = useLayout();
  const mode = useStore(stores.workspace, (state) => state.mode);
  const panel = useStore(stores.workspace, (state) => state.panel);
  const sheet = useStore(stores.workspace, (state) => state.sheet);
  const extras = useStore(stores.workspace, (state) => state.inspectorExtras);
  const editing = useStore(stores.edit, (state) => state.edit !== null);
  const root = useRef<HTMLDivElement>(null);
  useGlobalKeys(workspace);
  // Flows read the layout from the store (People, History defaults, Esc); components read the media queries.
  useLayoutEffect(() => {
    stores.workspace.getState().patch({ layout });
  }, [layout, stores]);
  useMapInsets(root, `${layout}|${mode}|${panel}|${sheet}|${String(extras)}|${String(editing)}`);
  const phone = layout === 'phone';
  return (
    <>
      <a className="skip-link" href="#map">
        {base.a11y.skipToMap}
      </a>
      <div
        ref={root}
        className="app"
        data-layout={layout}
        data-mode={mode}
        data-inspector-open={inspectorOpen({ layout, mode, panel, inspectorExtras: extras })}
        data-phone-hud={phone && phoneHudShown(mode, editing)}
        data-bottom-bar={phone && bottomBarShown(mode, editing)}
      >
        <TitleBar />
        {phone ? <BottomBar /> : <ToolRail />}
        <main className="stage" aria-label={base.a11y.workspace}>
          <div className="map-frame">
            <MapView />
            <ProgressBar />
          </div>
          {phone ? <PhoneHud /> : <OptionsBar />}
          <div className="notice-slot">
            <NoticeSlot />
          </div>
        </main>
        {phone ? <AreaSheet /> : <Inspector />}
        <MapControls />
        <Attribution />
        <Toasts />
        {phone ? null : <StatusBar />}
      </div>
      <DeletedWhileEditingDialog />
      <SignOutConfirmDialog />
      <ShortcutsDialog />
    </>
  );
}

export function WorkspaceRoot() {
  const services = useServices();
  const userId = useStore(services.stores.auth, (state) => state.user?.id ?? null);
  // A new workspace per signed-in user: another user never sees the previous user's drafts or state (UX F-11).
  const workspace = useMemo(
    () =>
      new Workspace(
        services,
        browserEnv({
          itmLayerEnabled: config.enableItmLayer,
          appVersion: userId === null ? 'snapland-web' : 'snapland-web@1.0.0',
        }),
      ),
    [services, userId],
  );
  // A layout effect, not a passive one: start() restores the saved view and base layer into the stores, and the map
  // (MapView, a child) is created in a passive effect from those stores. Every layout effect runs before any passive
  // effect, so the map is born at the saved view - in production too, where StrictMode's second mount does not hide
  // the ordering (child effects run before their parent's).
  useLayoutEffect(() => {
    workspace.start();
    const uninstall = E2E_HOOKS_BUILD && config.e2eHooks ? installE2eHook(workspace) : null;
    return () => {
      uninstall?.();
      workspace.dispose();
    };
  }, [workspace]);
  return (
    <WorkspaceProvider workspace={workspace}>
      <WorkspaceLayout />
      <SessionExpiredDialog
        onSignedIn={() => {
          workspace.onSignedInAgain();
        }}
        onSignOut={() => {
          // UX F-11 step 5: through C-22, which asks first when there is unsaved work.
          workspace.requestSignOut();
        }}
      />
      <LiveRegions live={services.stores.live} />
    </WorkspaceProvider>
  );
}
