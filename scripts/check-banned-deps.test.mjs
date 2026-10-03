// @ts-check
import { describe, expect, it } from 'vitest';

import { findBanned } from './check-banned-deps.mjs';

/** A flat `npm ls` tree of the given package names. */
const treeOf = (/** @type {string[]} */ names) => ({
  dependencies: Object.fromEntries(names.map((name) => [name, { version: '1.0.0' }])),
});

describe('findBanned', () => {
  it('finds a transitive banned package with its dependency path', () => {
    const tree = {
      name: 'snapland',
      dependencies: {
        '@snapland/backend': { version: '1.0.0', dependencies: { fastify: { version: '5.12.5' } } },
        '@snapland/frontend': {
          version: '1.0.0',
          dependencies: { leaflet: { version: '1.9.4' }, yjs: { version: '13.6.0' } },
        },
      },
    };
    expect(findBanned(tree)).toEqual(['yjs@13.6.0 (@snapland/frontend > yjs)']);
  });

  it('matches the globs of the ban list without banning look-alikes', () => {
    const banned = ['y-websocket', '@y-sweet/sdk', '@liveblocks/client', '@geoman-io/leaflet-geoman-free'];
    expect(findBanned(treeOf([...banned, 'socket.io-client', 'leaflet-draw']))).toHaveLength(6);
    expect(findBanned(treeOf(['leaflet', 'yaml', 'ws', 'fastify', 'yjs-extra', '@types/leaflet']))).toEqual(
      [],
    );
    expect(findBanned(treeOf(['@supabase/supabase-js', 'your-lib']))).toEqual([]);
  });

  it('visits shared subtrees once (deduplicated trees repeat nodes)', () => {
    const shared = { version: '1.0.0', dependencies: { yjs: { version: '1' } } };
    expect(findBanned({ dependencies: { a: shared, b: shared } })).toHaveLength(1);
  });
});
