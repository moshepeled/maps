/**
 * `localStorage` access that never throws (private windows, quota, disabled storage): reads fall back to null and
 * writes are best effort (UX F-02 step 2 "try/catch"). Values are JSON and validated by the caller.
 */

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key) ?? null;
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort: a full or disabled storage must never break the app.
  }
}

export function removeKey(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Best effort.
  }
}

/** Keys under the app prefix (used to prune expired local drafts). */
export function keysWithPrefix(prefix: string): string[] {
  try {
    const store = storage();
    if (store === null) return [];
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix) === true) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
