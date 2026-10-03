/** Layout rules of the Studio inspector (UX section 3.2, C-13, C-28) as pure functions. */
import { describe, expect, it } from 'vitest';

import type { Mode, WorkspaceLayout } from './workspaceStore';
import { hidesOverlayInspector, inspectorOpen, INITIAL_WORKSPACE, sectionExpanded } from './workspaceStore';

const layouts: WorkspaceLayout[] = ['docked', 'overlay', 'phone'];

describe('sectionExpanded', () => {
  it('defaults: History everywhere but the phone sheet; People and Activity only when docked', () => {
    const expanded = (layout: WorkspaceLayout) => ({
      history: sectionExpanded({ ...INITIAL_WORKSPACE, layout }, 'history'),
      people: sectionExpanded({ ...INITIAL_WORKSPACE, layout }, 'people'),
      activity: sectionExpanded({ ...INITIAL_WORKSPACE, layout }, 'activity'),
    });
    expect(expanded('docked')).toEqual({ history: true, people: true, activity: true });
    expect(expanded('overlay')).toEqual({ history: true, people: false, activity: false });
    expect(expanded('phone')).toEqual({ history: false, people: false, activity: false });
  });

  it("the user's choice for the session wins over every layout default", () => {
    for (const layout of layouts) {
      const state = { ...INITIAL_WORKSPACE, layout, historyExpanded: false, peopleExpanded: true };
      expect(sectionExpanded(state, 'history')).toBe(false);
      expect(sectionExpanded(state, 'people')).toBe(true);
    }
  });
});

describe('inspectorOpen', () => {
  it('docked: always open; phone: never (the sheet and popover take over)', () => {
    expect(inspectorOpen({ ...INITIAL_WORKSPACE, layout: 'docked' })).toBe(true);
    expect(inspectorOpen({ ...INITIAL_WORKSPACE, layout: 'phone', panel: 'area' })).toBe(false);
  });

  it('overlay: open only with content, and hidden while drawing or reshaping', () => {
    const overlay = { ...INITIAL_WORKSPACE, layout: 'overlay' as const };
    expect(inspectorOpen(overlay)).toBe(false);
    expect(inspectorOpen({ ...overlay, mode: 'area-selected', panel: 'area' })).toBe(true);
    expect(inspectorOpen({ ...overlay, inspectorExtras: true })).toBe(true);
    expect(inspectorOpen({ ...overlay, mode: 'naming', panel: 'save' })).toBe(true);
    for (const mode of ['drawing', 'editing-shape', 'saving-edit'] as Mode[]) {
      expect(hidesOverlayInspector(mode)).toBe(true);
      expect(inspectorOpen({ ...overlay, mode, panel: 'area', inspectorExtras: true })).toBe(false);
    }
  });
});
