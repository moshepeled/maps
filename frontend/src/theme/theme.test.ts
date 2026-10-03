/**
 * The theme contract of user decision D-5 (UX F-15, C-30, UX-AC-111 ... 113): dark by default, the OS setting ignored,
 * the stored choice applied and written, and a throwing storage never breaking anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import bootSource from '../../public/theme-boot.js?raw';
import { THEME_STORAGE_KEY } from '../constants/ux';
import type { ThemeEnv } from './theme';
import { parseTheme, THEME_SWITCHING_CLASS, ThemeController } from './theme';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

function setup(storage: () => Storage | null) {
  const root = document.createElement('html');
  const frames: (() => void)[] = [];
  const events = new EventTarget();
  const env: ThemeEnv = {
    root,
    storage,
    nextFrame: (callback) => {
      frames.push(callback);
    },
    events,
  };
  const controller = new ThemeController(env);
  return { controller, root, frames, events };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTheme', () => {
  it('accepts exactly dark and light', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    for (const value of ['sepia', 'Light', '', null, undefined, 1]) expect(parseTheme(value)).toBeNull();
  });
});

describe('ThemeController (D-5)', () => {
  it('UX-AC-111 boots dark with nothing stored, and html always carries data-theme', () => {
    const { controller, root } = setup(() => memoryStorage());
    expect(controller.boot()).toBe('dark');
    expect(root.dataset['theme']).toBe('dark');
    expect(controller.store.getState().theme).toBe('dark');
  });

  it('UX-AC-111 ignores the OS colour scheme: a light OS preference still boots dark', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes('light'), media: query }));
    vi.stubGlobal('matchMedia', matchMedia);
    const { controller, root } = setup(() => memoryStorage());
    controller.boot();
    expect(root.dataset['theme']).toBe('dark');
    expect(matchMedia).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('boots the stored light theme', () => {
    const { controller, root } = setup(() => memoryStorage({ [THEME_STORAGE_KEY]: 'light' }));
    expect(controller.boot()).toBe('light');
    expect(root.dataset['theme']).toBe('light');
  });

  it('UX-AC-113 an invalid stored value means dark', () => {
    const { controller, root } = setup(() => memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' }));
    controller.boot();
    expect(root.dataset['theme']).toBe('dark');
  });

  it('UX-AC-113 a storage that throws on read and write: dark, and a switch still applies for this page', () => {
    const { controller, root } = setup(throwingStorage);
    expect(() => controller.boot()).not.toThrow();
    expect(root.dataset['theme']).toBe('dark');
    expect(() => {
      controller.set('light');
    }).not.toThrow();
    expect(root.dataset['theme']).toBe('light');
    expect(controller.store.getState().theme).toBe('light');
  });

  it('a storage getter that throws (blocked site data) also means dark', () => {
    const { controller, root } = setup(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(controller.boot()).toBe('dark');
    expect(root.dataset['theme']).toBe('dark');
  });

  it('UX-AC-112 set() applies at once, writes the key and suppresses transitions for one frame', () => {
    const storage = memoryStorage();
    const { controller, root, frames } = setup(() => storage);
    controller.boot();
    controller.set('light');
    expect(root.dataset['theme']).toBe('light');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(root.classList.contains(THEME_SWITCHING_CLASS)).toBe(true);
    for (const frame of frames.splice(0)) frame();
    expect(root.classList.contains(THEME_SWITCHING_CLASS)).toBe(false);
    controller.set('dark');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.dataset['theme']).toBe('dark');
  });

  it('follows a change made in another tab (storage event), and a cleared storage returns to dark', () => {
    const { controller, root, events } = setup(() => memoryStorage());
    controller.boot();
    events.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }));
    expect(root.dataset['theme']).toBe('light');
    events.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'dark' }));
    expect(root.dataset['theme']).toBe('light');
    events.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
    expect(root.dataset['theme']).toBe('dark');
    controller.dispose();
    events.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }));
    expect(root.dataset['theme']).toBe('dark');
  });
});

describe('public/theme-boot.js (before first paint, CSP-safe)', () => {
  /** Runs the classic script the way the browser does: global scope, the real (jsdom) window and document. */
  function runBoot(): string | undefined {
    delete document.documentElement.dataset['theme'];
    // Indirect eval = global scope, like a <script src> without type="module".
    (0, eval)(bootSource);
    return document.documentElement.dataset['theme'];
  }

  afterEach(() => {
    localStorage.clear();
  });

  it('uses the same key and values as the controller', () => {
    expect(bootSource).toContain(`'${THEME_STORAGE_KEY}'`);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(runBoot()).toBe('light');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(runBoot()).toBe('dark');
  });

  it('falls back to dark for nothing stored and for an invalid value', () => {
    expect(runBoot()).toBe('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(runBoot()).toBe('dark');
  });

  it('falls back to dark when reading the storage throws', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(runBoot()).toBe('dark');
  });
});
