/**
 * The Studio inspector content (UX C-09, C-11, C-13, C-19, C-25, C-31; UI.md v2 section 10.8, section 10.13): the restyle keeps
 * every test id, text and state the flows and E2E rely on, and adds the Studio structure - the readout well, the
 * person dots ("me" in the accent), the timeline's title / detail split and its Preview cue, the Activity names, the
 * held note and the phone variants.
 */
import type { AreaDto, AreaVersionDto, PresenceDto, UserRef } from '@snapland/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServicesProvider, WorkspaceProvider } from '../../app/AppContext';
import { createAppServices } from '../../app/services';
import { base } from '../../base/en';
import { formatArea, formatAreaParts, formatHectares, formatPerimeter } from '../../lib/format';
import { systemScheduler } from '../../lib/scheduler';
import { recordFromDto } from '../../state/areasStore';
import { ALICE, BOB, areaDto, uuid } from '../../test/factories';
import { FakeSocket } from '../../test/fakeSocket';
import { signedIn } from '../../test/workspaceHarness';
import { Workspace } from '../../workspace/Workspace';
import { AreaPanel } from '../AreaPanel';
import { ConflictPanel } from '../ConflictPanel';
import { HistoryList } from '../HistoryList';
import { SaveAreaForm } from '../SaveAreaForm';
import { ToolRail } from '../frame/ToolRail';
import { ActivitySection } from './ActivitySection';
import { Inspector } from './Inspector';
import { PeopleSection } from './PeopleSection';
import { PresenceButton } from '../presence/Presence';

/** ALICE is the signed-in user in `signedIn()`; BOB and CAROL are collaborators. */
const CAROL: UserRef = {
  id: '7c1d2b3a-4f50-4c55-9a0e-3f6c1a2e0b1d',
  displayName: 'Carol Levi',
  color: '#f461ff',
};
const AREA_ID = uuid(0xa1);

/** Below 600 px the layout is the phone frame (`useLayout`, `usePhone`). */
function emulatePhone(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(max-width: 599.98px)',
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

function setup() {
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
    itmLayerEnabled: true,
    appVersion: 'test',
  });
  const show = (node: ReactNode) =>
    render(
      <ServicesProvider services={services}>
        <WorkspaceProvider workspace={workspace}>{node}</WorkspaceProvider>
      </ServicesProvider>,
    );
  return { stores: services.stores, workspace, show };
}

/** Created by Bob, last edited by me (Alice): the scenario of the concept frames. */
function yarkon(): AreaDto {
  return {
    ...areaDto({ id: AREA_ID, version: 3, name: 'Yarkon Park Plot', createdBy: BOB }),
    areaKm2: 0.84,
    perimeterKm: 3.91,
    vertexCount: 6,
    updatedBy: ALICE,
  };
}

function select(context: ReturnType<typeof setup>, area: AreaDto): void {
  context.stores.areas.setState({ byId: new Map([[area.id, recordFromDto(area)]]) });
  context.stores.workspace.getState().patch({
    mode: 'area-selected',
    selectedAreaId: area.id,
    panel: 'area',
    detail: { areaId: area.id, status: 'ready', area },
  });
}

