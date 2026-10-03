/**
 * Transport of the auth endpoints (SPEC section 6.1, section 6.2): transport schemas, hooks, cookies and status codes only - every
 * decision lives in the services. Every mutating route declares `config.auditAction`, so the generic onResponse hook
 * records the failures the service never sees (400 schema, 413, 415, 5xx); register and login share the per-IP `auth`
 * bucket, refresh has its own `refresh` bucket (every page load refreshes), the others the default per-user `api` scope.
 * Responses that carry tokens or personal session data are `Cache-Control: no-store`.
 */
import {
  AuthResponseSchema,
  LoginRequestSchema,
  MeResponseSchema,
  RegisterRequestSchema,
  SessionIdParamsSchema,
  SessionListResponseSchema,
  WsTicketResponseSchema,
} from '@snapland/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { SECURITY_BEARER, SECURITY_REFRESH_COOKIE, withProblems } from '../../infra/http/openapi.js';
import { rateLimitRoute } from '../../infra/http/rate-limits.js';
import type { AppInstance } from '../../infra/http/types.js';
import type { AuthService, IssuedSession } from './auth.service.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './refresh-tokens.js';
import type { SessionsService } from './sessions.service.js';

const TAGS = ['auth'];
const NO_CONTENT = z.null().describe('No content');

export interface AuthRouteDeps {
  auth: AuthService;
  sessions: SessionsService;
  /** COOKIE_SECURE (false only for plain-HTTP development). */
  cookieSecure: boolean;
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}

export function registerAuthRoutes(app: AppInstance, { auth, sessions, cookieSecure }: AuthRouteDeps): void {
  const setRefreshCookie = (reply: FastifyReply, issued: IssuedSession): void => {
    reply.setCookie(
      REFRESH_COOKIE_NAME,
      issued.refreshToken,
      refreshCookieOptions(cookieSecure, issued.refreshCookieMaxAgeS),
    );
    noStore(reply);
  };

  app.post(
    '/api/v1/auth/register',
    {
      config: { rateLimit: rateLimitRoute('auth'), auditAction: 'auth.register' },
      schema: {
        summary: 'Create an account (role user) and sign in',
        tags: TAGS,
        body: RegisterRequestSchema,
        response: withProblems({ 201: AuthResponseSchema }, 409, 413, 415),
      },
    },
    async (request, reply) => {
      const issued = await auth.register(request.body, request.actor());
      setRefreshCookie(reply, issued);
      return reply.code(201).send(issued.body);
    },
  );

  app.post(
    '/api/v1/auth/login',
    {
      config: { rateLimit: rateLimitRoute('auth'), auditAction: 'auth.login' },
      schema: {
        summary: 'Sign in (5 failures per username and IP within 15 min lock that pair: 429 scope login)',
        tags: TAGS,
        body: LoginRequestSchema,
        response: withProblems({ 200: AuthResponseSchema }, 401, 403, 413, 415),
      },
    },
    async (request, reply) => {
      const issued = await auth.login(request.body, request.actor());
      setRefreshCookie(reply, issued);
      return reply.code(200).send(issued.body);
    },
  );

  app.post(
    '/api/v1/auth/refresh',
    {
      config: { rateLimit: rateLimitRoute('refresh'), auditAction: 'auth.refresh' },
      schema: {
        summary: 'Rotate the refresh token (HttpOnly cookie snap_rt) and issue a new access token',
        description:
          'Authenticated by the `snap_rt` cookie (Path=/api/v1/auth; HttpOnly; SameSite=Strict). A rotated token ' +
          'presented again more than 10 s after its rotation revokes the session (REFRESH_TOKEN_REUSED).',
        tags: TAGS,
        security: SECURITY_REFRESH_COOKIE,
        response: withProblems({ 200: AuthResponseSchema }, 401),
      },
    },
    async (request, reply) => {
      const issued = await auth.refresh(request.cookies[REFRESH_COOKIE_NAME], request.actor());
      setRefreshCookie(reply, issued);
      return reply.code(200).send(issued.body);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      onRequest: [app.authenticate],
      config: { auditAction: 'auth.logout' },
      schema: {
        summary: 'Revoke the current session and clear the refresh cookie',
        tags: TAGS,
        security: SECURITY_BEARER,
        response: withProblems({ 204: NO_CONTENT }, 401),
      },
    },
    async (request, reply) => {
      await auth.logout(request.actor());
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions(cookieSecure));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/api/v1/auth/me',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'The signed-in user and the current session',
        tags: TAGS,
        security: SECURITY_BEARER,
        response: withProblems({ 200: MeResponseSchema }, 401),
      },
    },
    async (request, reply) => {
      const me = await sessions.me(request.actor());
      noStore(reply);
      return me;
    },
  );

  app.get(
    '/api/v1/auth/sessions',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'My active sessions (newest first; current: true marks this one)',
        tags: TAGS,
        security: SECURITY_BEARER,
        response: withProblems({ 200: SessionListResponseSchema }, 401),
      },
    },
    async (request, reply) => {
      const list = await sessions.list(request.actor());
      noStore(reply);
      return list;
    },
  );

  app.delete(
    '/api/v1/auth/sessions/:sessionId',
    {
      onRequest: [app.authenticate],
      config: { auditAction: 'auth.session_revoke' },
      schema: {
        summary: 'Revoke one of my sessions (its sockets close with 4401)',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: SessionIdParamsSchema,
        response: withProblems({ 204: NO_CONTENT }, 401, 404),
      },
    },
    async (request, reply) => {
      await sessions.revoke(request.actor(), request.params.sessionId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/api/v1/auth/ws-ticket',
    {
      onRequest: [app.authenticate],
      config: { auditAction: 'auth.ws_ticket' },
      schema: {
        summary:
          'One-time WebSocket ticket (single use, expires after WS_TICKET_TTL_S; 503 while Redis is down)',
        tags: TAGS,
        security: SECURITY_BEARER,
        response: withProblems({ 201: WsTicketResponseSchema }, 401),
      },
    },
    async (request, reply) => {
      const ticket = await sessions.issueWsTicket(request.actor());
      noStore(reply);
      return reply.code(201).send(ticket);
    },
  );
}
