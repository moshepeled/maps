// Before any other module: zod must be jitless before a schema is defined (see zodSetup.ts).
import './zodSetup';
// Self-hosted IBM Plex first (UI.md section 3; CSP font-src 'self'), then Leaflet's own rules, then the design tokens -
// straight from the design folder, the single source of every visual value - and the app's styles.
import './styles/fonts.css';
import 'leaflet/dist/leaflet.css';
import '../../docs/design/tokens.css';
import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { createAppServices } from './app/services';
import { themeController } from './theme/theme';

// public/theme-boot.js has already set <html data-theme> before the first paint; booting the controller again keeps
// the page correct where that script did not run, and starts following theme changes made in other tabs (D-5).
themeController().boot();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html must contain <div id="root">');
}

createRoot(container).render(
  <StrictMode>
    <App services={createAppServices()} />
  </StrictMode>,
);
