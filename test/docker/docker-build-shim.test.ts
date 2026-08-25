import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPLE_VM_DAEMON_DOCKER_HOST } from '../../src/docker-workload/apple-vm-daemon.js';
import {
  DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
  DOCKER_BUILD_PROXY_CONFIG_PATH,
  DOCKER_BUILD_PACKAGE_PROXY_URL,
  DOCKER_BUILD_REAL_CLIENT,
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
  DOCKER_BUILDX_DEFAULT_BUILDER,
  DOCKER_BUILDX_STATE_DIRECTORY,
  getDockerBuildShimStagingContract,
  renderDockerBuildProxyConfig,
  renderDockerBuildShim,
} from '../../src/docker/docker-build-shim.js';

const SELECTOR_ENV = [
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'BUILDKIT_HOST',
  'BUILDX_CONFIG',
  'BUILDX_BUILDER',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
] as const;

describe('Docker package-build staging contract', () => {
  it('exists only in packages mode and exposes exact read-only mounts and preflight', () => {
    expect(getDockerBuildShimStagingContract('offline')).toBeUndefined();
    expect(getDockerBuildShimStagingContract('images')).toBeUndefined();

    const contract = getDockerBuildShimStagingContract('packages');
    expect(contract).toBeDefined();
    expect(contract!.preflight).toEqual({
      executable: 'docker',
      expectedPath: DOCKER_BUILD_SHIM_PATH,
      argv: ['docker', 'version', '--format', '{{json .Client}}'],
    });
    expect(contract!.shimArtifact).toMatchObject({ targetPath: DOCKER_BUILD_SHIM_PATH, mode: 0o555 });
    expect(contract!.proxyConfigArtifact).toMatchObject({
      targetPath: DOCKER_BUILD_PROXY_CONFIG_PATH,
      mode: 0o444,
    });
    expect(contract!.writableDirectories).toEqual([{ path: DOCKER_BUILDX_STATE_DIRECTORY, mode: 0o700 }]);
    expect(contract!.buildTrustPreflight.trustContract.parentDirectory).toEqual({
      path: DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
      uid: 0,
      gid: 0,
      mode: 0o755,
      ownerPairs: [
        { uid: 0, gid: 0 },
        { uid: 65534, gid: 65534 },
      ],
    });
    expect(contract!.buildTrustPreflight.trustContract).not.toHaveProperty('ownerPairs');
    expect(contract!.buildTrustPreflight.trustContract.requiresEffectiveReadOnly).toBe(true);
  });

  it('requires the immutable trust parent to be precreated only by the selected image', () => {
    const dockerfile = readFileSync('docker/Dockerfile.base.arm64', 'utf8');
    expect(dockerfile).toContain('install -d -o root -g root -m 0755 /opt/ironcurtain-build-trust');
    const contract = getDockerBuildShimStagingContract('packages')!;
    expect(contract.writableDirectories.map(({ path }) => path)).not.toContain(DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY);
  });

  it('generates only the credential-free loopback proxy configuration', () => {
    const content = renderDockerBuildProxyConfig();
    expect(JSON.parse(content)).toEqual({
      proxies: {
        default: {
          httpProxy: DOCKER_BUILD_PACKAGE_PROXY_URL,
          httpsProxy: DOCKER_BUILD_PACKAGE_PROXY_URL,
        },
      },
    });
    expect(content).not.toMatch(/auth|credential|helper|password|token|username|ca(?:cert)?|hostname/iu);
    expect(content).not.toMatch(/https?:\/\/(?!127\.0\.0\.1:18082)/u);
  });

  it('pins the real client instead of looking it up through PATH', () => {
    const shim = renderDockerBuildShim();
    expect(shim).toContain(`REAL_DOCKER=${DOCKER_BUILD_REAL_CLIENT}`);
    expect(shim).not.toMatch(/(?:command|which)\s+(?:-v\s+)?docker/u);
    expect(shim).not.toContain('eval');
  });
});

