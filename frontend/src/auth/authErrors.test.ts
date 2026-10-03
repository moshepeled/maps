import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/http';
import { base } from '../base/en';
import { apiProblem, networkError } from '../test/workspaceHarness';
import { classifyAuthError, displayNameToSend, summaryText, validateSignUp } from './authErrors';

describe('auth error mapping (UX F-01, C-01)', () => {
  it('maps every server answer to one failure kind', () => {
    expect(classifyAuthError(apiProblem(401, 'INVALID_CREDENTIALS'))).toEqual({ kind: 'bad-credentials' });
    expect(classifyAuthError(apiProblem(403, 'ACCOUNT_DISABLED'))).toEqual({ kind: 'disabled' });
    expect(classifyAuthError(apiProblem(409, 'USERNAME_TAKEN'))).toEqual({ kind: 'username-taken' });
    expect(classifyAuthError(apiProblem(429, 'RATE_LIMITED', {}, 5000))).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 5000,
    });
    expect(classifyAuthError(apiProblem(429, 'RATE_LIMITED'))).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 60_000,
    });
    expect(classifyAuthError(apiProblem(500, 'INTERNAL_ERROR'))).toEqual({ kind: 'server' });
    expect(classifyAuthError(networkError())).toEqual({ kind: 'network' });
    expect(classifyAuthError(new ApiError('timeout', 0, 'TIMEOUT', null, null, 't'))).toEqual({
      kind: 'network',
    });
    expect(classifyAuthError(new Error('x'))).toEqual({ kind: 'network' });
  });

  it('VALIDATION_FAILED errors[] become field errors by path', () => {
    const error = apiProblem(400, 'VALIDATION_FAILED', {
      errors: [
        { path: 'body.username', code: 'invalid', message: 'x' },
        { path: 'password', code: 'too_big', message: 'x' },
      ],
    });
    expect(classifyAuthError(error, { password: 'p'.repeat(200) })).toEqual({
      kind: 'fields',
      fields: { username: base.auth.usernameInvalid, password: base.auth.passwordTooLong },
    });
    expect(classifyAuthError(apiProblem(400, 'VALIDATION_FAILED', { errors: [] }))).toEqual({
      kind: 'server',
    });
  });

  it('summary texts', () => {
    expect(summaryText({ kind: 'bad-credentials' }, '')).toBe(base.auth.badCredentials);
    expect(summaryText({ kind: 'rate-limited', retryAfterMs: 1 }, '15 min')).toBe(
      'Too many attempts. Try again in 15 min.',
    );
    expect(summaryText({ kind: 'server' }, '')).toBe(base.auth.serverError);
    expect(summaryText({ kind: 'username-taken' }, '')).toBeNull();
  });

  it('sign-up rules and the display name fallback to the username', () => {
    expect(validateSignUp({ username: 'ok_name', displayName: '', password: 'long-enough' })).toEqual({});
    expect(validateSignUp({ username: '', displayName: 'x'.repeat(65), password: '' })).toEqual({
      username: base.auth.usernameRequired,
      displayName: base.auth.displayNameTooLong,
      password: base.auth.passwordRequired,
    });
    expect(validateSignUp({ username: 'ok', displayName: '', password: 'x'.repeat(129) }).password).toBe(
      base.auth.passwordTooLong,
    );
    expect(displayNameToSend('  ​ ', 'alice')).toBe('alice');
    expect(displayNameToSend(' Dana  Levi ', 'dana')).toBe('Dana Levi');
    // D-8: an email username never becomes the public display name; its local part does.
    expect(displayNameToSend('', 'moshe.peled@example.com')).toBe('moshe.peled');
    expect(displayNameToSend('Moshe', 'moshe.peled@example.com')).toBe('Moshe');
    expect(
      validateSignUp({ username: 'moshe.peled@example.com', displayName: '', password: 'long-enough' }),
    ).toEqual({});
    expect(
      validateSignUp({ username: 'moshe@localhost', displayName: '', password: 'long-enough' }).username,
    ).toBe(base.auth.usernameInvalid);
  });
});
