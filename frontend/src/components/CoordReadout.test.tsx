import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createMapViewStore } from '../state/mapViewStore';
import { CoordReadout } from './CoordReadout';

afterEach(cleanup);

describe('CoordReadout (UX C-27, SPEC section 8.1 R34)', () => {
  it('shows the section 8.1 ITM vector for a mocked pointer at (34.78, 32.08): E 179383.784, N 665268.335 (+/-0.01 m)', () => {
    const mapView = createMapViewStore();
    render(<CoordReadout mapView={mapView} />);
    act(() => {
      mapView.getState().setPointer({ lat: 32.08, lng: 34.78 });
    });
    const readout = screen.getByTestId('coord-readout');
    expect(Number(readout.dataset['itmE'])).toBeCloseTo(179383.784, 2);
    expect(Number(readout.dataset['itmN'])).toBeCloseTo(665268.335, 2);
    expect(Number(readout.dataset['lat'])).toBe(32.08);
    expect(Number(readout.dataset['lng'])).toBe(34.78);
    // 6-dp WGS84, 1-dp ungrouped ITM metres (copy.coord.readout).
    expect(readout.textContent).toBe('32.080000, 34.780000 · ITM E 179383.8 N 665268.3');
    expect(readout.getAttribute('aria-live')).toBeNull();
  });

  it('falls back to the map centre when the pointer leaves the map, and wraps continuous longitudes', () => {
    const mapView = createMapViewStore({ center: { lat: 29.55, lng: 35.0 + 360 } });
    render(<CoordReadout mapView={mapView} />);
    const readout = screen.getByTestId('coord-readout');
    expect(Number(readout.dataset['lng'])).toBeCloseTo(35.0, 9);
    expect(Number(readout.dataset['itmE'])).toBeCloseTo(199642.122, 2);
    expect(Number(readout.dataset['itmN'])).toBeCloseTo(384711.599, 2);
  });

  it('the phone Areas-list variant shows the map centre with the "Map centre:" prefix', () => {
    const mapView = createMapViewStore({ center: { lat: 32.08, lng: 34.78 }, pointer: { lat: 0, lng: 0 } });
    render(<CoordReadout mapView={mapView} variant="list" />);
    expect(screen.getByTestId('coord-readout').textContent).toBe(
      'Map centre: 32.080000, 34.780000 · ITM E 179383.8 N 665268.3',
    );
  });

  it('UX-AC-120 in the status bar the map centre carries the "Map centre:" prefix, the pointer position does not', () => {
    const mapView = createMapViewStore({ center: { lat: 32.08, lng: 34.78 } });
    render(<CoordReadout mapView={mapView} />);
    expect(screen.getByTestId('coord-readout').textContent).toBe(
      'Map centre: 32.080000, 34.780000 · ITM E 179383.8 N 665268.3',
    );
    act(() => {
      mapView.getState().setPointer({ lat: 32.08, lng: 34.78 });
    });
    expect(screen.getByTestId('coord-readout').textContent).toBe(
      '32.080000, 34.780000 · ITM E 179383.8 N 665268.3',
    );
  });
});
