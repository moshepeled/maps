/**
 * The CSP forbids eval (`script-src 'self'`), so zod's JIT can never run in this app, and zod probes for it with
 * `Function('')` when an object schema is *defined*, which raises a CSP violation. The shared schemas are defined
 * when their modules load, so this module must be the first import of `main.tsx`.
 */
import { z } from 'zod';

z.config({ jitless: true });
