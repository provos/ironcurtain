/** Source-controlled release gates selected by scripts/qualify-backend.ts. */

import { DOCKER_DESKTOP_QUALIFICATION_ARGUMENTS } from './smoke-nested-apple-workload.js';
import { WORKFLOW_GATE_TIMEOUT_MS } from './workflow-smoke-timeouts.js';
import { PTY_GATE_TERM_GRACE_MS } from './pty-smoke-timeouts.js';

export function qualificationTerminationGraceMs(gate: { readonly arguments: readonly string[] }): number | undefined {
  return gate.arguments.some((argument) => argument === '--pty' || argument === '--docker-desktop-pty')
    ? PTY_GATE_TERM_GRACE_MS
    : undefined;
}

export function qualificationTimeoutMs(value: string | undefined, script?: QualificationLiveGate['script']): number {
  const timeoutMs =
    value === undefined
      ? script === 'smoke-nested-apple-workflow.ts'
        ? WORKFLOW_GATE_TIMEOUT_MS
        : 30 * 60_000
      : Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 24 * 60 * 60_000) {
    throw new Error('qualification suite timeout is invalid');
  }
  return timeoutMs;
}

export type QualificationBackend = 'apple' | 'docker-desktop' | 'wsl-desktop';

export interface QualificationLiveGate {
  readonly script: 'smoke-nested-apple.ts' | 'smoke-nested-apple-workflow.ts';
  readonly arguments: readonly string[];
}

export interface BackendQualificationPlan {
  readonly backend: QualificationBackend;
  readonly label: string;
  readonly suiteId: string;
  readonly testFiles: readonly string[];
  readonly testEnvironment?: Readonly<Record<string, string>>;
  readonly liveGates: readonly QualificationLiveGate[];
}

const APPLE_TEST_FILES = [
  'test/docker-manager.test.ts',
  'test/apple-container-manager.test.ts',
  'test/apple-container.integration.test.ts',
] as const;

const DOCKER_DESKTOP_TEST_FILES = [
  'test/smoke-child-process.test.ts',
  'test/docker/qualification-process.test.ts',
  'test/docker/qualification-evidence.test.ts',
  'test/smoke-environment.test.ts',
  'test/proxy-router-mode.test.ts',
  'test/docker/backend-qualification-plan.test.ts',
  'test/smoke-nested-apple-workload.test.ts',
  'test/docker/docker-workload-admission.test.ts',
  'test/docker/desktop-relay.test.ts',
  'test/docker/docker-endpoint.test.ts',
  'test/docker/docker-workload-wiring.test.ts',
  'test/docker/nested-daemon-wiring.test.ts',
  'test/docker/pty-nested-ordering.test.ts',
  'test/docker/pty-cleanup.test.ts',
  'test/docker/docker-workload-prepare-failure.test.ts',
  'test/docker-workload/docker-desktop-sidecar.test.ts',
  'test/docker-workload/qualification-observer.test.ts',
  'test/docker-workload/infrastructure-reconciliation.test.ts',
  'test/docker-workload/infrastructure-teardown.test.ts',
  'test/docker-workload/watchdog-sigkill.integration.test.ts',
  'test/docker/resource-watchdog-supervisor.test.ts',
] as const;

const WSL_DESKTOP_TEST_FILES = [
  ...DOCKER_DESKTOP_TEST_FILES,
  'test/docker/wsl-qualification-preparation.test.ts',
  'test/docker/desktop-relay-uds.integration.test.ts',
  'test/docker-workload/environment.test.ts',
  'test/docker-workload/toolchain-source.test.ts',
  'test/workflow/host-observer.test.ts',
  'test/workflow/nested-docker-live-smoke.test.ts',
  'test/docker/selected-image-file.test.ts',
  'test/docker-workload/profile-ceiling.test.ts',
  'test/docker-workload/nested-daemon-identity.test.ts',
  'test/docker/client-toolchain.test.ts',
  'test/uid-remap.integration.test.ts',
  'test/uid-remap.goose.integration.test.ts',
  'test/uid-remap.codex.integration.test.ts',
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

const WSL_DESKTOP_LIVE_GATES = [
  ...DOCKER_DESKTOP_LIVE_GATES.map((gate) => ({
    ...gate,
    arguments: [...gate.arguments, '--environment', 'wsl-desktop'],
  })),
  ...(['offline', 'images', 'packages'] as const).map((mode) => ({
    script: 'smoke-nested-apple-workflow.ts' as const,
    arguments: [`--${mode}`, '--environment', 'wsl-desktop'],
  })),
] satisfies readonly QualificationLiveGate[];

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
    case 'wsl-desktop':
      return {
        backend,
        label: 'WSL / Docker Desktop (amd64)',
        suiteId: 'wsl-desktop',
        testFiles: WSL_DESKTOP_TEST_FILES,
        testEnvironment: { DESKTOP_RELAY_UDS_INTEGRATION: '1' },
        liveGates: WSL_DESKTOP_LIVE_GATES,
      };
    default:
      throw new Error('backend must be apple or docker-desktop or wsl-desktop');
  }
}
