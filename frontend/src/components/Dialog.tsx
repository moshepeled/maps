/**
 * Modal dialog shell (UX C-20 ... C-23, section 8.3): scrim, `aria-modal`, labelled by its title, focus trapped with an
 * explicit initial focus, focus returned to the invoker on close. `Esc` is handled by the caller (some dialogs cannot
 * be dismissed with it, UX C-21).
 */
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useEffect, useId, useRef } from 'react';

export interface DialogProps {
  role?: 'dialog' | 'alertdialog';
  title: ReactNode;
  titleTitle?: string;
  testId: string;
  initialFocus: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  children: ReactNode;
  wide?: boolean;
  attributes?: Record<string, string>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({
  role = 'dialog',
  title,
  titleTitle,
  testId,
  initialFocus,
  onEscape,
  children,
  wide = false,
  attributes,
}: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus.current ?? panel.current)?.focus();
    return () => {
      if (invoker?.isConnected === true) invoker.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape?.();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="scrim" role="presentation">
      <div
        ref={panel}
        className={`dialog${wide ? ' wide' : ''}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        {...attributes}
      >
        <h2 className="dialog-title" id={titleId} title={titleTitle}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
