/**
 * Toasts (UX C-18): two lanes - own results (max 3; phones 1) and collaboration (max 1). The store holds data only;
 * timers (auto-dismiss, pause on hover/focus/hidden tab) live in the Toasts component. The own-lane cap is applied
 * here, not in the view: a toast that is only hidden keeps no timer and would resurface later with a fresh Undo, and
 * its Undo would never reach *Undo last action* (UX section 3.2).
 */
import { createStore } from 'zustand/vanilla';

export type ToastLane = 'own' | 'collab';
/** `toast[data-kind]` (UX section 12). */
export type ToastKind = 'info' | 'undo' | 'error' | 'collab' | 'countdown';

export interface ToastAction {
  kind: 'undo' | 'retry' | 'show';
  label: string;
  /** `viaKeyboard`: the action came from the keyboard (Enter / Space on the button, `Ctrl+Z`), for focus (section 8.3). */
  run: (viaKeyboard?: boolean) => void;
}

export interface Toast {
  id: string;
  lane: ToastLane;
  kind: ToastKind;
  /** The copy key (`toast[data-code]`). */
  code: string;
  text: string;
  /** The phone variant for toasts with an action (<= 70 characters of fixed text, UX section 9). */
  shortText?: string;
  action?: ToastAction;
  /** Auto-dismiss after this long; null = persistent (errors, countdowns). */
  durationMs: number | null;
  createdAt: number;
  actor?: { displayName: string; color: string };
  /** Countdown toasts: the moment the pending action fires. */
  countdownUntil?: number;
  /** Countdown toasts: the text for the remaining wait (re-rendered every second). */
  countdownText?: (wait: string) => string;
}

/** The own lane's cap: 3 stacked toasts, 1 on phones (UX C-18, section 3.2). */
export const OWN_MAX = 3;
export const OWN_MAX_PHONE = 1;

export interface ToastsState {
  toasts: readonly Toast[];
  /** Undo actions of toasts replaced before expiry (UX section 3.2 "Undo last action" menu item). */
  lastUndo: { text: string; run: (viaKeyboard?: boolean) => void; expiresAt: number } | null;
  /** `ownMax`: how many own toasts may show at once (the caller knows the layout); older ones are dropped. */
  push(toast: Omit<Toast, 'id' | 'createdAt'>, now: number, ownMax?: number): string;
  update(id: string, patch: Partial<Omit<Toast, 'id'>>): void;
  dismiss(id: string): void;
  dismissByCode(code: string): void;
  clearLastUndo(): void;
}

let counter = 0;

export function createToastsStore() {
  return createStore<ToastsState>()((set, get) => ({
    toasts: [],
    lastUndo: null,
    push: (toast, now, ownMax = OWN_MAX) => {
      counter += 1;
      const id = `t-${counter}`;
      const next: Toast = { ...toast, id, createdAt: now };
      const existing = get().toasts;
      let lastUndo = get().lastUndo;
      let kept: Toast[];
      if (toast.lane === 'collab') {
        kept = existing.filter((item) => item.lane !== 'collab');
      } else {
        const own = existing.filter((item) => item.lane === 'own');
        const overflow = own.length + 1 - Math.max(1, ownMax);
        const dropped = overflow > 0 ? own.slice(0, overflow) : [];
        for (const item of dropped) {
          // The replaced Undo stays reachable from the user menu until its own time is up (never a fresh 10 s).
          if (item.action?.kind === 'undo' && item.durationMs !== null) {
            lastUndo = { text: item.text, run: item.action.run, expiresAt: item.createdAt + item.durationMs };
          }
        }
        kept = existing.filter((item) => !dropped.includes(item));
      }
      set({ toasts: [...kept, next], lastUndo });
      return id;
    },
    update: (id, patch) => {
      set({ toasts: get().toasts.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)) });
    },
    dismiss: (id) => {
      set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
    },
    dismissByCode: (code) => {
      set({ toasts: get().toasts.filter((toast) => toast.code !== code) });
    },
    clearLastUndo: () => {
      set({ lastUndo: null });
    },
  }));
}

export type ToastsStoreApi = ReturnType<typeof createToastsStore>;
