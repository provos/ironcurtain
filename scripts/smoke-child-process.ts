/** Shared bounded lifecycle for smoke children and qualification subprocesses. */
export {
  reapSmokeProcessGroup,
  waitForSmokeChild,
  type SmokeChildExit,
  type WaitForSmokeChildOptions,
  type ReapSmokeProcessGroupOptions,
} from '../src/docker-workload/qualification-process.js';
