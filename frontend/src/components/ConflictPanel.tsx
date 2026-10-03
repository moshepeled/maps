/**
 * The conflict panel (UX C-19, F-09 step 3; UI.md section 10.8.5): what happened, both shapes on the map with a legend and
 * show toggles (shape conflicts), and the four choices - *Keep mine*, *Take theirs*, *Review differences* (a real
 * table with one radio group per conflicting field), *Decide later*. Focus lands on the heading; only
 * `sr.conflictAlert` goes to the alert region (the flow announces it).
 */
import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { useStore } from 'zustand';

import type { MergeField } from '@snapland/shared';
import { geodesicArea } from '@snapland/shared';

import { useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import { formatArea } from '../lib/format';
import { displayName, displayUser } from '../lib/text';
import type { ConflictState } from '../state/workspaceStore';
import { Icon } from './Icon';
import { useFocusTarget } from './useFocusTarget';

const FIELD_LABEL: Record<MergeField, string> = {
  geometry: base.conflict.fieldShape,
  name: base.conflict.fieldName,
  description: base.conflict.fieldDescription,
};

function valueOf(conflict: ConflictState, field: MergeField, side: 'mine' | 'theirs'): string {
  if (field === 'geometry') {
    const rings = side === 'mine' ? conflict.mine.rings : conflict.current.geometry.coordinates;
    return rings === undefined ? '—' : formatArea(geodesicArea(rings));
  }
  if (field === 'name')
    return side === 'mine' ? (conflict.mine.name ?? conflict.current.name) : conflict.current.name;
  const text = side === 'mine' ? conflict.mine.description : conflict.current.description;
  return text ?? '—';
}

/**
 * One legend row (UI.md section 10.8.5): a swatch drawn like the line on the map - mine is the "me" core, theirs is dashed
 * in their colour, both on the dark casing - the label, the km² and an eye toggle that shows or hides that shape.
 */
function LegendRow({
  label,
  km2,
  toggleLabel,
  shown,
  theirsColor,
  onToggle,
}: {
  label: string;
  km2: string;
  toggleLabel: string;
  shown: boolean;
  theirsColor?: string;
  onToggle: () => void;
}) {
  const theirs = theirsColor !== undefined;
  return (
    <div className="lg-row" style={theirs ? ({ '--c': theirsColor } as CSSProperties) : undefined}>
      <svg className="lg-swatch" viewBox="0 0 28 10" aria-hidden="true">
        <path className="lg-swatch__casing" d="M3 5h22" />
        <path className={`lg-swatch__core${theirs ? ' lg-swatch__core--theirs' : ''}`} d="M3 5h22" />
      </svg>
      <span className="grow">{label}</span>
      <span className="lg-km num">{km2}</span>
      <button
        type="button"
        className="icon-btn lg-toggle"
        aria-label={toggleLabel}
        aria-pressed={shown}
        onClick={onToggle}
      >
        <Icon name="eye" />
      </button>
    </div>
  );
}

export function ConflictPanel() {
  const workspace = useWorkspace();
  const conflict = useStore(workspace.ctx.stores.workspace, (state) => state.conflict);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewCaption = useRef<HTMLTableCaptionElement>(null);
  useFocusTarget('conflict-heading', heading);
  useFocusTarget('conflict-review', reviewCaption);
  if (conflict === null) return null;
  const theirsUser = conflict.current.updatedBy;
  const user = displayUser(theirsUser.displayName);
  const name = displayName(conflict.current.name);
  const mineFields: MergeField[] = [
    ...(conflict.mine.rings !== undefined ? (['geometry'] as const) : []),
    ...(conflict.mine.name !== undefined ? (['name'] as const) : []),
    ...(conflict.mine.description !== undefined ? (['description'] as const) : []),
  ];
  const rows: MergeField[] = [
    ...new Set<MergeField>([...conflict.conflictingFields, ...mineFields, ...conflict.serverChangedFields]),
  ];
  return (
    <section
      className="conflict-panel"
      data-testid="conflict-panel"
      role="region"
      aria-labelledby="conflict-title"
    >
      {/* The primary slot keeps its Selection title (UX C-28); no close: *Decide later* is in the body. */}
      <div className="insp-head insp-head--primary">
        <span className="insp-kicker micro" aria-hidden="true">
          {base.inspector.selection}
        </span>
      </div>
      <div className="conflict-body">
        <div className="cf-title">
          <Icon name="git-merge" size="lg" />
          <h2 id="conflict-title" ref={heading} tabIndex={-1}>
            {base.conflict.title(user, name)}
          </h2>
        </div>
        <p className="cf-body">
          {conflict.changedAgain ? base.conflict.changedAgain(user) : base.conflict.body}
        </p>
        {conflict.origin === 'shape' ? (
          <div className="legend">
            <LegendRow
              label={base.conflict.legendMine}
              km2={valueOf(conflict, 'geometry', 'mine')}
              toggleLabel={base.conflict.showMine}
              shown={conflict.showMine}
              onToggle={() => {
                workspace.conflict.toggleShow('mine');
              }}
            />
            <LegendRow
              label={base.conflict.legendTheirs(user)}
              km2={valueOf(conflict, 'geometry', 'theirs')}
              toggleLabel={base.conflict.showTheirs}
              shown={conflict.showTheirs}
              theirsColor={theirsUser.color}
              onToggle={() => {
                workspace.conflict.toggleShow('theirs');
              }}
            />
          </div>
        ) : null}
        {conflict.reviewing ? (
          <>
            <table className="diff">
              {/* The review's name, and where focus lands when it replaces the buttons (UX section 8.3). */}
              <caption ref={reviewCaption} className="diff-caption micro" tabIndex={-1}>
                {base.conflict.review}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{base.conflict.colField}</th>
                  <th scope="col">{base.conflict.colYours}</th>
                  <th scope="col">{base.conflict.colTheirs(user, conflict.current.version)}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((field) => {
                  const conflicting = conflict.conflictingFields.includes(field);
                  const choice = conflict.choices[field] ?? 'mine';
                  return (
                    <tr key={field} data-testid="conflict-field-row" data-field={field}>
                      <th scope="row">{FIELD_LABEL[field]}</th>
                      {conflicting ? (
                        <>
                          <td>
                            <fieldset className="radio-group">
                              <legend className="sr-only">{FIELD_LABEL[field]}</legend>
                              <label className="radio">
                                <input
                                  type="radio"
                                  name={`choice-${field}`}
                                  checked={choice === 'mine'}
                                  onChange={() => {
                                    workspace.conflict.choose(field, 'mine');
                                  }}
                                />
                                <bdi>{valueOf(conflict, field, 'mine')}</bdi>
                              </label>
                            </fieldset>
                          </td>
                          <td>
                            <label className="radio">
                              <input
                                type="radio"
                                name={`choice-${field}`}
                                checked={choice === 'theirs'}
                                onChange={() => {
                                  workspace.conflict.choose(field, 'theirs');
                                }}
                              />
                              <bdi>{valueOf(conflict, field, 'theirs')}</bdi>
                            </label>
                          </td>
                        </>
                      ) : (
                        <td colSpan={2} className="merged">
                          <Icon name="circle-check" size="sm" />
                          {base.conflict.mergedAuto}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="cf-actions">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="conflict-save-merged"
                aria-disabled={conflict.saving}
                onClick={() => {
                  workspace.conflict.saveMerged();
                }}
              >
                {base.conflict.saveMerged}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                data-testid="conflict-later"
                onClick={() => {
                  workspace.conflict.decideLater();
                }}
              >
                {base.conflict.later}
              </button>
            </div>
          </>
        ) : (
          <div className="cf-actions">
            <div className="cf-act">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="conflict-keep-mine"
                aria-disabled={conflict.saving}
                onClick={() => {
                  workspace.conflict.keepMine();
                }}
              >
                {base.conflict.keepMine}
              </button>
              <p className="help">{base.conflict.keepMineHelp(user)}</p>
            </div>
            <div className="cf-act">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="conflict-take-theirs"
                onClick={() => {
                  workspace.conflict.takeTheirs();
                }}
              >
                {base.conflict.takeTheirs}
              </button>
              <p className="help">{base.conflict.takeTheirsHelp(user)}</p>
            </div>
            <div className="cf-act">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="conflict-review"
                onClick={() => {
                  workspace.conflict.review();
                }}
              >
                {base.conflict.review}
              </button>
              <p className="help">{base.conflict.reviewHelp}</p>
            </div>
            <div className="cf-act">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                data-testid="conflict-later"
                onClick={() => {
                  workspace.conflict.decideLater();
                }}
              >
                {base.conflict.later}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
