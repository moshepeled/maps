/**
 * Key-hint rendering (UX C-05, C-29, section 9.15): a key chip and its label. Hint groups are `aria-hidden` - the same
 * shortcuts are exposed through `aria-keyshortcuts` on the controls and in the shortcuts dialog, so screen readers do
 * not hear them twice. `{Key}` tokens inside `.short` copy render as chips too (`KeyText`).
 */
import { Fragment } from 'react';

import { platformKeys } from '../../lib/platform';
import type { KeyHint } from './hintRules';

export function KeyHints({
  hints,
  className = '',
  testId,
  attributes,
}: {
  hints: readonly KeyHint[];
  className?: string;
  testId?: string;
  attributes?: Record<string, string>;
}) {
  return (
    <span className={`key-hints ${className}`.trim()} data-testid={testId} aria-hidden="true" {...attributes}>
      {hints.map((hint) => (
        <span
          key={`${hint.chip}-${hint.label}`}
          className={`key-hint${hint.wide === true ? ' key-hint--wide' : ''}`}
        >
          <kbd>{platformKeys(hint.chip)}</kbd>
          <span className="key-hint__label">{hint.label}</span>
        </span>
      ))}
    </span>
  );
}

/** Copy with `{Key}` tokens, e.g. "{Space} add point, {Enter} finish": the tokens become key chips. */
export function KeyText({ text }: { text: string }) {
  const parts = text.split(/\{(\w+)\}/u);
  return (
    <>
      {parts.map((part, index) =>
        // Odd indexes are the captured key names.
        index % 2 === 1 ? (
          <kbd key={`k${index}`}>{part}</kbd>
        ) : part === '' ? null : (
          <Fragment key={`t${index}`}>{part}</Fragment>
        ),
      )}
    </>
  );
}
