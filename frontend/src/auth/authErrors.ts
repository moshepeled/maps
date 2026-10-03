/**
 * How sign-in / sign-up failures read (UX F-01, C-01, section 9.1): one mapping shared by the auth pages and the
 * session-expired dialog, so wrong credentials, a disabled account, the login lockout and network problems always use
 * the same words - and never reveal which field was wrong.
 */
import { LIMITS, codePointLength } from '@snapland/shared';

import { isApiError } from '../api/http';
import { RATE_LIMIT_DEFAULT_WAIT_MS } from '../constants/ux';
import { base } from '../base/en';
import { sanitized } from '../lib/text';

export type AuthFailure =
  | { kind: 'bad-credentials' }
  | { kind: 'disabled' }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'username-taken' }
  | { kind: 'fields'; fields: Partial<Record<'username' | 'displayName' | 'password', string>> }
  | { kind: 'network' }
  | { kind: 'server' };

function fieldMessage(field: 'username' | 'displayName' | 'password', value: string): string {
  if (field === 'username') return base.auth.usernameInvalid;
  if (field === 'displayName') return base.auth.displayNameInvalid;
  return value.length > LIMITS.passwordMaxLength ? base.auth.passwordTooLong : base.auth.passwordTooShort;
}

/** Maps an API failure of login / register to what the form shows. */
export function classifyAuthError(
  error: unknown,
  values: { password: string } = { password: '' },
): AuthFailure {
  if (!isApiError(error)) return { kind: 'network' };
  if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'aborted')
    return { kind: 'network' };
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return { kind: 'bad-credentials' };
    case 'ACCOUNT_DISABLED':
      return { kind: 'disabled' };
    case 'USERNAME_TAKEN':
      return { kind: 'username-taken' };
    case 'RATE_LIMITED':
      return { kind: 'rate-limited', retryAfterMs: error.retryAfterMs ?? RATE_LIMIT_DEFAULT_WAIT_MS };
    case 'VALIDATION_FAILED': {
      const fields: Partial<Record<'username' | 'displayName' | 'password', string>> = {};
      for (const issue of error.problem?.errors ?? []) {
        const field = (['username', 'displayName', 'password'] as const).find(
          (name) => issue.path === name || issue.path.endsWith(`.${name}`),
        );
        if (field !== undefined && fields[field] === undefined)
          fields[field] = fieldMessage(field, values.password);
      }
      return Object.keys(fields).length > 0 ? { kind: 'fields', fields } : { kind: 'server' };
    }
    default:
      return { kind: 'server' };
  }
}

/** The error-summary text of a failure (the `auth-error` element), or null for field-level failures. */
export function summaryText(failure: AuthFailure, wait: string): string | null {
  switch (failure.kind) {
    case 'bad-credentials':
      return base.auth.badCredentials;
    case 'disabled':
      return base.auth.accountDisabled;
    case 'rate-limited':
      return base.auth.tooManyAttempts(wait);
    case 'network':
      return base.auth.networkError;
    case 'server':
      return base.auth.serverError;
    case 'username-taken':
    case 'fields':
      return null;
  }
}

/** Client-side checks of the sign-up form (UX F-01 step 7); sign-in only checks "not empty". */
export function validateSignUp(values: {
  username: string;
  displayName: string;
  password: string;
}): Partial<Record<'username' | 'displayName' | 'password', string>> {
  const errors: Partial<Record<'username' | 'displayName' | 'password', string>> = {};
  if (values.username === '') errors.username = base.auth.usernameRequired;
  else if (!new RegExp(LIMITS.usernamePattern).test(values.username))
    errors.username = base.auth.usernameInvalid;
  if (codePointLength(sanitized(values.displayName)) > LIMITS.displayNameMaxLength) {
    errors.displayName = base.auth.displayNameTooLong;
  }
  if (values.password === '') errors.password = base.auth.passwordRequired;
  else if (values.password.length < LIMITS.passwordMinLength) errors.password = base.auth.passwordTooShort;
  else if (values.password.length > LIMITS.passwordMaxLength) errors.password = base.auth.passwordTooLong;
  return errors;
}

/** The `displayName` sent at sign-up: the sanitised field, or the username when it is empty (UX F-01 step 7). */
export function displayNameToSend(displayName: string, username: string): string {
  const cleaned = sanitized(displayName);
  if (cleaned !== '') return cleaned;
  // Never show an email address to collaborators: fall back to its local part (D-8).
  const at = username.indexOf('@');
  return at > 0 ? username.slice(0, at) : username;
}
