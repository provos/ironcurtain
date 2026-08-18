/**
 * Worker entry point for source runs.
 *
 * Registers the TypeScript specifier remap hook in-thread so the worker never
 * depends on loaders inherited from the parent process (tsx's hooks do not
 * apply inside worker threads on Node 22), then loads the real worker. The
 * compiled dist build spawns sqlite-worker.js directly and bypasses this shim.
 *
 * `module.registerHooks` (Node >= 22.15) is required: it is the synchronous
 * hooks API, and the remap hook below depends on `nextResolve` throwing
 * synchronously. The async `module.register()` API returns a promise instead,
 * so the hook's fallback would never fire there. The package `engines` floor
 * is >=22.15.0 for exactly this reason.
 */

import * as nodeModule from 'node:module';
import { resolve } from './ts-specifier-remap.mjs';

nodeModule.registerHooks({ resolve });

await import('./sqlite-worker.ts');
