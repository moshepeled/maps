/**
 * Sign in / create account (UX F-01, C-01, section 9.1; SPEC section 6.2). One column card; server errors in an error summary
 * (`role="alert"`), field errors inline and linked with `aria-describedby`; password managers work (real `name` /
 * `autocomplete`, paste allowed, Show/Hide instead of a confirm field - WCAG 3.3.7 / 3.3.8).
 */
import type { InputHTMLAttributes, Ref, SyntheticEvent } from 'react';
import { useId, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { useServices } from '../app/AppContext';
import { navigate } from '../app/router';
import { BrandMark, Icon } from '../components/Icon';
import { DISPLAY_NAME_MAX } from '../constants/ux';
import { base } from '../base/en';
import { formatCountdown } from '../lib/format';
import { sanitizedLength } from '../lib/text';
import type { AuthFailure } from './authErrors';
import { classifyAuthError, displayNameToSend, summaryText, validateSignUp } from './authErrors';

type Field = 'username' | 'displayName' | 'password';

export interface LoginPageProps {
  mode: 'signin' | 'signup';
  /** Where to go after success (`?next=`). */
  next: string;
  /** Shows `auth.signedOut` after a sign-out (UX F-14 step 2). */
  signedOut?: boolean;
}

/**
 * A password input with its *Show password* / *Hide password* text button inside the field (UX-AC-03, WCAG 3.3.8;
 * UI.md section 10.12, section 10.14). Used by the sign-in / sign-up form and the session-expired dialog.
 */
export function PasswordInput({
  ref,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & { ref?: Ref<HTMLInputElement> }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw">
      <input ref={ref} {...input} className="input" type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="pw-toggle"
        aria-pressed={shown}
        onClick={() => {
          setShown((value) => !value);
        }}
      >
        {shown ? base.auth.hidePassword : base.auth.showPassword}
      </button>
    </div>
  );
}

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <p className="field-error" id={id}>
      <Icon name="circle-alert" size="sm" />
      <span>{text}</span>
    </p>
  );
}