describe('executable Docker package-build shim', () => {
  let directory: string;
  let shimPath: string;
  let fakeDockerPath: string;
  let capturedArgvPath: string;
  let capturedEnvPath: string;
  let buildxStatePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ironcurtain-docker-build-shim-'));
    shimPath = join(directory, 'docker');
    fakeDockerPath = join(directory, 'real-docker');
    capturedArgvPath = join(directory, 'argv');
    capturedEnvPath = join(directory, 'env');
    buildxStatePath = join(directory, 'buildx-state');
    mkdirSync(buildxStatePath, { mode: 0o700 });

    const executableShim = renderDockerBuildShim()
      .replace(`REAL_DOCKER=${DOCKER_BUILD_REAL_CLIENT}`, `REAL_DOCKER=${JSON.stringify(fakeDockerPath)}`)
      .replace(
        `BUILDX_STATE_DIR=${DOCKER_BUILDX_STATE_DIRECTORY}`,
        `BUILDX_STATE_DIR=${JSON.stringify(buildxStatePath)}`,
      );
    writeFileSync(shimPath, executableShim, { mode: 0o755 });
    writeFileSync(
      fakeDockerPath,
      `#!/bin/bash
: > "$CAPTURE_ARGV"
for arg in "$@"; do printf '%s\\0' "$arg" >> "$CAPTURE_ARGV"; done
printf '%s\\0%s\\0%s\\0%s\\0' "\${DOCKER_CONFIG-}" "\${BUILDX_CONFIG-}" "\${DOCKER_HOST-}" "\${COMPOSE_MENU-}" > "$CAPTURE_ENV"

fake_args=("$@")
if [[ "\${fake_args[0]-}" == buildx ]]; then
  saw_create=0
  saw_use=0
  saw_build=0
  pinned_default=0
  for ((i = 1; i < \${#fake_args[@]}; i++)); do
    case "\${fake_args[i]}" in
      create) saw_create=1 ;;
      --use) saw_use=1 ;;
      build) saw_build=1 ;;
      --builder)
        if (( i + 1 < \${#fake_args[@]} )) && [[ "\${fake_args[i + 1]}" == default ]]; then
          pinned_default=1
        fi
        ;;
    esac
  done
  if (( saw_create == 1 && saw_use == 1 )) && [[ -n "\${BUILDX_CONFIG-}" ]]; then
    printf 'remote\\n' > "$BUILDX_CONFIG/selected-builder"
  fi
  if (( saw_build == 1 && pinned_default == 0 )) && [[ -f "\${BUILDX_CONFIG-}/selected-builder" ]]; then
    exit 91
  fi
fi
exit "\${FAKE_EXIT_STATUS:-0}"
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function run(
    argv: readonly string[],
    options: { readonly env?: Readonly<Record<string, string>>; readonly exitStatus?: number } = {},
  ) {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value;
    }
    for (const name of SELECTOR_ENV) delete env[name];
    delete env.DOCKER_HOST;
    delete env.COMPOSE_MENU;
    Object.assign(env, options.env);
    env.CAPTURE_ARGV = capturedArgvPath;
    env.CAPTURE_ENV = capturedEnvPath;
    env.FAKE_EXIT_STATUS = String(options.exitStatus ?? 0);

    const result = spawnSync('/bin/bash', [shimPath, ...argv], { encoding: 'utf8', env });
    const capturedArgv = existsSync(capturedArgvPath)
      ? readFileSync(capturedArgvPath).toString('utf8').split('\0').slice(0, -1)
      : undefined;
    const capturedEnv = existsSync(capturedEnvPath)
      ? readFileSync(capturedEnvPath).toString('utf8').split('\0').slice(0, -1)
      : undefined;
    return { result, capturedArgv, capturedEnv };
  }

  it.each([
    { input: ['build', '.'], output: ['build', '--network=host', '.'] },
    { input: ['image', 'build', '-t', 'demo', '.'], output: ['image', 'build', '--network=host', '-t', 'demo', '.'] },
    { input: ['builder', 'build', '.'], output: ['builder', 'build', '--network=host', '.'] },
    {
      input: ['buildx', 'build', '.'],
      output: ['buildx', '--builder', DOCKER_BUILDX_DEFAULT_BUILDER, 'build', '--network=host', '.'],
    },
  ])('injects host networking immediately after the supported $input build spelling', ({ input, output }) => {
    const { result, capturedArgv, capturedEnv } = run(input);
    expect(result.status, result.stderr).toBe(0);
    expect(capturedArgv).toEqual(output);
    expect(capturedEnv?.[0]).toBe(DOCKER_BUILD_PROXY_CONFIG_DIRECTORY);
    expect(capturedEnv?.[1]).toBe(buildxStatePath);
    expect(capturedEnv?.[2]).toBe(APPLE_VM_DAEMON_DOCKER_HOST);
  });

  it('allows documented global options and the exact private daemon host', () => {
    const input = ['--debug', '--log-level', 'warn', '--host', APPLE_VM_DAEMON_DOCKER_HOST, 'build', '--pull', '.'];
    const { result, capturedArgv } = run(input);
    expect(result.status, result.stderr).toBe(0);
    expect(capturedArgv).toEqual([
      '--debug',
      '--log-level',
      'warn',
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'build',
      '--network=host',
      '--pull',
      '.',
    ]);
  });

  it('pins Buildx to the local default after pass-through state selects a custom builder', () => {
    const mutation = ['buildx', 'create', '--name', 'remote', '--use', 'tcp://builder.example:1234'];
    const mutated = run(mutation, { env: { BUILDX_CONFIG: buildxStatePath } });
    expect(mutated.result.status, mutated.result.stderr).toBe(0);
    expect(mutated.capturedArgv).toEqual(mutation);
    expect(mutated.capturedEnv).toEqual(['', buildxStatePath, '', '']);
    expect(readFileSync(join(buildxStatePath, 'selected-builder'), 'utf8')).toBe('remote\n');

    const built = run(['buildx', '--debug', 'build', '--progress=plain', '.']);
    expect(built.result.status, built.result.stderr).toBe(0);
    expect(built.capturedArgv).toEqual([
      'buildx',
      '--debug',
      '--builder',
      DOCKER_BUILDX_DEFAULT_BUILDER,
      'build',
      '--network=host',
      '--progress=plain',
      '.',
    ]);
    expect(built.capturedEnv).toEqual([
      DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
      buildxStatePath,
      APPLE_VM_DAEMON_DOCKER_HOST,
      '',
    ]);
  });

  it.each([['--network=none'], ['--network', 'none'], ['--network=host'], ['--network', 'host']])(
    'preserves the explicit supported build network %j without duplication',
    (...network) => {
      const input = ['build', ...network, '.'];
      const { result, capturedArgv } = run(input);
      expect(result.status, result.stderr).toBe(0);
      expect(capturedArgv).toEqual(input);
    },
  );

  it.each([['bridge'], ['default'], ['ironcurtain']])(
    'rejects unsupported build network %s before execution',
    (network) => {
      const { result, capturedArgv } = run(['build', `--network=${network}`, '.']);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain(`--network=${network} is unsupported`);
      expect(capturedArgv).toBeUndefined();
    },
  );

  it('rejects duplicate build-network selection before execution', () => {
    const { result, capturedArgv } = run(['build', '--network=none', '--network', 'host', '.']);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('at most once');
    expect(capturedArgv).toBeUndefined();
  });

  it.each([
    ['--context', 'remote'],
    ['--context=remote'],
    ['-c', 'remote'],
    ['-c=remote'],
    ['--config', '/tmp/docker'],
    ['--config=/tmp/docker'],
    ['--host', 'tcp://remote:2375'],
    ['--host=tcp://remote:2375'],
    ['-H', 'tcp://remote:2375'],
    ['-H=tcp://remote:2375'],
    ['buildx', 'build', '--builder', 'remote', '.'],
    ['buildx', 'build', '--builder=remote', '.'],
    ['build', '--builder', 'remote', '.'],
    ['build', '--builder=remote', '.'],
    ['buildx', '--builder', 'remote', 'build', '.'],
    ['buildx', '--builder=remote', 'build', '.'],
  ])('rejects caller daemon/config/builder selector %j before execution', (...selector) => {
    const argv = selector[0] === 'buildx' || selector[0] === 'build' ? selector : [...selector, 'build', '.'];
    const { result, capturedArgv } = run(argv);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/unsupported|must be/u);
    expect(capturedArgv).toBeUndefined();
  });

  it.each(SELECTOR_ENV)('rejects caller-supplied %s before executing a build', (name) => {
    const { result, capturedArgv } = run(['build', '.'], { env: { [name]: 'caller-value' } });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(name);
    expect(capturedArgv).toBeUndefined();
  });

  it('rejects a noncanonical DOCKER_HOST but accepts the exact admitted value', () => {
    const rejected = run(['build', '.'], { env: { DOCKER_HOST: 'tcp://remote:2375' } });
    expect(rejected.result.status).toBe(64);
    expect(rejected.capturedArgv).toBeUndefined();

    const accepted = run(['build', '.'], { env: { DOCKER_HOST: APPLE_VM_DAEMON_DOCKER_HOST } });
    expect(accepted.result.status, accepted.result.stderr).toBe(0);
    expect(accepted.capturedArgv).toEqual(['build', '--network=host', '.']);
  });

  it.each([
    ['compose', 'build'],
    ['compose', '-f', 'compose.yaml', 'up'],
    ['compose', 'up', '--build'],
    ['compose', '--profile', 'ci', 'build'],
    ['compose', '--project-name', 'demo', 'build'],
    ['compose', 'create'],
    ['compose', 'create', '--build'],
    ['compose', 'run', 'svc'],
    ['compose', 'run', '--build', 'svc'],
    ['compose', 'run', 'svc', '--build'],
    ['compose', 'watch'],
    ['compose', '--profile', 'ci', 'watch'],
    ['buildx', 'bake'],
    ['bake'],
  ])('rejects unsupported build form %j before execution', (...argv) => {
    const { result, capturedArgv } = run(argv);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/unsupported/u);
    expect(capturedArgv).toBeUndefined();
  });

  it.each([
    ['compose', 'up', '--pull', '--no-build'],
    ['compose', 'up', '--', '--no-build'],
    ['compose', 'up', '--no-build=false'],
    ['compose', 'up', '--no-build=true'],
    ['compose', 'up', '--no-build', '--no-build=false'],
    ['compose', 'up', '--no-build', '--build'],
    ['compose', 'create', '-f', '--no-build'],
  ])('does not mistake Compose option data or non-exact forms for --no-build: %j', (...argv) => {
    const { result, capturedArgv } = run(argv);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('Compose builds are unsupported');
    expect(capturedArgv).toBeUndefined();
  });

  it.each([
    ['compose', 'up', '--no-build', '--watch'],
    ['compose', 'up', '--no-build', '-w'],
    ['compose', 'up', '--no-build', '--watch=false'],
    ['compose', 'create', '--no-build', '--watch'],
    ['compose', 'up', '--no-build', '--menu'],
    ['compose', 'up', '--no-build', '--menu=true'],
    ['compose', 'create', '--no-build', '--menu'],
  ])('rejects Compose watch and navigation-menu controls on an otherwise admitted path: %j', (...argv) => {
    const { result, capturedArgv } = run(argv);
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/Compose (?:watch|navigation menus) (?:is|are) unsupported/u);
    expect(capturedArgv).toBeUndefined();
  });

  it.each([
    ['compose', 'run', 'svc', 'echo', '--no-build'],
    ['compose', 'run', 'svc', '--', 'echo', '--build'],
  ])('rejects build-capable Compose run without parsing its command payload: %j', (...argv) => {
    const { result, capturedArgv } = run(argv);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('docker compose run may build from its service definition');
    expect(capturedArgv).toBeUndefined();
  });

  it.each([
    ['run', '--rm', 'alpine', 'echo', 'build'],
    ['pull', 'alpine'],
    ['network', 'inspect', 'ironcurtain'],
    ['system', 'info'],
    ['compose', 'ps'],
    ['compose', '--project-name', 'build', 'ps'],
  ])('passes non-build argv through exactly with no package-build configuration: %j', (...argv) => {
    const { result, capturedArgv, capturedEnv } = run(argv, {
      env: { DOCKER_CONTEXT: 'ignored-for-non-build', DOCKER_CONFIG: '/caller/config' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(capturedArgv).toEqual(argv);
    expect(capturedEnv).toEqual(['/caller/config', '', '', '']);
  });

  it.each([
    ['compose', 'up', '--no-build'],
    ['compose', 'up', '--detach', 'svc', '--no-build'],
    ['compose', 'up', '--no-build', '--menu=false'],
  ])('pins the navigation menu off for admitted non-building Compose up: %j', (...argv) => {
    const { result, capturedArgv, capturedEnv } = run(argv, { env: { COMPOSE_MENU: 'true' } });
    expect(result.status, result.stderr).toBe(0);
    expect(capturedArgv).toEqual(argv);
    expect(capturedEnv).toEqual(['', '', '', 'false']);
  });

  it('passes admitted non-building Compose create without scanning unavailable watch/menu controls', () => {
    const argv = ['compose', '-f', 'compose.yaml', 'create', '--no-build', 'svc'];
    const { result, capturedArgv, capturedEnv } = run(argv, { env: { COMPOSE_MENU: 'true' } });
    expect(result.status, result.stderr).toBe(0);
    expect(capturedArgv).toEqual(argv);
    expect(capturedEnv).toEqual(['', '', '', 'true']);
  });

  it('preserves real-client exit status', () => {
    const { result } = run(['build', '.'], { exitStatus: 37 });
    expect(result.status).toBe(37);
  });

  it('supports a preflight that resolves docker through PATH to the staged shim', () => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value;
    }
    env.PATH = `${directory}:${process.env.PATH ?? ''}`;
    env.CAPTURE_ARGV = capturedArgvPath;
    env.CAPTURE_ENV = capturedEnvPath;
    env.FAKE_EXIT_STATUS = '0';

    const resolved = spawnSync('/bin/bash', ['-c', 'command -v docker'], { encoding: 'utf8', env });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout.trim()).toBe(shimPath);

    const invoked = spawnSync('docker', ['version', '--format', '{{json .Client}}'], { encoding: 'utf8', env });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(readFileSync(capturedArgvPath).toString('utf8').split('\0').slice(0, -1)).toEqual([
      'version',
      '--format',
      '{{json .Client}}',
    ]);
  });

  it('forwards hostile argv inertly without shell expansion or splitting', () => {
    const substitutionSentinel = join(directory, 'substitution-ran');
    const backtickSentinel = join(directory, 'backtick-ran');
    const hostile = [
      'build',
      '--label',
      `quoted="yes" newline=one\ntwo dollar=$(touch "${substitutionSentinel}") backtick=\`touch "${backtickSentinel}"\` glob=*`,
      '.',
    ];
    const { result, capturedArgv } = run(hostile);
    expect(result.status, result.stderr).toBe(0);
    expect(capturedArgv).toEqual(['build', '--network=host', ...hostile.slice(1)]);
    expect(existsSync(substitutionSentinel)).toBe(false);
    expect(existsSync(backtickSentinel)).toBe(false);
  });
});
