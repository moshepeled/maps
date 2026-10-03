/**
 * The History section (UX C-13 v2): under Selection, rendered only while an area's details are shown. Its header is
 * the disclosure button `history-tab` (v1.2's tab became a section toggle); expanded by default at >= 600 px and
 * collapsed by default in the phone sheet, the state kept for the session. A collapsed section loads nothing.
 * In the phone sheet the header is plain text: the sheet's *History* action (`history-tab` there) toggles it.
 */
import { useStore } from 'zustand';

import { useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { sectionExpanded } from '../../state/workspaceStore';
import { HistoryList } from '../HistoryList';
import { SectionHeader } from './SectionHeader';

export function HistorySection({ variant }: { variant: 'section' | 'sheet' }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const areaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  const panel = useStore(stores.workspace, (state) => state.panel);
  const detail = useStore(stores.workspace, (state) => state.detail);
  const expanded = useStore(stores.workspace, (state) => sectionExpanded(state, 'history'));
  const recordVersion = useStore(stores.areas, (state) =>
    areaId === null ? 0 : (state.byId.get(areaId)?.version ?? 0),
  );
  if (areaId === null || panel !== 'area') return null;
  if (detail?.areaId === areaId && detail.status === 'deleted') return null;
  const detailVersion = detail?.areaId === areaId && detail.status === 'ready' ? detail.area.version : 0;
  const version = Math.max(recordVersion, detailVersion);
  return (
    <section className="insp-section" data-testid="history-section" data-expanded={expanded}>
      {variant === 'section' ? (
        <SectionHeader
          label={base.inspector.history}
          count={version}
          expanded={expanded}
          bodyId="history-body"
          testId="history-tab"
          onToggle={() => {
            workspace.area.toggleHistory();
          }}
        />
      ) : (
        <div className="insp-head">
          <h2 className="insp-head__title insp-head__title--static">
            <span className="micro">{base.inspector.history}</span>
            <span className="count-tag num">{version}</span>
          </h2>
        </div>
      )}
      <div id="history-body" className="insp-body insp-body--list" hidden={!expanded}>
        {expanded ? <HistoryList areaId={areaId} currentVersion={version} /> : null}
      </div>
    </section>
  );
}
