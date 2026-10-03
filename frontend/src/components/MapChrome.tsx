/**
 * Map chrome rendered once for all stacked maps (UX C-15, section 7; UI.md section 9.10, section 10.10): the base-map switcher (segmented
 * radio group; a one-tap toggle on phones), the zoom buttons and the attribution of the layer that is actually visible.
 */
import type { KeyboardEvent } from 'react';
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import type { LayerChoice } from '../state/mapViewStore';
import { toggledChoice } from '../state/mapViewStore';
import type { IconName } from './Icon';
import { Icon } from './Icon';

const CHOICES: readonly LayerChoice[] = ['map', 'aerial'];
const LABEL: Record<LayerChoice, string> = { map: base.layer.map, aerial: base.layer.aerial };
const ICON: Record<LayerChoice, IconName> = { map: 'map', aerial: 'satellite' };
const TEST_ID: Record<LayerChoice, string> = { map: 'layer-switch-map', aerial: 'layer-switch-aerial' };

function LayerRadios() {
  const workspace = useWorkspace();
  const choice = useStore(workspace.ctx.stores.mapView, (state) => state.choice);
  const aerialTooltip =
    workspace.aerialLayer() === 'govmap-itm' ? base.layer.aerialTooltipItm : base.layer.aerialTooltipEsri;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // Two options: every arrow key moves to the other one.
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    workspace.selectLayer(toggledChoice(choice));
    const group = event.currentTarget.closest('[role="radiogroup"]');
    globalThis.requestAnimationFrame(() => {
      group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    });
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={base.layer.groupLabel}>
      {CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          className="segment"
          data-testid={TEST_ID[option]}
          aria-checked={choice === option}
          tabIndex={choice === option ? 0 : -1}
          title={option === 'aerial' ? aerialTooltip : undefined}
          onClick={() => {
            workspace.selectLayer(option);
          }}
          onKeyDown={onKeyDown}
        >
          <Icon name={ICON[option]} size="sm" />
          {LABEL[option]}
        </button>
      ))}
    </div>
  );
}

export function LayerSwitcher() {
  const workspace = useWorkspace();
  const choice = useStore(workspace.ctx.stores.mapView, (state) => state.choice);
  const phone = usePhone();
  if (!phone) return <LayerRadios />;
  const target = toggledChoice(choice);
  return (
    <button
      type="button"
      className="layer-toggle"
      data-testid="layer-toggle"
      aria-label={base.layer.toggleLabel(LABEL[target])}
      onClick={() => {
        workspace.selectLayer(target);
      }}
    >
      <Icon name={ICON[target]} />
      {LABEL[target]}
    </button>
  );
}

export function ZoomControls() {
  const workspace = useWorkspace();
  return (
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button
        type="button"
        className="zoom-btn"
        aria-label="Zoom in"
        onClick={() => {
          workspace.ctx.map()?.zoomBy(1);
        }}
      >
        <Icon name="plus" />
      </button>
      <button
        type="button"
        className="zoom-btn"
        aria-label="Zoom out"
        onClick={() => {
          workspace.ctx.map()?.zoomBy(-1);
        }}
      >
        <Icon name="minus" />
      </button>
    </div>
  );
}

export function Attribution() {
  const workspace = useWorkspace();
  const displayed = useStore(workspace.ctx.stores.mapView, (state) => state.displayedBaseLayer);
  let content;
  if (displayed === 'map') {
    content = (
      <span>
        ©{' '}
        <a
          className="link"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer noopener"
        >
          OpenStreetMap
        </a>{' '}
        contributors
      </span>
    );
  } else if (displayed === 'govmap-itm') {
    content = (
      <span>
        <span dir="auto">תצלום אוויר</span> ©{' '}
        <a className="link" href="https://www.govmap.gov.il" target="_blank" rel="noreferrer noopener">
          GovMap
        </a>{' '}
        / <span dir="auto">המרכז למיפוי ישראל</span>
      </span>
    );
  } else {
    content = <span>{base.layer.attribEsri}</span>;
  }
  // The plate follows the displayed layer's map tone (UI.md section 2.5, section 9.10): white on the light-theme Map, dark otherwise.
  return (
    <div className="attribution" data-testid="attribution" data-base-layer={displayed}>
      {content}
    </div>
  );
}

/**
 * The floating map controls (UX C-15, section 7 v2; UI.md section 10.10): the base-map switcher with the zoom buttons below it, at
 * the map's top-left from 600 px; on phones the control row above the attribution (layer toggle left, zoom right).
 * The scale, the viewport summary and the coordinates moved to the status bar (C-29) in v2.
 */
export function MapControls() {
  return (
    <div className="map-controls">
      <LayerSwitcher />
      <ZoomControls />
    </div>
  );
}