describe('Selection (UX C-11 v2; UI.md section 10.8.2)', () => {
  it('the readout well keeps the analysis test ids, with the same text as the formatters (UX-AC-14, -107)', () => {
    const context = setup();
    select(context, yarkon());
    context.show(<AreaPanel />);
    expect(screen.getByTestId('area-panel-km2').textContent).toBe(formatArea(0.84));
    expect(screen.getByTestId('area-panel-km2').getAttribute('data-km2')).toBe('0.84');
    expect(screen.getByTestId('area-panel-ha').textContent).toBe(formatHectares(0.84));
    const perimeter = screen.getByTestId('area-panel-perimeter');
    expect(perimeter.textContent).toBe(formatPerimeter(3.91));
    expect(perimeter.getAttribute('data-perimeter-km')).toBe('3.91');
    const vertices = screen.getByTestId('area-panel-vertices');
    expect(vertices.textContent).toBe('6');
    expect(vertices.getAttribute('data-count')).toBe('6');
    expect(screen.getByTestId('area-panel-version').textContent).toBe('v3');
    // The number is mono and the unit sans: two spans inside the test id.
    expect(screen.getByTestId('area-panel-km2').querySelector('.num')?.textContent).toBe(
      formatAreaParts(0.84).value,
    );
  });

  it('Created and Last edit show the person dot; my own dot is the accent ("me" reads as one colour)', () => {
    const context = setup();
    select(context, yarkon());
    context.show(<AreaPanel />);
    const rows = document.querySelectorAll('.props__row');
    expect([...rows].map((row) => row.querySelector('dt')?.textContent)).toEqual(['Created', 'Last edit']);
    const created = rows[0]?.querySelector('.who');
    const edited = rows[1]?.querySelector('.who');
    expect(created?.textContent).toBe(BOB.displayName);
    expect(created?.classList.contains('who--me')).toBe(false);
    expect((created as HTMLElement | null)?.style.getPropertyValue('--c')).toBe(BOB.color);
    expect(edited?.classList.contains('who--me')).toBe(true);
  });

  it('keeps Zoom to area and Close in the header, Edit shape with its E chip, and no Delete for a non-creator', () => {
    const context = setup();
    select(context, yarkon());
    context.show(<AreaPanel />);
    expect(screen.getByTestId('zoom-to-area-button').getAttribute('aria-keyshortcuts')).toBe('Z');
    expect(screen.getByTestId('close-panel-button').getAttribute('aria-label')).toBe(base.panel.close);
    const edit = screen.getByTestId('edit-shape-button');
    expect(edit.textContent).toContain(base.edit.button);
    expect(edit.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByTestId('delete-area-button')).toBeNull();
  });

  it('phones: one metrics line with the same test ids, the version beside Last edit, 44 px sheet actions', () => {
    emulatePhone();
    const context = setup();
    select(context, { ...yarkon(), createdBy: ALICE });
    context.show(<AreaPanel />);
    const metrics = document.querySelector('.sheet-metrics');
    expect(metrics).not.toBeNull();
    expect(within(metrics as HTMLElement).getByTestId('area-panel-km2').textContent).toBe(formatArea(0.84));
    expect(within(metrics as HTMLElement).getByTestId('area-panel-perimeter').textContent).toBe(
      formatPerimeter(3.91),
    );
    expect(
      within(metrics as HTMLElement)
        .getByTestId('area-panel-vertices')
        .getAttribute('data-count'),
    ).toBe('6');
    expect(document.querySelector('.well')).toBeNull();
    expect(document.querySelector('.props')?.contains(screen.getByTestId('area-panel-version'))).toBe(true);
    for (const id of ['edit-shape-button', 'history-tab', 'delete-area-button'])
      expect(screen.getByTestId(id).classList.contains('btn-lg')).toBe(true);
  });
});

function version(
  n: number,
  op: AreaVersionDto['op'],
  changedFields: AreaVersionDto['changedFields'],
  actor: UserRef,
  extra: Partial<AreaVersionDto>,
): AreaVersionDto {
  return {
    areaId: AREA_ID,
    version: n,
    op,
    name: 'Yarkon Park Plot',
    description: null,
    areaKm2: 0.84,
    perimeterKm: 3.91,
    vertexCount: 6,
    changedFields,
    merged: false,
    revertedFrom: null,
    changeSeq: 10 + n,
    actor,
    createdAt: '2026-09-28T08:00:00.000Z',
    ...extra,
  };
}

