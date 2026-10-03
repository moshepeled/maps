/// <reference types="vite/client" />

/** Build-time flags of the SPA (SPEC section 11.3); read only by `src/config.ts`. */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_ENABLE_ITM_LAYER?: string;
  readonly VITE_E2E_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
