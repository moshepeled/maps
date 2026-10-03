/**
 * The map host (SPEC section 8.6 `MapView.tsx`, UX C-04): the focusable `map` element that stacks the Leaflet maps, the
 * keyboard reticle, and the mode instructions for screen readers. The imperative work is `MapController`'s; this
 * component only mounts it for the lifetime of the workspace.
 *
 * `data-base-layer` sits on `map` (UX section 12) and is mirrored onto the wrapper, which draws the map well, the map focus
 * frame and the reticle: the map-tone tokens resolve from that attribute (UI.md section 2.5, section 14.3).
 */
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';

import { useServices, useWorkspace } from '../app/AppContext';
import { useFocusTarget } from '../components/useFocusTarget';
import { base } from '../base/en';
import { systemScheduler } from '../lib/scheduler';
import { browserFrames, prefersReducedMotion } from './crossfade';
import { MapController } from './MapController';

/** The keyboard reticle (C-06.9, UI.md section 9.9): a ring, four arms and a centre dot, each on its casing. */
function Reticle() {
  const arms = 'M28 3v14M28 39v14M3 28h14M39 28h14';
  return (
    <svg className="reticle" viewBox="0 0 56 56" aria-hidden="true">
      <circle className="reticle__ring-casing" cx="28" cy="28" r="15" />
      <path className="reticle__arms-casing" d={arms} />
      <circle className="reticle__ring" cx="28" cy="28" r="15" />
      <path className="reticle__arms" d={arms} />
      <circle className="reticle__dot" cx="28" cy="28" r="2.5" />
    </svg>
  );
}

export function MapView() {
  const services = useServices();
  const workspace = useWorkspace();
  const host = useRef<HTMLDivElement>(null);
  const mode = useStore(workspace.ctx.stores.workspace, (state) => state.mode);
  const baseLayer = useStore(workspace.ctx.stores.mapView, (state) => state.displayedBaseLayer);
  const editName = useStore(workspace.ctx.stores.edit, (state) => state.edit?.name ?? null);
  // "Focus goes to the map" (after a delete, a closed panel, a used toast; UX section 8.3) lands on this element.
  useFocusTarget('map', host);

  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    const controller = new MapController({
      host: element,
      workspace,
      services,
      scheduler: systemScheduler,
      frames: browserFrames,
      reducedMotion: prefersReducedMotion,
      coarsePointer: () => globalThis.matchMedia('(pointer: coarse)').matches,
      isPhone: () => globalThis.matchMedia('(max-width: 599.98px)').matches,
    });
    workspace.attachMap(controller);
    return () => {
      workspace.attachMap(null);
      controller.dispose();
    };
  }, [services, workspace]);

  const instructions =
    mode === 'drawing'
      ? base.sr.drawMode
      : mode === 'editing-shape' && editName !== null
        ? base.sr.editMode(editName)
        : base.a11y.mapLabel;
  const reticle = mode === 'drawing' || mode === 'editing-shape';
  return (
    <div className="map-wrap" data-base-layer={baseLayer}>
      <div
        ref={host}
        id="map"
        className="map"
        data-testid="map"
        data-mode={mode}
        data-base-layer={baseLayer}
        tabIndex={0}
        aria-label={base.a11y.mapLabel}
        aria-describedby="map-instructions"
        role="application"
      />
      {reticle ? <Reticle /> : null}
      <p id="map-instructions" className="sr-only">
        {instructions}
      </p>
    </div>
  );
}
