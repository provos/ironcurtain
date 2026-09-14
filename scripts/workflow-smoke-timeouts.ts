import {
  QUALIFICATION_KILL_GRACE_MS,
  QUALIFICATION_TERM_GRACE_MS,
} from '../src/docker-workload/qualification-process.js';

export const WORKFLOW_STATE_TIMEOUT_MS = 93 * 60_000;
export const WORKFLOW_STARTUP_TEARDOWN_RESERVE_MS = 20 * 60_000;
export const WORKFLOW_CHILD_TIMEOUT_MS = WORKFLOW_STATE_TIMEOUT_MS + WORKFLOW_STARTUP_TEARDOWN_RESERVE_MS;
export const WORKFLOW_CLEANUP_TIMEOUT_MS = 10 * 60_000;

// A selected-mode gate also starts a fresh admission. Each may consume its full
// child deadline, TERM/KILL grace and lease cleanup. Ten additional minutes bound
// fixture pull/export before either child and the final host evidence checks.
export const WORKFLOW_GATE_TIMEOUT_MS =
  2 *
    (WORKFLOW_CHILD_TIMEOUT_MS +
      QUALIFICATION_TERM_GRACE_MS +
      QUALIFICATION_KILL_GRACE_MS +
      WORKFLOW_CLEANUP_TIMEOUT_MS) +
  10 * 60_000;
