/**
 * Feature module contract (SPEC section 3.3). Each module exposes ONE `ModuleFactory` in its `index.ts`; `app.ts` registers
 * every module in a fixed order and never needs editing when a module's body is implemented (wave 1).
 */
import type { Container } from '../container.js';
import type { AppInstance } from '../infra/http/types.js';

export type { AppInstance } from '../infra/http/types.js';

export interface AppModule {
  readonly name: string;
  /** Register routes/hooks. Called once, before listen(). */
  register(app: AppInstance): Promise<void>;
  /** Start background work (timers, subscriptions). Called after listen(). */
  start?(): Promise<void>;
  /** Stop background work. Called in reverse registration order during shutdown. */
  stop?(): Promise<void>;
}

export type ModuleFactory = (container: Container) => AppModule;
