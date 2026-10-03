/** Areas in view (UX C-10): the list renders at most LIST_RENDER_CAP rows and says so (`areas-list-capped`). */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ServicesProvider, WorkspaceProvider } from '../app/AppContext';
import { createAppServices } from '../app/services';
import { LIST_RENDER_CAP } from '../constants/ux';
import { systemScheduler } from '../lib/scheduler';
import { recordFromDto } from '../state/areasStore';
import { areaDto, uuid } from '../test/factories';
import { FakeSocket } from '../test/fakeSocket';
import { signedIn } from '../test/workspaceHarness';
import { Workspace } from '../workspace/Workspace';
import { AreasList } from './AreasList';

afterEach(cleanup);

function setup(count: number) {
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
  const areas = Array.from({ length: count }, (_, index) =>
    recordFromDto(
      areaDto({ id: uuid(0x1000 + index), west: 34.7 + index * 0.0005, south: 32.05, size: 0.0004 }),
    ),
  );
  act(() => {
    services.stores.areas.setState({ byId: new Map(areas.map((area) => [area.id, area])) });
    services.stores.mapView.setState({ viewport: [34.6, 32.0, 34.9, 32.2] });
  });
  render(
    <ServicesProvider services={services}>
      <WorkspaceProvider workspace={workspace}>
        <AreasList />
      </WorkspaceProvider>
    </ServicesProvider>,
  );
}

describe('AreasList render cap (UX C-10)', () => {
  it(`renders ${String(LIST_RENDER_CAP)} rows and the capped note when more areas are in view`, () => {
    setup(LIST_RENDER_CAP + 1);
    expect(screen.getAllByTestId('areas-list-item')).toHaveLength(LIST_RENDER_CAP);
    expect(screen.getByTestId('areas-list-capped')).toBeDefined();
  });

  it('shows every row and no note at the cap', () => {
    setup(LIST_RENDER_CAP);
    expect(screen.getAllByTestId('areas-list-item')).toHaveLength(LIST_RENDER_CAP);
    expect(screen.queryByTestId('areas-list-capped')).toBeNull();
  });
});
