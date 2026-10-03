import type { AuthResponse } from '@snapland/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServicesProvider } from '../app/AppContext';
import type { AppServices } from '../app/services';
import { createAppServices } from '../app/services';
import { SessionExpiredDialog } from '../components/Dialogs';
import { base } from '../base/en';
import { systemScheduler } from '../lib/scheduler';
import { LoginPage } from './LoginPage';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

type Responder = (request: Recorded) => Response;

const USER_ID = '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50';

function authResponse(username: string, displayName: string): AuthResponse {
  return {
    user: {
      id: USER_ID,
      username,
      displayName,
      color: '#c44f9d',
      role: 'user',
      createdAt: '2026-09-27T10:00:00.000Z',
    },
    sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
    accessToken: 'access-token',
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const type = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type, ...headers } });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): unknown {
  return { type: `urn:snapland:problem:${code.toLowerCase()}`, title: code, status, code, ...extra };
}

function harness(responder: Responder): { services: AppServices; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchStub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: Recorded = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    return Promise.resolve(responder(request));
  };
  const services = createAppServices({
    fetch: fetchStub,
    scheduler: systemScheduler,
    locks: null,
    apiBase: '/api/v1',
  });
  return { services, requests };
}

function renderPage(services: AppServices, mode: 'signin' | 'signup'): void {
  render(
    <ServicesProvider services={services}>
      <LoginPage mode={mode} next="/" />
    </ServicesProvider>,
  );
}

function formIn(element: HTMLElement): HTMLFormElement {
  const form = element.querySelector('form');
  if (form === null) throw new Error('no form');
  return form;
}

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submit(mode: 'signin' | 'signup'): void {
  fireEvent.submit(screen.getByTestId(mode === 'signin' ? 'signin-form' : 'signup-form'));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/signin');
});

afterEach(cleanup);

