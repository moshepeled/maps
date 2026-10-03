/**
 * A collapsible inspector section header (UX C-28; UI.md section 10.8.1): a heading holding a disclosure button with
 * `aria-expanded` / `aria-controls`, named by the section and its count ("History, 3"). The chevron is decorative.
 * Toggling keeps focus on the button. Trailing content (a note, icon buttons) sits outside the button.
 */
import type { ReactNode, RefObject } from 'react';

import { base } from '../../base/en';
import { Icon } from '../Icon';

export function SectionHeader({
  label,
  count,
  expanded,
  bodyId,
  testId,
  buttonRef,
  onToggle,
  trailing,
}: {
  label: string;
  count: number;
  expanded: boolean;
  bodyId: string;
  testId: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="insp-head">
      <h2 className="insp-head__title">
        <button
          ref={buttonRef}
          type="button"
          className="insp-toggle"
          data-testid={testId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={base.inspector.sectionName(label, count)}
          onClick={onToggle}
        >
          <Icon name="chevron-down" size="sm" className="insp-toggle__chevron" />
          <span className="micro">{label}</span>
          <span className="count-tag num">{count}</span>
        </button>
      </h2>
      {trailing}
    </div>
  );
}
