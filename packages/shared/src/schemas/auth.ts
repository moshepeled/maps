/** Auth & session schemas (SPEC section 6.2). Text limits after sanitisation are enforced by the service (-> 400). */
import { z } from 'zod';

import { LIMITS } from '../constants.js';
import { HexColorSchema, IsoDateTimeSchema, RoleSchema, UuidSchema } from './common.js';

export const UsernameSchema = z
  .string()
  .regex(new RegExp(LIMITS.usernamePattern), 'must be 3-32 of A-Z a-z 0-9 _ . - or an email address');

export const RegisterRequestSchema = z.strictObject({
  username: UsernameSchema,
  password: z.string().min(LIMITS.passwordMinLength).max(LIMITS.passwordMaxLength),
  /** Raw cap only; sanitised to 1-64 code points by the service. */
  displayName: z.string().max(LIMITS.displayNameRawMaxLength),
});

export const LoginRequestSchema = z.strictObject({
  username: z.string().min(1).max(LIMITS.usernameMaxLength),
  password: z.string().min(1).max(LIMITS.passwordMaxLength),
});

export const UserDtoSchema = z.object({
  id: UuidSchema,
  username: z.string(),
  displayName: z.string(),
  color: HexColorSchema,
  role: RoleSchema,
  createdAt: IsoDateTimeSchema,
});

export const AuthResponseSchema = z.object({
  user: UserDtoSchema,
  sessionId: UuidSchema,
  accessToken: z.string(),
  accessTokenExpiresAt: IsoDateTimeSchema,
});

export const SessionDtoSchema = z.object({
  id: UuidSchema,
  createdAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});

export const SessionListResponseSchema = z.object({ items: z.array(SessionDtoSchema) });

export const SessionIdParamsSchema = z.strictObject({ sessionId: UuidSchema });

export const WsTicketResponseSchema = z.object({
  /** 32 random bytes, base64url (43 characters). */
  ticket: z.string().length(43),
  expiresAt: IsoDateTimeSchema,
});

export const MeResponseSchema = z.object({ user: UserDtoSchema, session: SessionDtoSchema });

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type UserDto = z.infer<typeof UserDtoSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type SessionDto = z.infer<typeof SessionDtoSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type WsTicketResponse = z.infer<typeof WsTicketResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
