/**
 * The tooltip of an options-bar / HUD button whose text label the narrow bar hides (UX C-05, UI.md section 9 narrow bars):
 * the icon alone is not a label, so like the rail's tools (UX-AC-116) it shows its label on hover (after the tooltip
 * delay) and on keyboard focus, stays while the pointer is over it, and `Esc` dismisses it (WCAG 1.4.13). It only
 * appears while the button's `.btn-label` is actually collapsed; a native `title` never shows on focus or touch.
 *
 * The tooltip reads like the rail's, "{label}, {key}". It is inside the button and `aria-hidden`: the button's
 * accessible name is already its (visually hidden) label, so the tooltip is a visual aid only.
 */
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { TOOLTIP_DELAY_MS } from '../../constants/ux';

/** `:focus-visible` (keyboard focus): only then does focus open the tooltip - a click must not leave one behind. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Whether the narrow-bar CSS has collapsed the button to its icon (the label is clipped to 1 px). */
function labelCollapsed(button: Element): boolean {
  const label = button.querySelector('.btn-label');
  return label !== null && label.getBoundingClientRect().width < 2;
}

export interface CollapsedTip {
  handlers: {
    onMouseEnter: (event: MouseEvent<HTMLButtonElement>) => void;
    onMouseLeave: () => void;
    onFocus: (event: FocusEvent<HTMLButtonElement>) => void;
    onBlur: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
  /** Render inside the button. */
  tip: ReactNode;
  hide: () => void;
}

export function useCollapsedTip(label: string, key: string | null = null): CollapsedTip {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const hide = (): void => {
    clear();
    setShown(false);
  };
  return {
    handlers: {
      onMouseEnter: (event) => {
        const button = event.currentTarget;
        clear();
        timer.current = setTimeout(() => {
          if (labelCollapsed(button)) setShown(true);
        }, TOOLTIP_DELAY_MS);
      },
      onMouseLeave: hide,
      onFocus: (event) => {
        if (focusVisible(event.currentTarget) && labelCollapsed(event.currentTarget)) setShown(true);
      },
      onBlur: hide,
      onKeyDown: (event) => {
        // Esc dismisses the tooltip without moving focus - and without also leaving the mode (UX section 8.1).
        if (event.key === 'Escape' && shown) {
          event.preventDefault();
          event.stopPropagation();
          hide();
        }
      },
    },
    tip: shown ? (
      <span
        className="tooltip btn-tip"
        role="tooltip"
        aria-hidden="true"
        onClick={(event) => {
          // Part of the button's box so the pointer can rest on it; a click on the tooltip is not a press.
          event.stopPropagation();
        }}
      >
        {key === null ? label : `${label} · `}
        {key === null ? null : <kbd>{key}</kbd>}
      </span>
    ) : null,
    hide,
  };
}