export function LoginPage({ mode, next, signedOut = false }: LoginPageProps) {
  const services = useServices();
  const now = useStore(services.clock.store, (state) => state.now);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const signUp = mode === 'signup';

  const remaining = lockedUntil === null ? 0 : lockedUntil - now;
  const locked = remaining > 0;
  const summary =
    failure === null || (failure.kind === 'rate-limited' && !locked)
      ? null
      : summaryText(failure, formatCountdown(remaining));

  const focusField = (field: Field): void => {
    const ref = field === 'username' ? usernameRef : field === 'displayName' ? displayNameRef : passwordRef;
    ref.current?.focus();
  };

  const showFieldErrors = (errors: Partial<Record<Field, string>>): boolean => {
    setFieldErrors(errors);
    const first = (['username', 'displayName', 'password'] as const).find(
      (field) => errors[field] !== undefined,
    );
    if (first === undefined) return false;
    focusField(first);
    return true;
  };

  const onFailure = (error: unknown): void => {
    const result = classifyAuthError(error, { password });
    if (result.kind === 'fields') {
      setFailure(null);
      showFieldErrors(result.fields);
      return;
    }
    if (result.kind === 'username-taken') {
      setFailure(null);
      showFieldErrors({ username: base.auth.usernameTaken });
      return;
    }
    setFailure(result);
    if (result.kind === 'rate-limited') {
      services.clock.store.getState().tick();
      setLockedUntil(services.scheduler.now() + result.retryAfterMs);
    }
    if (result.kind === 'bad-credentials') {
      // Never say which field was wrong: keep the username, clear and focus the password (UX F-01 step 5).
      setPassword('');
      passwordRef.current?.focus();
    }
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting || locked) return;
    setFailure(null);
    const errors: Partial<Record<Field, string>> = signUp
      ? validateSignUp({ username, displayName, password })
      : {
          ...(username.trim() === '' ? { username: base.auth.usernameRequired } : {}),
          ...(password === '' ? { password: base.auth.passwordRequired } : {}),
        };
    if (showFieldErrors(errors)) return;
    setSubmitting(true);
    try {
      const response = signUp
        ? await services.api.auth.register({
            username,
            password,
            displayName: displayNameToSend(displayName, username),
          })
        : await services.api.auth.login({ username: username.trim(), password });
      services.adopt(response);
      navigate(next, { replace: true });
    } catch (error) {
      onFailure(error);
    } finally {
      setSubmitting(false);
    }
  };

  const describedBy = (field: Field, hint: boolean): string | undefined => {
    const parts = [
      hint ? `${ids}-${field}-hint` : '',
      fieldErrors[field] !== undefined ? `${ids}-${field}-error` : '',
    ]
      .filter((part) => part !== '')
      .join(' ');
    return parts === '' ? undefined : parts;
  };

  const displayNameLength = sanitizedLength(displayName);
  const showCounter = displayNameLength >= Math.floor(DISPLAY_NAME_MAX * 0.8);
  const buttonLabel = submitting
    ? signUp
      ? base.auth.signingUp
      : base.auth.signingIn
    : signUp
      ? base.auth.signUp
      : base.auth.signIn;

  return (
    <div className="auth-page">
      <main className="auth-card" aria-labelledby={`${ids}-title`}>
        <div className="auth-logo">
          <BrandMark size={40} />
        </div>
        <h1 id={`${ids}-title`} className="auth-title">
          {signUp ? base.auth.signUpTitle : base.auth.signInTitle}
        </h1>
        <p className="auth-tagline">{base.auth.tagline}</p>
        {signedOut && !signUp ? (
          <p className="banner neutral auth-notice" role="status">
            <Icon name="info" />
            <span>{base.auth.signedOut}</span>
          </p>
        ) : null}
        {summary !== null ? (
          <div className="banner danger auth-error" role="alert" data-testid="auth-error">
            <Icon name="circle-alert" />
            <span>{summary}</span>
          </div>
        ) : null}
        <form
          className="auth-form"
          data-testid={signUp ? 'signup-form' : 'signin-form'}
          noValidate
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div className="field">
            <label className="label" htmlFor={`${ids}-username`}>
              {base.auth.username}
            </label>
            <input
              ref={usernameRef}
              id={`${ids}-username`}
              className="input"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              data-testid="username-input"
              value={username}
              readOnly={submitting}
              aria-invalid={fieldErrors.username !== undefined}
              aria-describedby={describedBy('username', signUp)}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
            {signUp ? (
              <p className="hint" id={`${ids}-username-hint`}>
                {base.auth.usernameHint}
              </p>
            ) : null}
            <FieldError id={`${ids}-username-error`} text={fieldErrors.username} />
          </div>
          {signUp ? (
            <div className="field">
              <label className="label" htmlFor={`${ids}-displayName`}>
                {base.auth.displayName}
              </label>
              <input
                ref={displayNameRef}
                id={`${ids}-displayName`}
                className="input"
                name="displayName"
                autoComplete="nickname"
                dir="auto"
                data-testid="display-name-input"
                value={displayName}
                readOnly={submitting}
                aria-invalid={fieldErrors.displayName !== undefined}
                aria-describedby={describedBy('displayName', true)}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
              />
              <p className="hint" id={`${ids}-displayName-hint`}>
                {base.auth.displayNameHint}
              </p>
              {showCounter ? (
                <p className="counter" aria-live="off">
                  {base.save.charCount(displayNameLength, DISPLAY_NAME_MAX)}
                </p>
              ) : null}
              <FieldError id={`${ids}-displayName-error`} text={fieldErrors.displayName} />
            </div>
          ) : null}
          <div className="field">
            <label className="label" htmlFor={`${ids}-password`}>
              {base.auth.password}
            </label>
            <PasswordInput
              ref={passwordRef}
              id={`${ids}-password`}
              name="password"
              autoComplete={signUp ? 'new-password' : 'current-password'}
              data-testid="password-input"
              value={password}
              readOnly={submitting}
              aria-invalid={fieldErrors.password !== undefined}
              aria-describedby={describedBy('password', signUp)}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            {signUp ? (
              <p className="hint" id={`${ids}-password-hint`}>
                {base.auth.passwordHint}
              </p>
            ) : null}
            <FieldError id={`${ids}-password-error`} text={fieldErrors.password} />
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-lg btn-block"
            aria-disabled={submitting || locked}
            data-testid={signUp ? 'signup-submit' : 'signin-submit'}
          >
            {submitting ? <span className="spinner" aria-hidden="true" /> : null}
            {locked && failure?.kind === 'rate-limited'
              ? base.auth.tryAgainIn(formatCountdown(remaining))
              : buttonLabel}
          </button>
        </form>
        <p className="auth-foot">
          <a
            className="link"
            href={
              signUp ? `/signin?next=${encodeURIComponent(next)}` : `/signup?next=${encodeURIComponent(next)}`
            }
            onClick={(event) => {
              event.preventDefault();
              navigate(
                signUp
                  ? `/signin?next=${encodeURIComponent(next)}`
                  : `/signup?next=${encodeURIComponent(next)}`,
              );
            }}
          >
            {signUp ? base.auth.toSignIn : base.auth.toSignUp}
          </a>
        </p>
      </main>
    </div>
  );
}
