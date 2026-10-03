// Vite config of the SPA (SPEC section 8.6). The shared contracts resolve to their TypeScript source, never a stale dist.
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { defineConfig } from 'vite';

/** Local backend (host port 3000 is taken on the dev machine; the backend listens on 3100 everywhere). */
const BACKEND_HTTP = 'http://localhost:3100';
const BACKEND_WS = 'ws://localhost:3100';

/** The map libraries and their dependencies (Leaflet; proj4 with mgrs and wkt-parser; proj4leaflet). */
const MAP_VENDOR_MODULE = /[\\/]node_modules[\\/](leaflet|proj4|proj4leaflet|mgrs|wkt-parser)[\\/]/;

/** The two faces every screen renders first (UI.md section 3): Plex Sans 400 and Plex Mono 500, latin, woff2. */
const PRELOADED_FONTS = ['ibm-plex-sans-latin-400-normal.woff2', 'ibm-plex-mono-latin-500-normal.woff2'];

/**
 * Adds `<link rel="preload">` for the hashed build names of `PRELOADED_FONTS`, so the first paint does not wait for
 * the stylesheet to discover them. Fonts are same-origin (CSP font-src 'self'); `crossorigin` is still required for
 * font preloads to be reused by the @font-face request.
 */
function preloadFonts(fileNames: readonly string[]): Plugin {
  return {
    name: 'snapland:preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context): HtmlTagDescriptor[] {
        const assets = Object.values(context.bundle ?? {}).filter((output) => output.type === 'asset');
        return assets
          .filter((asset) =>
            [...asset.names, ...asset.originalFileNames].some((name) =>
              fileNames.some((wanted) => name.endsWith(wanted)),
            ),
          )
          .map((asset) => ({
            tag: 'link',
            attrs: {
              rel: 'preload',
              href: `/${asset.fileName}`,
              as: 'font',
              type: 'font/woff2',
              crossorigin: '',
            },
            injectTo: 'head',
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadFonts(PRELOADED_FONTS)],
  resolve: {
    alias: {
      '@snapland/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5174, // 5173 is the docker compose stack (user decision D-2, SPEC §11)
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND_HTTP, changeOrigin: false },
      '/docs': { target: BACKEND_HTTP, changeOrigin: false },
      '/health': { target: BACKEND_HTTP, changeOrigin: false },
      '/ws': { target: BACKEND_WS, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Maps keep file/line mappings for client-error reports but do not ship the TypeScript sources themselves, so
        // a production build contains no dev-only code - not even inside its source maps (SPEC section 8.3 / SG-24).
        sourcemapExcludeSources: true,
        codeSplitting: {
          groups: [
            {
              // The map libraries change far less often than the app: a separate, long-cached chunk, loaded with
              // the lazy workspace (never by the sign-in page). Also keeps every chunk under the 500 kB warning in
              // the E2E build, whose hooks make the workspace chunk larger.
              name: 'map-vendor',
              // Scripts only: leaflet.css is imported by main.tsx and stays in the entry's stylesheet, otherwise the
              // entry would have to import this chunk (and the sign-in page would download Leaflet).
              test: (id) => MAP_VENDOR_MODULE.test(id) && !id.endsWith('.css'),
            },
          ],
        },
      },
    },
  },
});
