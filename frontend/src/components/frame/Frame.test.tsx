/**
 * The Studio frame's contract (UX-AC-114 ... 123; UI.md v2 section 10.2 - section 10.13): the tool rail's names, keys, pressed and
 * disabled states; the options bar's `data-content` per mode; the status bar's `data-zoom` / `data-context`; the phone
 * sheet's `data-snap`. The redesign changed how these look, never these attributes.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServicesProvider, WorkspaceProvider } from '../../app/AppContext';
import { createAppServices } from '../../app/services';
import { base } from '../../base/en';
import { systemScheduler } from '../../lib/scheduler';
import { recordFromDto } from '../../state/areasStore';
import { areaDto, uuid } from '../../test/factories';
import { FakeSocket } from '../../test/fakeSocket';
import { signedIn } from '../../test/workspaceHarness';
import { Workspace } from '../../workspace/Workspace';
import { AreaSheet } from '../inspector/AreaSheet';
import { LayerSwitcher } from '../MapChrome';
import { OptionsBar } from './OptionsBar';
import { StatusBar, zoomLabel } from './StatusBar';
import { ToolRail } from './ToolRail';

/** A viewport `width` px wide with a fine or coarse pointer, as the layout hooks read it through `matchMedia`. */
function emulate(width: number, pointer: 'fine' | 'coarse' = 'fine'): void {
  const matches = (query: string): boolean => {
    const max = /max-width: ([\d.]+)px/u.exec(query);
    if (max !== null) return width <= Number(max[1]);
    const min = /min-width: ([\d.]+)px/u.exec(query);
    if (min !== null) return width >= Number(min[1]);
    if (query.includes('pointer: fine')) return pointer === 'fine';
    if (query.includes('pointer: coarse')) return pointer === 'coarse';
    return false;
  };
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup({ itmLayerEnabled = true }: { itmLayerEnabled?: boolean } = {}) {
  const services = createAppServices({
    fetch: () => Promise.resolve(new Response('{}', { status: 404 })),
    scheduler: systemScheduler,
    locks: null,
    apiBase: '/api/v1',
  });
  services.adopt(signedIn());
  const workspace = new Workspace(services, {
    openSocket: () => new FakeSocket(),
    isOnline: () => true,
    random: () => 0.5,
    reducedMotion: () => false,
    isPhone: () => false,
    itmLayerEnabled,
    appVersion: 'test',
  });
  const show = (node: ReactNode) =>
    render(
      <ServicesProvider services={services}>
        <WorkspaceProvider workspace={workspace}>{node}</WorkspaceProvider>
      </ServicesProvider>,
    );
  const patch = (state: Parameters<ReturnType<typeof services.stores.workspace.getState>['patch']>[0]) => {
    act(() => {
      services.stores.workspace.getState().patch(state);
    });
  };
  return { stores: services.stores, workspace, show, patch };
}

const AREA_ID = uuid(0xf1);

function selectArea(context: ReturnType<typeof setup>): void {
  const area = { ...areaDto({ id: AREA_ID, name: 'Yarkon Park Plot' }), areaKm2: 0.84 };
  act(() => {
    context.stores.areas.setState({ byId: new Map([[area.id, recordFromDto(area)]]) });
  });
  context.patch({
    mode: 'area-selected',
    selectedAreaId: area.id,
    panel: 'area',
    detail: { areaId: area.id, status: 'ready', area },
  });
}

describe('ToolRail (UX-AC-116, C-03)', () => {
  it('holds the five tools in order, with their names and single-key shortcuts', () => {
    emulate(1440);
    setup().show(<ToolRail />);
    const rail = screen.getByTestId('tool-rail');
    const buttons = within(rail).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('data-testid'))).toEqual([
      'draw-button',
      'rail-edit-button',
      'areas-button',
      'people-button',
      'shortcuts-button',
    ]);
    expect(buttons.map((button) => button.getAttribute('aria-keyshortcuts'))).toEqual([
      'D',
      'E',
      'A',
      'P',
      '?',
    ]);
    expect(screen.getByTestId('draw-button').getAttribute('aria-label')).toBe(base.draw.button);
    expect(screen.getByTestId('areas-button').getAttribute('aria-label')).toBe(base.rail.areas);
  });

  it('Edit shape is aria-disabled with its reason as the description while nothing is selected', () => {
    emulate(1440);
    setup().show(<ToolRail />);
    const edit = screen.getByTestId('rail-edit-button');
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(edit.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe(base.rail.editShapeUnavailable);
  });

  it('Draw and Areas report their pressed state; Areas is not pressed while the overlay hides the list', () => {
    emulate(1440);
    const docked = setup();
    docked.show(<ToolRail />);
    expect(screen.getByTestId('areas-button').getAttribute('aria-pressed')).toBe('false');
    docked.patch({ panel: 'list' });
    expect(screen.getByTestId('areas-button').getAttribute('aria-pressed')).toBe('true');
    docked.patch({ mode: 'drawing' });
    expect(screen.getByTestId('draw-button').getAttribute('aria-pressed')).toBe('true');
    // Docked: the list stays on screen while drawing.
    expect(screen.getByTestId('areas-button').getAttribute('aria-pressed')).toBe('true');
    cleanup();

    emulate(1024);
    const overlay = setup();
    overlay.show(<ToolRail />);
    overlay.patch({ panel: 'list' });
    expect(screen.getByTestId('areas-button').getAttribute('aria-pressed')).toBe('true');
    // Overlay: Drawing hides the overlay inspector, and the list with it (C-03 "pressed while the list shows").
    overlay.patch({ mode: 'drawing' });
    expect(screen.getByTestId('areas-button').getAttribute('aria-pressed')).toBe('false');
    overlay.patch({ mode: 'browse' });
    expect(screen.getByTestId('areas-button').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('OptionsBar (UX-AC-117, C-05)', () => {
  it('data-content follows the mode; the bar is a labelled group, never a live region', () => {
    emulate(1440);
    const context = setup();
    context.show(<OptionsBar />);
    const bar = screen.getByTestId('options-bar');
    expect(bar.getAttribute('data-content')).toBe('browse');
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.hasAttribute('aria-live')).toBe(false);
    expect(screen.queryByTestId('draw-hud')).toBeNull();
    act(() => {
      context.workspace.drawing.start('pointer');
    });
    expect(bar.getAttribute('data-content')).toBe('drawing');
    for (const id of ['draw-hud', 'undo-point-button', 'cancel-draw-button', 'finish-button'])
      expect(within(bar).getByTestId(id)).toBeDefined();
    act(() => {
      context.workspace.drawing.cancel();
    });
    selectArea(context);
    expect(bar.getAttribute('data-content')).toBe('selected');
    expect(within(bar).getByTestId('optbar-mode-tag').textContent).toContain(base.optbar.tagSelected);
  });

  it('Undo point is named by its visible label (WCAG 2.5.3) and described by what it does', () => {
    emulate(1440);
    const context = setup();
    context.show(<OptionsBar />);
    act(() => {
      context.workspace.drawing.start('pointer');
    });
    const undo = screen.getByTestId('undo-point-button');
    expect(undo.hasAttribute('aria-label')).toBe(false);
    expect(undo.querySelector('.btn-label')?.textContent).toBe(base.draw.undoPoint);
    const help = document.getElementById(undo.getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toBe(base.draw.undoPointHelp);
    expect(undo.getAttribute('aria-keyshortcuts')).not.toBeNull();
  });

  it('an icon-only Undo point shows the rail-style tooltip "Undo point, Ctrl Z" on hover; Esc dismisses it (C-05)', () => {
    vi.useFakeTimers();
    try {
      emulate(768);
      const context = setup();
      context.show(<OptionsBar />);
      act(() => {
        context.workspace.drawing.start('pointer');
      });
      const undo = screen.getByTestId('undo-point-button');
      // jsdom lays nothing out, so the label measures 0 px wide: the same as the narrow bar's collapsed label.
      act(() => {
        undo.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.runAllTimers();
      });
      const tip = within(undo).getByRole('tooltip', { hidden: true });
      expect(tip.textContent).toBe(`${base.draw.undoPoint} · Ctrl Z`);
      act(() => {
        undo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(within(undo).queryByRole('tooltip', { hidden: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StatusBar (UX-AC-120, C-29)', () => {
  it('status-zoom[data-zoom] is the map zoom; the key hints carry their context; nothing is focusable', () => {
    emulate(1440);
    const context = setup();
    act(() => {
      context.stores.mapView.setState({
        zoom: 15,
        mercatorZoom: 15,
        displayedBaseLayer: 'map',
        metersPerPixel: 4,
      });
    });
    context.show(<StatusBar />);
    const zoom = screen.getByTestId('status-zoom');
    expect(zoom.getAttribute('data-zoom')).toBe(zoomLabel(15));
    expect(zoom.textContent).toBe(base.status.zoom(zoomLabel(15)));
    expect(screen.getByTestId('status-key-hints').getAttribute('data-context')).toBe('browse');
    expect(screen.getByTestId('scale-bar')).toBeDefined();
    const bar = screen.getByTestId('status-bar');
    expect(bar.querySelectorAll('button, a[href], input, select, [tabindex]')).toHaveLength(0);
    expect(bar.querySelector('[aria-live]')).toBeNull();
  });

  it('on the ITM cache the text shows the Web-Mercator-equivalent zoom; data-zoom stays the level', () => {
    emulate(1440);
    const context = setup();
    act(() => {
      context.stores.mapView.setState({ zoom: 7, mercatorZoom: 15, displayedBaseLayer: 'govmap-itm' });
    });
    context.show(<StatusBar />);
    const zoom = screen.getByTestId('status-zoom');
    expect(zoom.getAttribute('data-zoom')).toBe(zoomLabel(7));
    expect(zoom.textContent).toBe(base.status.zoom(zoomLabel(15)));
  });
});

describe('AreaSheet (UX section 3.2, C-11; UI.md section 10.13)', () => {
  it('data-snap follows the selection, Expand and the content; Rename lives in the expanded sheet only', () => {
    emulate(390, 'coarse');
    const context = setup();
    context.show(<AreaSheet />);
    expect(screen.queryByTestId('area-sheet')).toBeNull();
    selectArea(context);
    context.patch({ sheet: 'peek' });
    const sheet = screen.getByTestId('area-sheet');
    expect(sheet.getAttribute('data-snap')).toBe('peek');
    expect(screen.queryByTestId('rename-button')).toBeNull();
    act(() => {
      screen.getByTestId('sheet-expand-button').click();
    });
    expect(screen.getByTestId('area-sheet').getAttribute('data-snap')).toBe('expanded');
    expect(screen.getByTestId('rename-button')).toBeDefined();
    context.patch({ panel: 'list' });
    expect(screen.getByTestId('area-sheet').getAttribute('data-snap')).toBe('expanded');
    // Editing a shape hides the sheet (the bottom bar holds the editing actions).
    context.patch({ panel: 'area', mode: 'editing-shape' });
    expect(screen.queryByTestId('area-sheet')).toBeNull();
  });

  it('new content starts at the top of the sheet body (the list header is the first row)', () => {
    emulate(390, 'coarse');
    const context = setup();
    context.show(<AreaSheet />);
    context.patch({ panel: 'list', sheet: 'expanded' });
    const body = document.querySelector<HTMLElement>('.sheet-body');
    if (body === null) throw new Error('no sheet body');
    body.scrollTop = 240;
    selectArea(context);
    expect(document.querySelector<HTMLElement>('.sheet-body')?.scrollTop).toBe(0);
  });
});

describe('LayerSwitcher (UX C-15, section 7)', () => {
  it('desktop: a Map / Aerial radio group; Aerial is the GovMap ITM cache with its tooltip', () => {
    emulate(1440);
    const context = setup();
    context.show(<LayerSwitcher />);
    const radios = within(screen.getByRole('radiogroup')).getAllByRole('radio');
    expect(radios.map((radio) => radio.dataset['testid'])).toEqual([
      'layer-switch-map',
      'layer-switch-aerial',
    ]);
    const aerial = screen.getByTestId('layer-switch-aerial');
    expect(aerial.getAttribute('title')).toBe(base.layer.aerialTooltipItm);
    act(() => {
      aerial.click();
    });
    expect(context.stores.mapView.getState()).toMatchObject({ choice: 'aerial', baseLayer: 'govmap-itm' });
    expect(screen.getByTestId('layer-switch-aerial').getAttribute('aria-checked')).toBe('true');
  });

  it('desktop with the ITM kill switch off: Aerial is Esri World Imagery', () => {
    emulate(1440);
    const context = setup({ itmLayerEnabled: false });
    context.show(<LayerSwitcher />);
    expect(screen.getByTestId('layer-switch-aerial').getAttribute('title')).toBe(
      base.layer.aerialTooltipEsri,
    );
  });

  it('phone: the one-tap layer-toggle switches to the other base map', () => {
    emulate(390, 'coarse');
    const context = setup();
    context.show(<LayerSwitcher />);
    const toggle = screen.getByTestId('layer-toggle');
    expect(toggle.getAttribute('aria-label')).toBe(base.layer.toggleLabel(base.layer.aerial));
    act(() => {
      toggle.click();
    });
    expect(context.stores.mapView.getState().choice).toBe('aerial');
    expect(screen.getByTestId('layer-toggle').getAttribute('aria-label')).toBe(
      base.layer.toggleLabel(base.layer.map),
    );
  });
});
