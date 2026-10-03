/** Records -> DTOs of `packages/shared/src/schemas/auth.ts` (SPEC section 6.2). Timestamps are ISO-8601 UTC. */
import type { SessionDto, UserDto } from '@snapland/shared';

import type { SessionView } from './sessions.repository.js';
import type { UserProfile } from './users.repository.js';

export function toUserDto(user: UserProfile): UserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    color: user.color,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toSessionDto(session: SessionView, currentSessionId: string): SessionDto {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    userAgent: session.userAgent,
    ip: session.ip,
    current: session.id === currentSessionId,
  };
}
