import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import mainSource from './main.tsx?raw';
import './zodSetup';

describe('zod runs without its eval-based JIT (CSP script-src self)', () => {
  it('turns the JIT off', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('is the first import of main.tsx, before any module defines a schema', () => {
    const firstImport = /^import\s+['"]([^'"]+)['"]/mu.exec(mainSource);
    expect(firstImport?.[1]).toBe('./zodSetup');
  });
});