describe('Selection shows one version (UX F-07 step 3, C-11)', () => {
  it('while a version is previewed, the name, figures and description are that version’s, tagged Preview, version v1', () => {
    const context = setup();
    select(context, yarkon());
    const v1 = version(1, 'create', [], BOB, {
      name: 'Yarkon Plot',
      description: 'The first outline',
      areaKm2: 0.79,
      perimeterKm: 3.5,
      vertexCount: 5,
    });
    context.stores.workspace.getState().patch({
      mode: 'previewing-version',
      preview: { areaId: AREA_ID, version: v1, restoring: false, countdownUntil: null, viaKeyboard: false },
    });
    context.show(<AreaPanel />);
    expect(screen.getByTestId('area-panel-name').textContent).toBe('Yarkon Plot');
    expect(screen.getByTestId('area-panel-km2').getAttribute('data-km2')).toBe('0.79');
    expect(screen.getByTestId('area-panel-version').textContent).toBe('v1');
    expect(screen.getByTestId('area-panel-vertices').textContent).toBe('5');
    expect(screen.getByTestId('area-panel-preview-tag').textContent).toBe(base.history.previewTag);
    expect(screen.getByText('The first outline')).toBeDefined();
    act(() => {
      context.stores.workspace.getState().patch({ mode: 'area-selected', preview: null });
    });
    expect(screen.getByTestId('area-panel-name').textContent).toBe('Yarkon Park Plot');
    expect(screen.queryByTestId('area-panel-preview-tag')).toBeNull();
  });

  it('a change that reached the map store before the detail shows its name with its version, never a mix', () => {
    const context = setup();
    const area = yarkon();
    select(context, area);
    context.show(<AreaPanel />);
    act(() => {
      context.stores.areas.setState({
        byId: new Map([[area.id, recordFromDto({ ...area, name: 'Yarkon North', version: 4 })]]),
      });
    });
    expect(screen.getByTestId('area-panel-name').textContent).toBe('Yarkon North');
    expect(screen.getByTestId('area-panel-version').textContent).toBe('v4');
  });
});

