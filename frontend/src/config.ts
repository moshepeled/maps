/**
 * The SPA's build-time configuration (SPEC section 8.6, section 11.3) - the only module that reads `import.meta.env` (lint-enforced).
 * Runtime limits come from `GET /api/v1/config`, not from here.
 */

export interface FrontendConfig {
  /** Base path of the REST API. */
  readonly apiBase: string;
  /**
   * GovMap 2022 ITM base layer (`govmap-itm`, section 8.3): the *Aerial* source in every build (user decision D-1, ADR-0009).
   * Only an explicit false value (`false`, `0`, `no`, `off`) turns it off (kill switch -> Esri World Imagery, `aerial`);
   * a blank or unrecognised value keeps the default, so a typo cannot silently disable the default Aerial source.
   */
  readonly enableItmLayer: boolean;
  /** Read-only `window.__snapland` hooks for E2E (never enabled by a query string in production builds). */
  readonly e2eHooks: boolean;
}

/** The subset of `import.meta.env` the parser needs (injectable for tests). */
export interface BuildEnv {
  readonly VITE_API_BASE?: string | undefined;
  readonly VITE_ENABLE_ITM_LAYER?: string | undefined;
  readonly VITE_E2E_HOOKS?: string | undefined;
}

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no', 'off']);

/**
 * A build flag: recognised true/false spellings (case-insensitive) set it; anything else - blank, unset or a typo - * keeps the flag's default. Throwing is not an option: this runs in the browser at module load.
 */
export function parseFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

export function parseFrontendConfig(env: BuildEnv): FrontendConfig {
  const apiBase = env.VITE_API_BASE?.trim();
  return {
    apiBase: apiBase === undefined || apiBase === '' ? '/api/v1' : apiBase.replace(/\/+$/, ''),
    enableItmLayer: parseFlag(env.VITE_ENABLE_ITM_LAYER, true),
    e2eHooks: parseFlag(env.VITE_E2E_HOOKS, false),
  };
}

export const config: FrontendConfig = parseFrontendConfig(import.meta.env);

/** Build-time constant: the read-only `window.__snapland` E2E hook is compiled in only for `VITE_E2E_HOOKS=true`. */
export const E2E_HOOKS_BUILD: boolean = import.meta.env.VITE_E2E_HOOKS === 'true';
