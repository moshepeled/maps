/**
 * The People section (UX C-28, section 6.1): the presence list at >= 600 px (`presence-list`; phones use the popover).
 * `P`, the rail's *People* and `presence-button` expand it, scroll it into view and - by keyboard - focus its header.
 */
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';

import { useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { sectionExpanded } from '../../state/workspaceStore';
import { PresenceRows, usePresenceUsers } from '../presence/Presence';
import { useFocusTarget } from '../useFocusTarget';
import { SectionHeader } from './SectionHeader';

export function PeopleSection() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const expanded = useStore(stores.workspace, (state) => sectionExpanded(state, 'people'));
  const reveal = useStore(stores.workspace, (state) => state.revealRequest);
  const users = usePresenceUsers();
  const live = useStore(stores.connection, (state) => state.state === 'live');
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useFocusTarget('people-header', toggle);
  useEffect(() => {
    if (reveal?.section !== 'people') return;
    section.current?.scrollIntoView({ block: 'nearest' });
  }, [reveal]);
  return (
    <section ref={section} className="insp-section" data-testid="people-section" data-expanded={expanded}>
      <SectionHeader
        label={base.inspector.people}
        count={users.length}
        expanded={expanded}
        bodyId="people-body"
        testId="people-toggle"
        buttonRef={toggle}
        onToggle={() => {
          workspace.toggleSection('people');
        }}
        trailing={
          // [N] The live note (UI.md section 10.8.6): the list is live, not the 15 s Limited snapshot.
          live ? (
            <span className="people-live">
              <span className="people-live__dot" aria-hidden="true" />
              {base.presence.liveNote}
            </span>
          ) : null
        }
      />
      <div id="people-body" className="insp-body insp-body--list" hidden={!expanded}>
        {expanded ? <PresenceRows users={users} /> : null}
      </div>
    </section>
  );
}
