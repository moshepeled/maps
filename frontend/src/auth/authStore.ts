/**
 * Who is signed in (SPEC section 6.2): the user and the access token, kept in memory only (never in localStorage). The
 * refresh cookie is HttpOnly and invisible to the SPA. `sessionProblem` drives the session-expired dialog (UX C-21)
 * without unmounting the workspace, so drafts and forms survive.
 */
import type { AuthResponse, UserDto } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

export type AuthStatus = 'booting' | 'signed-out' | 'signed-in';
export type SessionProblem = 'expired' | 'revoked';

export interface AuthState {
  status: AuthStatus;
  user: UserDto | null;
  sessionId: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  sessionProblem: SessionProblem | null;
}

export interface AuthStore extends AuthState {
  setSession(response: AuthResponse): void;
  markSignedOut(): void;
  markSessionProblem(problem: SessionProblem): void;
}

export function createAuthStore() {
  return createStore<AuthStore>()((set) => ({
    status: 'booting',
    user: null,
    sessionId: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    sessionProblem: null,
    setSession: (response) => {
      set({
        status: 'signed-in',
        user: response.user,
        sessionId: response.sessionId,
        accessToken: response.accessToken,
        accessTokenExpiresAt: Date.parse(response.accessTokenExpiresAt),
        sessionProblem: null,
      });
    },
    markSignedOut: () => {
      set({
        status: 'signed-out',
        user: null,
        sessionId: null,
        accessToken: null,
        accessTokenExpiresAt: null,
        sessionProblem: null,
      });
    },
    markSessionProblem: (problem) => {
      // The user stays "signed in" underneath the dialog: the workspace keeps its state (UX F-11 step 2).
      set({ accessToken: null, accessTokenExpiresAt: null, sessionProblem: problem });
    },
  }));
}

export type AuthStoreApi = ReturnType<typeof createAuthStore>;
