/**
 * Auth, presence, runtime-config and client-error endpoints (SPEC section 6.2, section 6.4). The refresh endpoint is called only
 * by the session manager (`auth/session.ts`), which serialises it across tabs.
 */
import type {
  AuthResponse,
  ClientErrorReport,
  ConfigResponse,
  LoginRequest,
  PresenceListResponse,
  RegisterRequest,
} from '@snapland/shared';
import {
  AuthResponseSchema,
  ConfigResponseSchema,
  PresenceListResponseSchema,
  WsTicketResponseSchema,
} from '@snapland/shared';

import type { HttpClient } from './http';

export interface AuthApi {
  login(body: LoginRequest): Promise<AuthResponse>;
  register(body: RegisterRequest): Promise<AuthResponse>;
  logout(): Promise<void>;
  wsTicket(): Promise<string>;
}

export function createAuthApi(http: HttpClient): AuthApi {
  return {
    async login(body) {
      return (
        await http.request('/auth/login', { method: 'POST', body, schema: AuthResponseSchema, auth: false })
      ).data;
    },
    async register(body) {
      return (
        await http.request('/auth/register', {
          method: 'POST',
          body,
          schema: AuthResponseSchema,
          auth: false,
        })
      ).data;
    },
    async logout() {
      await http.request('/auth/logout', { method: 'POST' });
    },
    async wsTicket() {
      return (await http.request('/auth/ws-ticket', { method: 'POST', schema: WsTicketResponseSchema })).data
        .ticket;
    },
  };
}

export interface PresenceApi {
  list(signal?: AbortSignal): Promise<PresenceListResponse>;
}

export function createPresenceApi(http: HttpClient): PresenceApi {
  return {
    async list(signal) {
      return (await http.request('/presence', { schema: PresenceListResponseSchema, signal })).data;
    },
  };
}

export async function fetchRuntimeConfig(http: HttpClient): Promise<ConfigResponse> {
  return (await http.request('/config', { schema: ConfigResponseSchema, auth: false })).data;
}

export async function postClientError(http: HttpClient, report: ClientErrorReport): Promise<void> {
  await http.request('/client-errors', { method: 'POST', body: report });
}