describe('LoginPage - sign in (UX F-01, C-01)', () => {
  it('UX-AC-01 wrong password: auth.badCredentials in auth-error, username kept, password cleared and focused, no navigation', async () => {
    const { services } = harness((request) =>
      request.url.endsWith('/auth/login')
        ? json(401, problem(401, 'INVALID_CREDENTIALS'))
        : json(404, problem(404, 'NOT_FOUND')),
    );
    renderPage(services, 'signin');
    type('username-input', 'alice');
    type('password-input', 'wrong-password');
    submit('signin');
    const error = await screen.findByTestId('auth-error');
    expect(error.textContent).toContain(base.auth.badCredentials);
    expect(error.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId<HTMLInputElement>('username-input').value).toBe('alice');
    const password = screen.getByTestId<HTMLInputElement>('password-input');
    expect(password.value).toBe('');
    expect(document.activeElement).toBe(password);
    expect(window.location.pathname).toBe('/signin');
  });

  it('empty fields are refused client-side with inline errors and nothing is sent', () => {
    const { services, requests } = harness(() => json(500, problem(500, 'INTERNAL_ERROR')));
    renderPage(services, 'signin');
    submit('signin');
    expect(screen.getByText(base.auth.usernameRequired)).toBeTruthy();
    expect(screen.getByText(base.auth.passwordRequired)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('username-input'));
    expect(requests).toHaveLength(0);
  });

  it('UX-AC-97 ACCOUNT_DISABLED shows auth.accountDisabled; a login lockout of 873,000 ms reads "Try again in 15 min"', async () => {
    let calls = 0;
    const { services } = harness(() => {
      calls += 1;
      return calls === 1
        ? json(403, problem(403, 'ACCOUNT_DISABLED'))
        : json(429, problem(429, 'RATE_LIMITED', { retryAfterMs: 873_000, scope: 'login' }), {
            'Retry-After': '873',
          });
    });
    renderPage(services, 'signin');
    type('username-input', 'alice');
    type('password-input', 'secret-password');
    submit('signin');
    await waitFor(() => {
      expect(screen.getByTestId('auth-error').textContent).toContain(base.auth.accountDisabled);
    });
    type('password-input', 'secret-password');
    submit('signin');
    await waitFor(() => {
      expect(screen.getByTestId('auth-error').textContent).toBe('Too many attempts. Try again in 15 min.');
    });
    const button = screen.getByTestId('signin-submit');
    expect(button.textContent).toContain('Try again in 15 min');
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('a network failure says auth.networkError', async () => {
    const services = createAppServices({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      scheduler: systemScheduler,
      locks: null,
      apiBase: '/api/v1',
    });
    renderPage(services, 'signin');
    type('username-input', 'alice');
    type('password-input', 'secret-password');
    submit('signin');
    await waitFor(() => {
      expect(screen.getByTestId('auth-error').textContent).toContain(base.auth.networkError);
    });
  });

  it('a successful sign-in adopts the session and navigates to next', async () => {
    const { services } = harness(() => json(200, authResponse('alice', 'Alice')));
    renderPage(services, 'signin');
    type('username-input', 'alice');
    type('password-input', 'secret-password');
    submit('signin');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
    expect(services.stores.auth.getState().status).toBe('signed-in');
    expect(services.stores.auth.getState().accessToken).toBe('access-token');
  });
});

describe('LoginPage - sign up (UX F-01 step 7)', () => {
  it('UX-AC-02 an existing username shows auth.usernameTaken on the username field, linked by aria-describedby', async () => {
    const { services } = harness(() => json(409, problem(409, 'USERNAME_TAKEN')));
    renderPage(services, 'signup');
    type('username-input', 'alice');
    type('password-input', 'long-enough-password');
    submit('signup');
    const message = await screen.findByText(base.auth.usernameTaken);
    const error = message.closest('.field-error');
    const username = screen.getByTestId('username-input');
    expect(error).not.toBeNull();
    expect(username.getAttribute('aria-describedby')?.split(' ')).toContain(error?.id);
    expect(username.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(username);
  });

  it('UX-AC-02 an empty display name sends the username as displayName and lands on /', async () => {
    const { services, requests } = harness(() => json(201, authResponse('new_user', 'new_user')));
    renderPage(services, 'signup');
    type('username-input', 'new_user');
    type('password-input', 'long-enough-password');
    submit('signup');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
    const register = requests.find((request) => request.url.endsWith('/auth/register'));
    expect(register?.body).toEqual({
      username: 'new_user',
      password: 'long-enough-password',
      displayName: 'new_user',
    });
  });

  it('UX-AC-02 a Hebrew display name is sent as typed (sanitised)', async () => {
    const { services, requests } = harness(() => json(201, authResponse('moshe', 'משה כהן')));
    renderPage(services, 'signup');
    type('username-input', 'moshe');
    type('display-name-input', '  משה   כהן ');
    type('password-input', 'long-enough-password');
    submit('signup');
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect((requests[0]?.body as { displayName: string }).displayName).toBe('משה כהן');
  });

  it('UX-AC-02 a server VALIDATION_FAILED on displayName shows its error under display-name-input', async () => {
    const { services } = harness(() =>
      json(
        400,
        problem(400, 'VALIDATION_FAILED', {
          errors: [{ path: 'displayName', code: 'too_small', message: 'empty' }],
        }),
      ),
    );
    renderPage(services, 'signup');
    type('username-input', 'someone');
    type('display-name-input', 'x');
    type('password-input', 'long-enough-password');
    submit('signup');
    const message = await screen.findByText(base.auth.displayNameInvalid);
    const input = screen.getByTestId('display-name-input');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(message.closest('.field-error')?.id);
  });

  it('client rules: invalid username and short password are field errors; nothing is sent', () => {
    const { services, requests } = harness(() => json(500, problem(500, 'INTERNAL_ERROR')));
    renderPage(services, 'signup');
    type('username-input', 'a b');
    type('password-input', 'short');
    submit('signup');
    expect(screen.getByText(base.auth.usernameInvalid)).toBeTruthy();
    expect(screen.getByText(base.auth.passwordTooShort)).toBeTruthy();
    expect(requests).toHaveLength(0);
  });
});

describe('LoginPage - password managers and accessibility (UX-AC-03)', () => {
  it('UX-AC-03 autocomplete: username / current-password on sign-in, new-password on sign-up; display name nickname + dir=auto', () => {
    const { services } = harness(() => json(500, problem(500, 'INTERNAL_ERROR')));
    renderPage(services, 'signin');
    expect(screen.getByTestId('username-input').getAttribute('autocomplete')).toBe('username');
    expect(screen.getByTestId('password-input').getAttribute('autocomplete')).toBe('current-password');
    cleanup();
    renderPage(services, 'signup');
    expect(screen.getByTestId('username-input').getAttribute('autocomplete')).toBe('username');
    expect(screen.getByTestId('password-input').getAttribute('autocomplete')).toBe('new-password');
    const displayName = screen.getByTestId('display-name-input');
    expect(displayName.getAttribute('autocomplete')).toBe('nickname');
    expect(displayName.getAttribute('dir')).toBe('auto');
  });

  it('UX-AC-03 paste into the password field is not blocked, and Show/Hide toggles the input type', () => {
    const { services } = harness(() => json(500, problem(500, 'INTERNAL_ERROR')));
    renderPage(services, 'signin');
    const password = screen.getByTestId<HTMLInputElement>('password-input');
    expect(fireEvent.paste(password, { clipboardData: { getData: () => 'pasted-secret' } })).toBe(true);
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: base.auth.showPassword }));
    expect(password.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: base.auth.hidePassword }));
    expect(password.type).toBe('password');
  });
});

