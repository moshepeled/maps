/**
 * A ~40-line History-API router (SPEC section 8.6: `/signin`, `/signup`, `/`; no router dependency). The workspace never
 * unmounts while signed in, so drafts and the live connection survive everything but a sign-out (UX section 3.1).
 */
import { useSyncExternalStore } from 'react';

export type RoutePath = '/signin' | '/signup' | '/';

export interface Route {
  path: RoutePath;
  /** `?next=` after signing in (only same-origin paths are honoured). */
  next: string;
}

const NAVIGATE_EVENT = 'snapland:navigate';

function subscribe(onChange: () => void): () => void {
  globalThis.addEventListener('popstate', onChange);
  globalThis.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    globalThis.removeEventListener('popstate', onChange);
    globalThis.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

function snapshot(): string {
  return `${globalThis.location.pathname}${globalThis.location.search}`;
}

/** Parses a location into a route; unknown paths are the workspace. */
export function parseRoute(pathname: string, search: string): Route {
  const path: RoutePath = pathname === '/signin' || pathname === '/signup' ? pathname : '/';
  const next = new URLSearchParams(search).get('next') ?? '/';
  // Only local absolute paths: `//evil.example` and `https://...` are open redirects.
  return { path, next: next.startsWith('/') && !next.startsWith('//') ? next : '/' };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (snapshot() === to) return;
  if (options.replace === true) globalThis.history.replaceState(null, '', to);
  else globalThis.history.pushState(null, '', to);
  globalThis.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function useRoute(): Route {
  const current = useSyncExternalStore(subscribe, snapshot, () => '/');
  const url = new URL(current, 'http://local');
  return parseRoute(url.pathname, url.search);
}