describe('Rename / description input (UX F-05, F-09 step 1, section 8.3)', () => {
  it('Esc and Enter close the input with focus on the area heading, never on <body>', () => {
    const context = setup();
    select(context, yarkon());
    context.show(<AreaPanel />);
    act(() => {
      context.workspace.area.startDetailsEdit('name');
    });
    const input = screen.getByTestId('rename-input');
    expect(document.activeElement).toBe(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(document.activeElement).toBe(screen.getByTestId('area-panel-name'));
    act(() => {
      context.workspace.area.startDetailsEdit('name');
    });
    // An unchanged name closes at once on Enter (no request).
    act(() => {
      fireEvent.keyDown(screen.getByTestId('rename-input'), { key: 'Enter' });
    });
    expect(document.activeElement).toBe(screen.getByTestId('area-panel-name'));
  });

  it('a newer version arriving while the input is open shows the early warning, my text unchanged', () => {
    const context = setup();
    const area = yarkon();
    select(context, area);
    context.show(<AreaPanel />);
    act(() => {
      context.workspace.area.startDetailsEdit('name', 'My name');
    });
    expect(screen.queryByText(base.edit.newerVersion(BOB.displayName, 4))).toBeNull();
    act(() => {
      context.stores.areas.setState({
        byId: new Map([[area.id, recordFromDto({ ...area, version: 4, updatedBy: BOB })]]),
      });
    });
    expect(screen.getByText(base.edit.newerVersion(BOB.displayName, 4))).toBeTruthy();
    expect(screen.getByTestId('rename-input')).toHaveProperty('value', 'My name');
  });
});

describe('History timeline (UX C-13; UI.md section 10.8.3)', () => {
  function showHistory() {
    const context = setup();
    const previewed = version(2, 'update', ['geometry'], BOB, { name: 'Yarkon Plot' });
    const items = [
      version(3, 'update', ['name'], ALICE, {}),
      previewed,
      version(1, 'create', [], BOB, { name: 'Yarkon Plot', areaKm2: 0.79 }),
    ];
    context.stores.workspace.getState().patch({
      history: { areaId: AREA_ID, status: 'ready', items, retryAt: null },
      preview: {
        areaId: AREA_ID,
        version: previewed,
        restoring: false,
        countdownUntil: null,
        viaKeyboard: false,
      },
    });
    context.show(<HistoryList areaId={AREA_ID} currentVersion={3} />);
    return screen.getAllByTestId('history-item');
  }

  it('each version is still a history-item button; the figures after ", " move to the person line in mono', () => {
    const [v3, v2, v1] = showHistory();
    expect([v3, v2, v1].map((item) => item?.getAttribute('data-version'))).toEqual(['3', '2', '1']);
    expect(v2?.querySelector('.tl-title')?.textContent).toBe('Reshaped');
    expect(v2?.querySelector('.tl-sub .num')?.textContent).toBe(`${formatArea(0.79)} → ${formatArea(0.84)}`);
    expect(v1?.querySelector('.tl-title')?.textContent).toBe('Created');
    expect(v1?.querySelector('.tl-sub .num')?.textContent).toBe(formatArea(0.79));
  });

  it('a rename shows "Renamed" as the title and its "from ..." source as text on the person line', () => {
    const [v3] = showHistory();
    expect(v3?.querySelector('.tl-title')?.textContent).toBe('Renamed');
    // The old name is the user's text: isolated, and not set as a figure.
    const source = v3?.querySelector('bdi.tl-detail');
    expect(source?.textContent).toBe('from “Yarkon Plot”');
    expect(v3?.querySelector('.tl-sub .num')).toBeNull();
    // Title and source together are still the whole history copy.
    expect(`${v3?.querySelector('.tl-title')?.textContent ?? ''} ${source?.textContent ?? ''}`).toBe(
      base.history.renamed('Yarkon Plot'),
    );
  });

  it('"Current" follows the area version, so a list one change behind never tags an older version', () => {
    const context = setup();
    const items = [version(2, 'update', ['name'], BOB, {}), version(1, 'create', [], BOB, {})];
    context.stores.workspace.getState().patch({
      history: { areaId: AREA_ID, status: 'ready', items, retryAt: null },
    });
    context.show(<HistoryList areaId={AREA_ID} currentVersion={3} />);
    expect(screen.queryByText(base.history.current)).toBeNull();
  });

  it('never splits an old name at its own ", ", and keeps a change without a detail whole', () => {
    const context = setup();
    const items = [
      version(3, 'update', ['description'], BOB, {}),
      version(2, 'update', ['name'], BOB, {}),
      version(1, 'create', [], BOB, { name: 'North · South' }),
    ];
    context.stores.workspace.getState().patch({
      history: { areaId: AREA_ID, status: 'ready', items, retryAt: null },
    });
    context.show(<HistoryList areaId={AREA_ID} currentVersion={3} />);
    const [v3, v2] = screen.getAllByTestId('history-item');
    expect(v3?.querySelector('.tl-title')?.textContent).toBe(base.history.described);
    expect(v3?.querySelector('.tl-detail, .tl-sub .num')).toBeNull();
    expect(v2?.querySelector('.tl-title')?.textContent).toBe('Renamed');
    expect(v2?.querySelector('.tl-detail')?.textContent).toBe('from “North · South”');
  });

  it('the Preview cue is a visible label, hidden from assistive technology', () => {
    const [, v2] = showHistory();
    const cue = v2?.querySelector('.tl-preview');
    expect(cue?.textContent).toBe('Preview');
    expect(cue?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks the current version, the previewed one, and colours the node by actor (mine = accent)', () => {
    const [v3, v2] = showHistory();
    expect(v3?.querySelector('.tag-current')?.textContent).toBe(base.history.current);
    expect(v2?.querySelector('.tag-current')).toBeNull();
    expect(v2?.getAttribute('aria-current')).toBe('true');
    expect(v3?.getAttribute('aria-current')).toBeNull();
    expect(v3?.style.getPropertyValue('--node')).toBe('var(--color-accent)');
    expect(v2?.style.getPropertyValue('--node')).toBe(BOB.color);
    expect(v3?.querySelector('.who--me')).not.toBeNull();
    // The Preview cue is decoration: the row is the only control (no nested button).
    expect(v2?.querySelector('.tl-preview')?.getAttribute('aria-hidden')).toBe('true');
    expect(v2?.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByTestId('history-preview-banner')).toBeDefined();
  });
});

function presence(user: UserRef, status: PresenceDto['status'], connection: number): PresenceDto {
  return {
    connectionId: uuid(0xc00 + connection),
    userId: user.id,
    displayName: user.displayName,
    color: user.color,
    status,
    activeAreaId: null,
    viewport: null,
    connectedAt: '2026-09-28T08:00:00.000Z',
    updatedAt: '2026-09-28T08:00:00.000Z',
  };
}

describe('People (UX section 6.1, C-25; UI.md section 10.4)', () => {
  it('rows keep presence-item[data-status], tag me with You, and tone the status icon by person', () => {
    const context = setup();
    context.stores.presence
      .getState()
      .snapshot(
        [presence(ALICE, 'drawing', 1), presence(BOB, 'drawing', 2), presence(CAROL, 'viewing', 3)],
        3,
        false,
        'ws',
      );
    context.show(<PeopleSection />);
    const rows = within(screen.getByTestId('presence-list')).getAllByTestId('presence-item');
    const byUser = (user: UserRef) => rows.find((row) => row.getAttribute('data-user-id') === user.id);
    const me = byUser(ALICE);
    expect(me?.querySelector('.tag-you')?.textContent).toBe(base.presence.you);
    expect(me?.querySelector('.presence-row__icon--me')).not.toBeNull();
    const bob = byUser(BOB);
    expect(bob?.getAttribute('data-status')).toBe('drawing');
    expect(bob?.style.getPropertyValue('--c')).toBe(BOB.color);
    expect(bob?.querySelector('.presence-row__icon--person')).not.toBeNull();
    const carol = byUser(CAROL);
    expect(carol?.textContent).toContain(base.presence.viewing);
    expect(carol?.querySelector('[class*="presence-row__icon--"]')).toBeNull();
    // Status badges on the avatars: plus / eye glyphs, the accent disc for me.
    expect(me?.querySelector('.avatar--me .avatar__badge--drawing')).not.toBeNull();
    expect(carol?.querySelector('.avatar__badge--viewing')).not.toBeNull();
  });

  it('alone on the map: my row, then the only-you note as body text', () => {
    const context = setup();
    context.stores.presence.getState().snapshot([presence(ALICE, 'viewing', 1)], 1, false, 'ws');
    context.show(<PeopleSection />);
    expect(within(screen.getByTestId('presence-list')).getAllByTestId('presence-item')).toHaveLength(1);
    const note = screen.getByText(base.presence.onlyYou);
    expect(note.classList.contains('presence-note--alone')).toBe(true);
  });
});

describe('Presence avatars (UI.md section 10.4 joins only)', () => {
  it('a re-sort on a status change replays nothing; a join animates once, until its animation ends', () => {
    const context = setup();
    const snapshot = (entries: PresenceDto[]) => {
      act(() => {
        context.stores.presence.getState().snapshot(entries, entries.length, false, 'ws');
      });
    };
    snapshot([presence(ALICE, 'viewing', 1), presence(BOB, 'viewing', 2)]);
    context.show(<PresenceButton phone={false} />);
    const entering = () => [...document.querySelectorAll('.avatar-stack .avatar--entering')];
    // The first render is not a join.
    expect(entering()).toHaveLength(0);
    // Bob starts drawing: busy people sort first, the stack re-orders, nobody joined.
    snapshot([presence(ALICE, 'viewing', 1), presence(BOB, 'drawing', 2)]);
    expect(entering()).toHaveLength(0);
    // Carol joins: only her avatar eases in, and only until its animation has run.
    snapshot([presence(ALICE, 'viewing', 1), presence(BOB, 'drawing', 2), presence(CAROL, 'viewing', 3)]);
    expect(entering().map((avatar) => avatar.textContent)).toEqual(['CL']);
    const [carol] = entering();
    if (carol === undefined) throw new Error('no entering avatar');
    // jsdom has no AnimationEvent, so React listens under a vendor-prefixed name: send both.
    for (const name of ['animationend', 'webkitAnimationEnd'])
      fireEvent(carol, new Event(name, { bubbles: true }));
    expect(entering()).toHaveLength(0);
    snapshot([presence(ALICE, 'viewing', 1), presence(BOB, 'viewing', 2), presence(CAROL, 'drawing', 3)]);
    expect(entering()).toHaveLength(0);
  });
});

describe('Activity (UX C-31, section 6.5; UI.md section 10.8.6)', () => {
  it('the held-toasts note sits in the header while drawing, even with the section collapsed', () => {
    const context = setup();
    context.stores.workspace.getState().patch({ mode: 'drawing', activityExpanded: false });
    context.show(<ActivitySection />);
    const note = screen.getByTestId('activity-held-note');
    expect(note.textContent).toBe(base.activity.heldNote);
    expect(note.getAttribute('title')).toBe(base.activity.heldHelp);
    expect(screen.getByTestId('activity-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('activity-body')?.hidden).toBe(true);
  });

  it('rows show the actor avatar, the text and the mono meta, with Show while the area exists', () => {
    const context = setup();
    const area = yarkon();
    context.stores.areas.setState({ byId: new Map([[area.id, recordFromDto(area)]]) });
    context.stores.activity.getState().record({
      areaId: area.id,
      code: 'collab.created',
      actor: BOB,
      text: base.collab.created(BOB.displayName, area.name, formatArea(0.84)),
      areaKm2: 0.84,
      at: Date.now(),
    });
    context.show(<ActivitySection />);
    const row = screen.getByTestId('activity-item');
    expect(row.querySelector('.avatar')?.textContent).toBe('Bo');
    expect(row.querySelector('.activity-row__meta')?.classList.contains('num')).toBe(true);
    expect(within(row).getByTestId('activity-show').textContent).toBe(base.toast.show);
  });

  it('line 1 keeps the toast text, sets each quoted area name apart in a <bdi>, and carries it in title', () => {
    const context = setup();
    const text = base.collab.renamed(BOB.displayName, 'Yarkon Plot', 'Yarkon Park Plot');
    context.stores.activity.getState().record({
      areaId: AREA_ID,
      code: 'collab.renamed',
      actor: BOB,
      text,
      areaKm2: 0.84,
      at: Date.now(),
    });
    context.show(<ActivitySection />);
    const line = screen.getByTestId('activity-item').querySelector('.activity-row__line');
    expect(line?.textContent).toBe(text);
    expect(line?.getAttribute('title')).toBe(text);
    expect(
      [...(line?.querySelectorAll('bdi.activity-row__name') ?? [])].map((name) => name.textContent),
    ).toEqual(['“Yarkon Plot”', '“Yarkon Park Plot”']);
  });
});

describe('Save form (UX C-09; UI.md section 10.8.4, section 10.13)', () => {
  function naming(context: ReturnType<typeof setup>): void {
    const drawing = context.stores.drawing.getState().drawing;
    context.stores.drawing.getState().setDrawing({
      ...drawing,
      points: [
        [34.78, 32.08],
        [34.79, 32.08],
        [34.79, 32.09],
      ],
    });
    context.stores.workspace.getState().patch({ mode: 'naming', panel: 'save' });
  }
  const order = () =>
    [...document.querySelectorAll('.save-form__actions > button')].map(
      (button) => button.getAttribute('data-testid') ?? button.textContent,
    );

  it('inspector: kicker title, the compact area well, then Save area, Back to drawing, Discard', () => {
    const context = setup();
    naming(context);
    context.show(<SaveAreaForm />);
    expect(document.getElementById('save-title')?.textContent).toBe(base.save.title);
    expect(document.querySelector('.save-well .num')).not.toBeNull();
    expect(order()).toEqual(['save-area-submit', 'back-to-drawing', 'discard-draft']);
    expect(screen.getByTestId('discard-draft').classList.contains('btn-danger-ghost')).toBe(true);
  });

  it('phone naming sheet: Discard in the header; Back to drawing, Save area at 44 px', () => {
    emulatePhone();
    const context = setup();
    naming(context);
    context.show(<SaveAreaForm />);
    expect(document.querySelector('.save-form__head')?.contains(screen.getByTestId('discard-draft'))).toBe(
      true,
    );
    expect(order()).toEqual(['back-to-drawing', 'save-area-submit']);
    expect(screen.getByTestId('save-area-submit').classList.contains('btn-lg')).toBe(true);
    expect(screen.getByTestId('add-description-button')).toBeDefined();
  });
});

describe('Conflict legend (UX C-19; UI.md section 10.8.5)', () => {
  it('the show toggles are eye buttons that keep their names and aria-pressed', () => {
    const context = setup();
    const current = { ...yarkon(), updatedBy: BOB };
    context.stores.workspace.getState().patch({
      mode: 'resolving-conflict',
      panel: 'conflict',
      conflict: {
        areaId: AREA_ID,
        mine: { rings: current.geometry.coordinates },
        current,
        conflictingFields: ['geometry'],
        serverChangedFields: [],
        origin: 'shape',
        showMine: true,
        showTheirs: false,
        reviewing: false,
        choices: {},
        changedAgain: false,
        saving: false,
      },
    });
    context.show(<ConflictPanel />);
    const mine = screen.getByRole('button', { name: base.conflict.showMine });
    const theirs = screen.getByRole('button', { name: base.conflict.showTheirs });
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(theirs.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(theirs);
    expect(theirs.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.lg-swatch__core--theirs')).not.toBeNull();
    for (const id of ['conflict-keep-mine', 'conflict-take-theirs', 'conflict-review', 'conflict-later'])
      expect(screen.getByTestId(id)).toBeDefined();
  });

  it('Review differences moves focus to the review caption, never to <body> (UX section 8.3)', () => {
    const context = setup();
    const current = { ...yarkon(), updatedBy: BOB };
    context.stores.workspace.getState().patch({
      mode: 'resolving-conflict',
      panel: 'conflict',
      conflict: {
        areaId: AREA_ID,
        mine: { rings: current.geometry.coordinates },
        current,
        conflictingFields: ['geometry'],
        serverChangedFields: [],
        origin: 'shape',
        showMine: true,
        showTheirs: true,
        reviewing: false,
        choices: { geometry: 'mine' },
        changedAgain: false,
        saving: false,
      },
    });
    context.show(<ConflictPanel />);
    const review = screen.getByTestId('conflict-review');
    review.focus();
    // Enter on a focused button is a click with detail 0; the button then leaves the DOM.
    act(() => {
      fireEvent.click(review, { detail: 0 });
    });
    expect(screen.queryByTestId('conflict-review')).toBeNull();
    expect(screen.getAllByTestId('conflict-field-row')).toHaveLength(1);
    const caption = document.querySelector('table.diff caption');
    expect(caption?.textContent).toBe(base.conflict.review);
    expect(document.activeElement).toBe(caption);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('Overlay inspector focus (UX section 8.3, C-28)', () => {
  // jsdom has no scrollIntoView; `showPeople` scrolls the People section into view.
  const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
  });
  afterEach(() => {
    if (scrollIntoView === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    else Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
  });

  function openPeopleFromRail() {
    const context = setup();
    // The default test viewport matches no media query: the overlay layout (600-1,199 px).
    context.stores.workspace.getState().patch({ layout: 'overlay' });
    context.show(
      <>
        <ToolRail />
        <Inspector />
      </>,
    );
    const people = screen.getByTestId('people-button');
    people.focus();
    act(() => {
      fireEvent.click(people, { detail: 0 });
    });
    expect(screen.getByTestId('inspector').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('inspector').contains(document.activeElement)).toBe(true);
    return { context, people };
  }

  it('closing the People overlay with its close button returns focus to the rail button that opened it', () => {
    const { people } = openPeopleFromRail();
    const close = screen.getByTestId('inspector-close');
    close.focus();
    act(() => {
      fireEvent.click(close, { detail: 0 });
    });
    expect(screen.getByTestId('inspector').getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(people);
  });

  it('Esc returns focus to the invoker too', () => {
    const { context, people } = openPeopleFromRail();
    act(() => {
      context.workspace.escape();
    });
    expect(document.activeElement).toBe(people);
  });
});