describe('Session dialog (UX F-11, C-21)', () => {
  it('UX-AC-97 a refresh answered 401 SESSION_REVOKED shows session-expired-dialog[data-variant=revoked] with session.revokedTitle', async () => {
    const { services } = harness((request) =>
      request.url.endsWith('/auth/refresh')
        ? json(401, problem(401, 'SESSION_REVOKED'))
        : json(404, problem(404, 'NOT_FOUND')),
    );
    services.adopt(authResponse('alice', 'Alice'));
    render(
      <ServicesProvider services={services}>
        <SessionExpiredDialog onSignedIn={() => undefined} onSignOut={() => undefined} />
      </ServicesProvider>,
    );
    expect(screen.queryByTestId('session-expired-dialog')).toBeNull();
    await act(async () => {
      await services.session.refresh();
    });
    const dialog = screen.getByTestId('session-expired-dialog');
    expect(dialog.getAttribute('data-variant')).toBe('revoked');
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain(base.session.revokedTitle);
    expect(dialog.querySelector<HTMLInputElement>('input[name="username"]')?.value).toBe('alice');
    // Esc cannot dismiss it (UX C-21).
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByTestId('session-expired-dialog')).toBeTruthy();
  });

  it('C-21 has the same Show / Hide password button inside the field as the sign-in form (UI.md section 10.12)', async () => {
    const { services } = harness((request) =>
      request.url.endsWith('/auth/refresh')
        ? json(401, problem(401, 'REFRESH_TOKEN_INVALID'))
        : json(404, problem(404, 'NOT_FOUND')),
    );
    services.adopt(authResponse('alice', 'Alice'));
    render(
      <ServicesProvider services={services}>
        <SessionExpiredDialog onSignedIn={() => undefined} onSignOut={() => undefined} />
      </ServicesProvider>,
    );
    await act(async () => {
      await services.session.refresh();
    });
    const password = screen.getByTestId<HTMLInputElement>('password-input');
    expect(document.activeElement).toBe(password);
    expect(password.type).toBe('password');
    const toggle = screen.getByRole('button', { name: base.auth.showPassword });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(password.type).toBe('text');
    expect(screen.getByRole('button', { name: base.auth.hidePassword }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('an expired refresh token shows the "expired" variant, and signing in again closes the dialog', async () => {
    let refreshed = false;
    const { services } = harness((request) => {
      if (request.url.endsWith('/auth/refresh')) return json(401, problem(401, 'REFRESH_TOKEN_INVALID'));
      if (request.url.endsWith('/auth/login')) {
        refreshed = true;
        return json(200, authResponse('alice', 'Alice'));
      }
      return json(404, problem(404, 'NOT_FOUND'));
    });
    services.adopt(authResponse('alice', 'Alice'));
    let signedIn = 0;
    render(
      <ServicesProvider services={services}>
        <SessionExpiredDialog
          onSignedIn={() => {
            signedIn += 1;
          }}
          onSignOut={() => undefined}
        />
      </ServicesProvider>,
    );
    await act(async () => {
      await services.session.refresh();
    });
    expect(screen.getByTestId('session-expired-dialog').getAttribute('data-variant')).toBe('expired');
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret-password' } });
    fireEvent.submit(formIn(screen.getByTestId('session-expired-dialog')));
    await waitFor(() => {
      expect(screen.queryByTestId('session-expired-dialog')).toBeNull();
    });
    expect(refreshed).toBe(true);
    expect(signedIn).toBe(1);
  });
});
