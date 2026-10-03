/**
 * The application shell (UX section 3.1, F-01 step 1): boot with a silent refresh (no flash of the sign-in form; a spinner
 * only after 300 ms), then `/signin`, `/signup` or the map workspace at `/`. The workspace never unmounts while the
 * user stays signed in - the session-expired dialog sits on top of it instead.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { ServicesProvider, useServices } from './app/AppContext';
import { navigate, useRoute } from './app/router';
import type { AppServices } from './app/services';
import { LoginPage } from './auth/LoginPage';
import { BrandMark } from './components/Icon';
import { SPINNER_DELAY_MS } from './constants/ux';

/**
 * The map workspace (Leaflet, proj4, the realtime client) is its own chunk: the sign-in page loads without it
 * (Core Web Vitals), and it is fetched in parallel with the boot refresh.
 */
const loadWorkspace = () =>
  import('./workspace/WorkspaceView').then((module) => ({ default: module.WorkspaceRoot }));
const WorkspaceRoot = lazy(loadWorkspace);

function BootScreen() {
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    const handle = globalThis.setTimeout(() => {
      setShowSpinner(true);
    }, SPINNER_DELAY_MS);
    return () => {
      globalThis.clearTimeout(handle);
    };
  }, []);
  return (
    <div className="boot" aria-busy="true">
      {showSpinner ? (
        <>
          <BrandMark size={40} />
          <span className="spinner" role="status" aria-label="Loading Snapland" />
        </>
      ) : null}
    </div>
  );
}

function Shell() {
  const services = useServices();
  const status = useStore(services.stores.auth, (state) => state.status);
  const route = useRoute();
  const signedOutNotice = new URLSearchParams(globalThis.location.search).get('signedout') === '1';

  useEffect(() => {
    void services.bootstrap();
    void loadWorkspace();
  }, [services]);

  useEffect(() => {
    if (status === 'signed-out' && route.path === '/')
      navigate(`/signin?next=${encodeURIComponent('/')}`, { replace: true });
    if (status === 'signed-in' && route.path !== '/') navigate(route.next, { replace: true });
  }, [status, route.path, route.next]);

  if (status === 'booting') return <BootScreen />;
  if (status === 'signed-in') {
    return route.path === '/' ? (
      <Suspense fallback={<BootScreen />}>
        <WorkspaceRoot />
      </Suspense>
    ) : (
      <BootScreen />
    );
  }
  return (
    <LoginPage
      mode={route.path === '/signup' ? 'signup' : 'signin'}
      next={route.next}
      signedOut={signedOutNotice}
    />
  );
}

export function App({ services }: { services: AppServices }) {
  return (
    <ServicesProvider services={services}>
      <Shell />
    </ServicesProvider>
  );
}
