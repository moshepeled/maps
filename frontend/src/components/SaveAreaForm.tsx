/**
 * The save form (UX C-09, F-03 steps 6-9; UI.md section 10.8.4, section 10.13): Name (required, autofocus, `dir="auto"`),
 * Description (optional; phones keep it behind *+ Add description*), the area in km² and ha, *Save area* with its
 * saving / countdown / offline states, *Back to drawing* and *Discard*. Lengths count code points after sanitising,
 * like the server.
 */
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { useRef } from 'react';
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import { formatArea, formatAreaParts, formatCountdown, formatHectares, formatPerimeter } from '../lib/format';
import { sanitizedLength } from '../lib/text';
import { deriveDrawing } from '../state/drawingReducer';
import { descriptionMaxLength, drawingLimits, nameMaxLength } from '../state/runtimeConfigStore';
import { geometryReason } from '../workspace/hudCopy';
import { Icon } from './Icon';
import { useFocusTarget } from './useFocusTarget';

export function SaveAreaForm() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const naming = useStore(stores.drawing, (state) => state.naming);
  const save = useStore(stores.drawing, (state) => state.save);
  const serverInvalid = useStore(stores.drawing, (state) => state.serverInvalid);
  const drawing = useStore(stores.drawing, (state) => state.drawing);
  const config = useStore(stores.runtime, (state) => state.config);
  const connection = useStore(stores.connection, (state) => state.state);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const phone = usePhone();
  const nameRef = useRef<HTMLInputElement>(null);
  useFocusTarget('name-input', nameRef);
  const view = deriveDrawing(drawing, drawingLimits(config));
  const parts = view.areaKm2 === null ? null : formatAreaParts(view.areaKm2);
  const nameMax = nameMaxLength(config);
  const descriptionMax = descriptionMaxLength(config);
  const nameLength = sanitizedLength(naming.name);
  const descriptionLength = sanitizedLength(naming.description, true);
  const offline = connection === 'offline';
  const saving = save.kind === 'saving';
  const countdown = save.kind === 'countdown' ? save.until : null;
  const submitLabel =
    countdown !== null
      ? base.rate.saveButton(formatCountdown(countdown - now))
      : saving
        ? base.save.saving
        : base.save.submit;
  const submit = (viaKeyboard: boolean): void => {
    if (offline) return;
    workspace.drawing.save(viaKeyboard);
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) {
      event.preventDefault();
      submit(true);
    }
  };
  const readOnly = saving || countdown !== null;
  const discardButton = (
    <button
      type="button"
      className={`btn btn-danger-ghost${phone ? '' : ' push'}`}
      data-testid="discard-draft"
      onClick={() => {
        workspace.drawing.cancel();
      }}
    >
      {base.save.discard}
    </button>
  );
  const saveButton = (
    <button
      type="submit"
      className={`btn btn-primary${phone ? ' btn-lg' : ''}`}
      data-testid="save-area-submit"
      aria-disabled={offline || readOnly}
      aria-describedby={offline ? 'save-offline' : countdown !== null ? 'save-rate' : undefined}
      onClick={(event) => {
        event.preventDefault();
        submit(event.detail === 0);
      }}
    >
      {saving && countdown === null ? <span className="spinner xs" aria-hidden="true" /> : null}
      {submitLabel}
    </button>
  );
  const backButton =
    countdown !== null ? (
      <button
        type="button"
        className={`btn btn-ghost${phone ? ' btn-lg' : ''}`}
        onClick={() => {
          workspace.drawing.cancelSaveCountdown();
        }}
      >
        {base.rate.cancel}
      </button>
    ) : (
      <button
        type="button"
        className={`btn btn-secondary${phone ? ' btn-lg' : ''}`}
        data-testid="back-to-drawing"
        onClick={() => {
          workspace.drawing.backToDrawing();
        }}
      >
        {base.save.back}
      </button>
    );
  return (
    <form
      className="save-form"
      data-testid="save-area-form"
      noValidate
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      aria-labelledby="save-title"
    >
      {/* Desktop: the primary slot's kicker header. Phone naming sheet: "Save area, 0.139 km²" + Discard (section 10.13). */}
      {phone ? (
        <div className="save-form__head">
          <h2 id="save-title" className="save-form__title">
            {base.save.title}
            {view.areaKm2 !== null ? <span className="num"> · {formatArea(view.areaKm2)}</span> : null}
          </h2>
          {discardButton}
        </div>
      ) : (
        <div className="insp-head insp-head--primary">
          <h2 id="save-title" className="insp-kicker micro">
            {base.save.title}
          </h2>
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="area-name">
          {base.save.name}
        </label>
        <input
          ref={nameRef}
          id="area-name"
          className="input"
          data-testid="area-name-input"
          dir="auto"
          autoComplete="off"
          placeholder={base.save.namePlaceholder}
          value={naming.name}
          readOnly={readOnly}
          aria-invalid={naming.nameError !== null}
          aria-describedby={naming.nameError !== null ? 'area-name-error' : undefined}
          onChange={(event) => {
            stores.drawing.getState().patchNaming({ name: event.target.value, nameError: null });
          }}
        />
        {nameLength >= Math.floor(nameMax * 0.8) ? (
          <p className="counter">{base.save.charCount(nameLength, nameMax)}</p>
        ) : null}
        {naming.nameError !== null ? (
          <p className="field-error" id="area-name-error">
            <Icon name="circle-alert" size="sm" />
            <span>{naming.nameError}</span>
          </p>
        ) : null}
      </div>
      {phone && !naming.descriptionOpen ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost add-description"
          data-testid="add-description-button"
          onClick={() => {
            stores.drawing.getState().patchNaming({ descriptionOpen: true });
          }}
        >
          {base.save.addDescription}
        </button>
      ) : (
        <div className="field">
          <label className="label" htmlFor="area-description">
            {base.save.description} <span className="opt">{base.save.optional}</span>
          </label>
          <textarea
            id="area-description"
            className="input"
            data-testid="area-description-input"
            dir="auto"
            value={naming.description}
            readOnly={readOnly}
            aria-invalid={naming.descriptionError !== null}
            aria-describedby={naming.descriptionError !== null ? 'area-description-error' : undefined}
            onChange={(event) => {
              stores.drawing
                .getState()
                .patchNaming({ description: event.target.value, descriptionError: null });
            }}
          />
          {descriptionLength >= Math.floor(descriptionMax * 0.8) ? (
            <p className="counter">{base.save.charCount(descriptionLength, descriptionMax)}</p>
          ) : null}
          {naming.descriptionError !== null ? (
            <p className="field-error" id="area-description-error">
              <Icon name="circle-alert" size="sm" />
              <span>{naming.descriptionError}</span>
            </p>
          ) : null}
        </div>
      )}
      {phone ? null : (
        <div className="save-well">
          <span className="micro">{base.save.area}</span>
          <span className="save-well__figure">
            {parts === null ? (
              base.draw.readoutEmpty
            ) : (
              <>
                <span className="num">{parts.value}</span> <span className="unit">{parts.unit}</span>
              </>
            )}
          </span>
          {view.areaKm2 === null ? null : (
            <span className="save-well__meta num">
              {formatHectares(view.areaKm2)}
              {view.perimeterKm === null ? '' : ` · ${formatPerimeter(view.perimeterKm)}`}
            </span>
          )}
        </div>
      )}
      {serverInvalid !== null ? (
        <p className="banner danger" role="alert">
          <Icon name="circle-alert" />
          <span>{base.save.serverInvalid(geometryReason(serverInvalid.code))}</span>
        </p>
      ) : null}
      {/* Phones put the primary last (Back, Save, 50/50); the inspector leads with it and pushes Discard right. */}
      <div className="form-actions save-form__actions">
        {phone ? (
          <>
            {backButton}
            {saveButton}
          </>
        ) : (
          <>
            {saveButton}
            {backButton}
            {discardButton}
          </>
        )}
      </div>
      {offline ? (
        <p className="hint" id="save-offline">
          {base.conn.offlineSaveDisabled}
        </p>
      ) : null}
      {countdown !== null ? (
        <p className="hint" id="save-rate">
          {base.rate.help}
        </p>
      ) : null}
    </form>
  );
}
