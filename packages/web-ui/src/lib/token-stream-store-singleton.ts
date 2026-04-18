/**
 * Module-level singleton for the app's token stream store.
 *
 * The factory (`createTokenStreamStore`) stays testable in isolation;
 * this file provides the single shared instance that `event-handler.ts`
 * publishes into and that `workflow-theater.svelte` subscribes to.
 * Keeping the singleton in its own module avoids import-order coupling
 * between the dispatcher and consumers.
 */

import { createTokenStreamStore, type TokenStreamStore } from './token-stream-store.svelte.js';

export const tokenStreamStore: TokenStreamStore = createTokenStreamStore();
