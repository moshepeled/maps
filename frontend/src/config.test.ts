import { describe, expect, it } from 'vitest';

import { parseFlag, parseFrontendConfig } from './config';

describe('parseFrontendConfig (section 8.3, section 11.3)', () => {
  it('defaults: /api/v1, ITM layer on in every build (user decision D-1), E2E hooks off', () => {
    expect(parseFrontendConfig({})).toEqual({ apiBase: '/api/v1', enableItmLayer: true, e2eHooks: false });
  });

  it('VITE_ENABLE_ITM_LAYER=false is the kill switch; blank values fall back to the defaults', () => {
    expect(parseFrontendConfig({ VITE_ENABLE_ITM_LAYER: 'false' }).enableItmLayer).toBe(false);
    expect(parseFrontendConfig({ VITE_ENABLE_ITM_LAYER: ' ' }).enableItmLayer).toBe(true);
    expect(parseFrontendConfig({ VITE_E2E_HOOKS: 'TRUE' }).e2eHooks).toBe(true);
  });

  it('flags accept true/false spellings; an unrecognised value keeps the default instead of flipping it', () => {
    for (const off of ['0', 'no', 'OFF', ' False ']) {
      expect(parseFrontendConfig({ VITE_ENABLE_ITM_LAYER: off }).enableItmLayer, off).toBe(false);
    }
    for (const on of ['1', 'yes', 'On', 'true']) {
      expect(parseFrontendConfig({ VITE_ENABLE_ITM_LAYER: on }).enableItmLayer, on).toBe(true);
      expect(parseFrontendConfig({ VITE_E2E_HOOKS: on }).e2eHooks, on).toBe(true);
    }
    expect(parseFrontendConfig({ VITE_ENABLE_ITM_LAYER: 'flase' }).enableItmLayer).toBe(true);
    expect(parseFrontendConfig({ VITE_E2E_HOOKS: 'ture' }).e2eHooks).toBe(false);
    expect(parseFlag(undefined, true)).toBe(true);
  });

  it('trims the API base and drops trailing slashes', () => {
    expect(parseFrontendConfig({ VITE_API_BASE: ' /api/v1/ ' }).apiBase).toBe('/api/v1');
    expect(parseFrontendConfig({ VITE_API_BASE: '' }).apiBase).toBe('/api/v1');
  });
});
