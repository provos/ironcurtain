import { PTY_KILL_GRACE_MS } from '../src/pty/pty-bridge.js';

// CLI exit includes exact resource removal, both absence inventories, and
// watchdog acknowledgement. Healthy WSL cleanup has taken over 40 seconds.
export const PTY_GRACEFUL_EXIT_TIMEOUT_MS = PTY_KILL_GRACE_MS;
export const PTY_CLEANUP_TIMEOUT_MS = 180_000;
// Cancellation forwards TERM through the bridge, waits for its escalation and
// then verifies bundle closure. The outer process group must survive all three.
export const PTY_GATE_TERM_GRACE_MS = PTY_KILL_GRACE_MS + 20_000 + PTY_CLEANUP_TIMEOUT_MS + 30_000;
