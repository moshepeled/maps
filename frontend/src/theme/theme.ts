/**
 * The colour theme (user decision D-5; UX F-15 / C-30; UI.md section 13). Dark is the default, light is a per-browser choice
 * stored in `localStorage['snapland.theme']`, and the OS `prefers-color-scheme` setting is deliberately ignored.
 * `<html>` always carries `data-theme="dark" | "light"`: `public/theme-boot.js` sets it before the first paint (the
 * CSP forbids inline scripts), and `boot()` applies it again when the app starts, so environments without the boot
 * script (tests, a stale cached `index.html`) still end up in the right theme.
 *
 * Every storage access is wrapped in try/catch: a blocked or throwing storage means dark for reading and "applies
 * for this page only" for writing, never an error.
 */
import { createStore } from 'zustand/vanilla';

import { THEME_DEFAULT, THEME_STORAGE_KEY } from '../constants/ux';

export type Theme = 'dark' | 'light';

export interface ThemeState {
  theme: Theme;
}

/** `dark` / `light`, or null for anything else (a missing key, `"sepia"`, `null`). */
export function parseTheme(value: unknown): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

export interface ThemeEnv {
  root: HTMLElement;
  /** May itself throw (e.g. `localStorage` access blocked by site settings). */
  storage: () => Storage | null;
  nextFrame: (callback: () => void) => void;
  /** Where `storage` events arrive from (other tabs of this browser follow a change, UX F-15 step 5). */
  events: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

/** Class set on `<html>` for one frame while the theme changes, so hover transitions do not animate every colour. */
export const THEME_SWITCHING_CLASS = 'theme-switching';

export class ThemeController {
  readonly store = createStore<ThemeState>()(() => ({ theme: THEME_DEFAULT }));
  private listening = false;

  constructor(private readonly env: ThemeEnv) {}

  /** The stored choice, or the default when nothing valid is stored or the storage is unavailable. */
  read(): Theme {
    try {
      return parseTheme(this.env.storage()?.getItem(THEME_STORAGE_KEY)) ?? THEME_DEFAULT;
    } catch {
      return THEME_DEFAULT;
    }
  }

  /** Applies the stored theme and starts following changes made in other tabs. Idempotent. */
  boot(): Theme {
    const theme = this.read();
    this.apply(theme);
    if (!this.listening && this.env.events !== null) {
      this.env.events.addEventListener('storage', this.onStorage);
      this.listening = true;
    }
    return theme;
  }

  /** The user's choice (user menu, C-30): applied at once, then stored on a best-effort basis. */
  set(theme: Theme): void {
    const { root } = this.env;
    root.classList.add(THEME_SWITCHING_CLASS);
    this.apply(theme);
    try {
      this.env.storage()?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage unavailable: the theme still applies for the rest of this page's life (UX F-15 step 3).
    }
    this.env.nextFrame(() => {
      root.classList.remove(THEME_SWITCHING_CLASS);
    });
  }

  dispose(): void {
    if (!this.listening || this.env.events === null) return;
    this.env.events.removeEventListener('storage', this.onStorage);
    this.listening = false;
  }

  private apply(theme: Theme): void {
    this.env.root.dataset['theme'] = theme;
    if (this.store.getState().theme !== theme) this.store.setState({ theme });
  }

  private readonly onStorage = (event: StorageEvent): void => {
    // `key === null` means the whole storage was cleared: back to the default.
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    this.apply(parseTheme(event.newValue) ?? THEME_DEFAULT);
  };
}

function browserStorage(): Storage | null {
  return globalThis.localStorage;
}

let shared: ThemeController | null = null;

/** The page's theme controller (one per document). */
export function themeController(): ThemeController {
  shared ??= new ThemeController({
    root: document.documentElement,
    storage: browserStorage,
    nextFrame: (callback) => {
      globalThis.requestAnimationFrame(callback);
    },
    events: globalThis.window,
  });
  return shared;
}
