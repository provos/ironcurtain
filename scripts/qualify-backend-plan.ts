/** Source-controlled release gates selected by scripts/qualify-backend.ts. */

import { DOCKER_DESKTOP_QUALIFICATION_ARGUMENTS } from './smoke-nested-apple-workload.js';

export type QualificationBackend = 'apple' | 'docker-desktop';

export interface QualificationLiveGate {
  readonly script: 'smoke-nested-apple.ts' | 'smoke-nested-apple-workflow.ts';
  readonly arguments: readonly string[];
}

export interface BackendQualificationPlan {
  readonly backend: QualificationBackend;
  readonly label: string;
  readonly suiteId: string;
  readonly testFiles: readonly string[];
  readonly liveGates: readonly QualificationLiveGate[];
}

const APPLE_TEST_FILES = [
  'test/docker-manager.test.ts',
  'test/apple-container-manager.test.ts',
  'test/apple-container.integration.test.ts',
] as const;

const DOCKER_DESKTOP_TEST_FILES = [
  'test/smoke-child-process.test.ts',
  'test/proxy-router-mode.test.ts',
  'test/docker/backend-qualification-plan.test.ts',
  'test/smoke-nested-apple-workload.test.ts',
  'test/docker/docker-workload-admission.test.ts',
  'test/docker/desktop-relay.test.ts',
  'test/docker/docker-workload-wiring.test.ts',
  'test/docker/nested-daemon-wiring.test.ts',
  'test/docker/pty-nested-ordering.test.ts',
  'test/docker/pty-cleanup.test.ts',
  'test/docker/docker-workload-prepare-failure.test.ts',
  'test/docker-workload/docker-desktop-sidecar.test.ts',
  'test/docker-workload/infrastructure-reconciliation.test.ts',
  'test/docker-workload/infrastructure-teardown.test.ts',
  'test/docker-workload/watchdog-sigkill.integration.test.ts',
  'test/docker/resource-watchdog-supervisor.test.ts',
] as const;

const APPLE_LIVE_GATES = [
  { script: 'smoke-nested-apple-workflow.ts', arguments: ['--packages'] },
  { script: 'smoke-nested-apple-workflow.ts', arguments: ['--images'] },
  { script: 'smoke-nested-apple-workflow.ts', arguments: ['--offline'] },
  { script: 'smoke-nested-apple.ts', arguments: ['--pty'] },
] as const satisfies readonly QualificationLiveGate[];

const DOCKER_DESKTOP_LIVE_GATES = DOCKER_DESKTOP_QUALIFICATION_ARGUMENTS.map((arguments_) => ({
  script: 'smoke-nested-apple.ts' as const,
  arguments: arguments_,
}));

export function getBackendQualificationPlan(backend: string | undefined): BackendQualificationPlan {
  switch (backend) {
    case 'apple':
      return {
        backend,
        label: 'Apple',
        suiteId: 'apple',
        testFiles: APPLE_TEST_FILES,
        liveGates: APPLE_LIVE_GATES,
      };
    case 'docker-desktop':
      return {
        backend,
        label: 'Docker Desktop',
        suiteId: 'docker-desktop',
        testFiles: DOCKER_DESKTOP_TEST_FILES,
        liveGates: DOCKER_DESKTOP_LIVE_GATES,
      };
    default:
      throw new Error('backend must be apple or docker-desktop');
  }
}
