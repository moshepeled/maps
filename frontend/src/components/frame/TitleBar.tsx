/**
 * The title bar (UX C-02, v2; UI.md section 10.2): the `header` banner landmark. Brand, connection pill, the Quiet chip
 * (>= 600 px; phones show a badge on the menu button), presence and the user menu. The v1.2 top-bar shortcuts button
 * moved to the tool rail (C-03), so the bar has three tab stops: pill, presence, menu (UX section 8.2).
 */
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { BrandMark, Icon } from '../Icon';
import { PresenceButton } from '../presence/Presence';
import { ConnectionPill } from './ConnectionPill';
import { UserMenu } from './UserMenu';

export function TitleBar() {
  const workspace = useWorkspace();
  const quiet = useStore(workspace.ctx.stores.workspace, (ws) => ws.quietMode);
  const phone = usePhone();
  return (
    <header className="titlebar" data-testid="title-bar">
      <div className="brand">
        <BrandMark size={phone ? 28 : 24} />
        <span className="wordmark">Snapland</span>
      </div>
      <ConnectionPill />
      {quiet && !phone ? (
        <span className="chip-quiet" data-testid="quiet-chip">
          <Icon name="bell-off" size="xs" />
          <span>{base.quiet.chip}</span>
        </span>
      ) : null}
      <div className="titlebar__spacer" />
      <PresenceButton phone={phone} />
      {phone ? null : <span className="titlebar__divider" aria-hidden="true" />}
      <UserMenu />
    </header>
  );
}
