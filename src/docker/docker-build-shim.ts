/**
 * Package-mode Docker build and BuildKit-trust artifacts.
 *
 * This module deliberately does not stage or mount anything itself. It gives
 * the Apple lifecycle one compact, immutable contract to materialize after
 * admission. Non-package modes return no contract and therefore acquire no
 * build-proxy artifact, state directory, or preflight.
 */

import type { DockerWorkloadNetworkAccess } from '../docker-workload/config.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
  APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
} from '../docker-workload/apple-vm-daemon.js';
import { BUILD_TRUST_RUNTIME_CONTRACT as buildTrustRuntimeContract } from './build-trust-runtime-contract.js';

export const DOCKER_BUILD_SHIM_DIRECTORY = '/usr/local/sbin';
export const DOCKER_BUILD_SHIM_PATH = `${DOCKER_BUILD_SHIM_DIRECTORY}/docker`;
export const DOCKER_BUILD_PROXY_CONFIG_DIRECTORY = '/run/ironcurtain-docker/package-build-client';
export const DOCKER_BUILD_PROXY_CONFIG_PATH = `${DOCKER_BUILD_PROXY_CONFIG_DIRECTORY}/config.json`;
export const DOCKER_BUILDX_STATE_DIRECTORY = '/run/ironcurtain-docker/package-buildx';
export const DOCKER_BUILDX_DEFAULT_BUILDER = 'default';
export const DOCKER_BUILD_PACKAGE_PROXY_URL = APPLE_VM_PACKAGE_EGRESS_PROXY_URL;
export const DOCKER_BUILD_REAL_CLIENT = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`;
export const DOCKER_BUILD_TRUST_WRAPPER_PATH = `${DOCKER_BUILD_SHIM_DIRECTORY}/runc`;
export const DOCKER_BUILD_TRUST_CONTRACT_PATH = '/opt/ironcurtain-build-trust/build-trust-contract.json';
export const DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY = buildTrustRuntimeContract.trustContract.parentDirectory.path;
export const DOCKER_BUILD_TRUST_CA_CERT_PATH = `${DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY}/ca-cert.pem`;
export const DOCKER_BUILD_TRUST_CA_BUNDLE_PATH = `${DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY}/ca-bundle.pem`;
export const DOCKER_BUILD_TRUST_APT_CONFIG_PATH = `${DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY}/apt.conf`;
export const DOCKER_BUILD_TRUST_WRAPPER_PACKAGE_PATH = buildTrustRuntimeContract.wrapper.packagePath;
export const DOCKER_BUILD_TRUST_WRAPPER_SHA256 = buildTrustRuntimeContract.wrapper.sha256;
export const DOCKER_BUILD_TRUST_WRAPPER_SIZE = buildTrustRuntimeContract.wrapper.size;
export const DOCKER_BUILD_TRUST_WRAPPER_PACKAGE_MODE = parseContractMode(
  buildTrustRuntimeContract.wrapper.packageMode,
  'wrapper package mode',
);
export const DOCKER_BUILD_TRUST_WRAPPER_GUEST_MODE = parseContractMode(
  buildTrustRuntimeContract.wrapper.guestMode,
  'wrapper guest mode',
);
export const DOCKER_BUILD_TRUST_REAL_RUNC_PATH = buildTrustRuntimeContract.realRunc.path;
export const DOCKER_BUILD_TRUST_REAL_RUNC_SHA256 = buildTrustRuntimeContract.realRunc.sha256;
export const DOCKER_BUILD_TRUST_REAL_RUNC_SIZE = buildTrustRuntimeContract.realRunc.size;
export const DOCKER_BUILD_TRUST_REAL_RUNC_VERSION = buildTrustRuntimeContract.realRunc.version;
export const DOCKER_BUILD_TRUST_REAL_RUNC_OWNER_PAIRS = buildTrustRuntimeContract.realRunc.ownerPairs;
export const DOCKER_BUILD_TRUST_REAL_RUNC_NLINK = buildTrustRuntimeContract.realRunc.nlink;
export const DOCKER_BUILD_TRUST_REAL_RUNC_MODE = parseContractMode(
  buildTrustRuntimeContract.realRunc.mode,
  'real runc mode',
);
export const DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY_MODE = parseContractMode(
  buildTrustRuntimeContract.trustContract.parentDirectory.mode,
  'trust contract parent directory mode',
);
export const DOCKER_BUILD_TRUST_CONTRACT_MODE = parseContractMode(
  buildTrustRuntimeContract.trustContract.mode,
  'trust contract mode',
);
export const DOCKER_BUILD_TRUST_CONTRACT_NLINK = buildTrustRuntimeContract.trustContract.nlink;
export const DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND = buildTrustRuntimeContract.failureDiagnostic.clearCommand;
export const DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND = buildTrustRuntimeContract.failureDiagnostic.readCommand;
export const DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE = buildTrustRuntimeContract.failureDiagnostic.unavailableCode;
export const DOCKER_BUILD_TRUST_FAILURE_MAX_CODE_BYTES = buildTrustRuntimeContract.failureDiagnostic.maxCodeBytes;
export const DOCKER_BUILD_TRUST_FAILURE_ALLOWED_CODES = new Set<string>(
  buildTrustRuntimeContract.failureDiagnostic.allowedCodes,
);

function parseContractMode(value: string, label: string): number {
  if (!/^0[0-7]{3}$/u.test(value)) throw new Error(`build-trust runtime ${label} is not a canonical mode`);
  return Number.parseInt(value, 8);
}

export interface DockerBuildShimArtifact {
  readonly targetPath: string;
  readonly content: string;
  readonly mode: number;
}

export interface DockerBuildTrustStaticArtifact {
  readonly targetPath: string;
  readonly packagePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly packageMode: number;
  readonly guestMode: number;
}

export interface DockerBuildTrustGeneratedArtifact {
  readonly targetPath: string;
  readonly mode: number;
}

export interface DockerBuildShimDirectory {
  readonly path: string;
  readonly mode: number;
}

export interface DockerBuildTrustCanaryContract {
  /** Authenticated host CA generation embedded in the exact staged trust contract. */
  readonly caGeneration: string;
  readonly buildTrustContractSha256: string;
  readonly caCertificateSha256: string;
  readonly caBundleSha256: string;
  readonly aptConfigSha256: string;
}

/** Runtime-facing contract; source paths are chosen inside the bundle root. */
export interface DockerBuildShimStagingContract {
  readonly shimArtifact: DockerBuildShimArtifact;
  readonly proxyConfigArtifact: DockerBuildShimArtifact;
  readonly buildTrustWrapperArtifact: DockerBuildTrustStaticArtifact;
  readonly buildTrustContractArtifact: DockerBuildTrustGeneratedArtifact;
  readonly aptConfigArtifact: DockerBuildTrustGeneratedArtifact;
  readonly writableDirectories: readonly DockerBuildShimDirectory[];
  readonly preflight: {
    /** Resolve through the staged PATH and require this exact shim path. */
    readonly executable: 'docker';
    readonly expectedPath: string;
    /** Invoke by name only after the path identity check succeeds. */
    readonly argv: readonly string[];
  };
  readonly buildTrustPreflight: {
    readonly executable: 'runc';
    readonly expectedPath: string;
    readonly versionArgv: readonly string[];
    readonly expectedVersionPrefix: string;
    readonly trustContract: {
      readonly path: string;
      readonly parentDirectory: {
        readonly path: string;
        readonly uid: number;
        readonly gid: number;
        readonly mode: number;
        readonly ownerPairs: readonly [
          { readonly uid: 0; readonly gid: 0 },
          { readonly uid: 65534; readonly gid: 65534 },
        ];
      };
      readonly mode: number;
      readonly nlink: number;
      readonly requiresEffectiveReadOnly: true;
    };
    readonly realRunc: {
      readonly path: string;
      readonly sha256: string;
      readonly size: number;
      readonly outerUid: number;
      readonly outerGid: number;
      readonly mode: number;
      readonly nlink: number;
    };
  };
}

/**
 * Render the credential-free Docker client proxy configuration. Docker turns
 * these two fields into both upper- and lower-case predefined HTTP/HTTPS build
 * arguments without adding them to the caller's argv.
 */
export function renderDockerBuildProxyConfig(): string {
  return `${JSON.stringify(
    {
      proxies: {
        default: {
          httpProxy: DOCKER_BUILD_PACKAGE_PROXY_URL,
          httpsProxy: DOCKER_BUILD_PACKAGE_PROXY_URL,
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** Render the argv-preserving Bash shim installed ahead of the pinned client. */
export function renderDockerBuildShim(): string {
  return `#!/bin/bash
set -u

REAL_DOCKER=${DOCKER_BUILD_REAL_CLIENT}
ADMITTED_DOCKER_HOST=${APPLE_VM_DAEMON_DOCKER_HOST}
BUILD_CONFIG_DIR=${DOCKER_BUILD_PROXY_CONFIG_DIRECTORY}
BUILDX_STATE_DIR=${DOCKER_BUILDX_STATE_DIRECTORY}
BUILDX_DEFAULT_BUILDER=${DOCKER_BUILDX_DEFAULT_BUILDER}

fail() {
  printf 'IronCurtain Docker build: %s\\n' "$1" >&2
  exit 64
}

args=("$@")
argc=\${#args[@]}
command_index=-1
global_error=''
i=0

# Parse only Docker's documented global-option grammar. Unsupported selectors
# are remembered until the command is known so non-build commands remain exact
# pass-throughs.
while (( i < argc )); do
  token=\${args[i]}
  case "$token" in
    -D|--debug)
      ((i += 1))
      ;;
    -l|--log-level)
      if (( i + 1 >= argc )); then
        exec "$REAL_DOCKER" "$@"
      fi
      ((i += 2))
      ;;
    -l=*|--log-level=*|-l?*)
      ((i += 1))
      ;;
    -H|--host)
      if (( i + 1 >= argc )); then
        exec "$REAL_DOCKER" "$@"
      fi
      value=\${args[i + 1]}
      if [[ "$value" != "$ADMITTED_DOCKER_HOST" ]]; then
        global_error="--host must be $ADMITTED_DOCKER_HOST"
      fi
      ((i += 2))
      ;;
    -H=*|--host=*)
      value=\${token#*=}
      if [[ "$value" != "$ADMITTED_DOCKER_HOST" ]]; then
        global_error="--host must be $ADMITTED_DOCKER_HOST"
      fi
      ((i += 1))
      ;;
    -H?*)
      value=\${token#-H}
      if [[ "$value" != "$ADMITTED_DOCKER_HOST" ]]; then
        global_error="--host must be $ADMITTED_DOCKER_HOST"
      fi
      ((i += 1))
      ;;
    -c|--context|--config|--tlscacert|--tlscert|--tlskey)
      global_error="$token is unsupported for IronCurtain package builds"
      if (( i + 1 >= argc )); then
        exec "$REAL_DOCKER" "$@"
      fi
      ((i += 2))
      ;;
    -c=*|--context=*|--config=*|--tlscacert=*|--tlscert=*|--tlskey=*|-c?*)
      global_error="$token is unsupported for IronCurtain package builds"
      ((i += 1))
      ;;
    --tls|--tlsverify)
      global_error="$token is unsupported for IronCurtain package builds"
      ((i += 1))
      ;;
    -v|--version|--help|-h)
      exec "$REAL_DOCKER" "$@"
      ;;
    --)
      global_error='Docker global -- is unsupported for IronCurtain package builds'
      ((i += 1))
      if (( i < argc )); then command_index=$i; fi
      break
      ;;
    -*)
      global_error="unrecognized Docker global option $token"
      ((i += 1))
      ;;
    *)
      command_index=$i
      break
      ;;
  esac
done

if (( command_index < 0 )); then
  exec "$REAL_DOCKER" "$@"
fi

command=\${args[command_index]}
build_index=-1
build_kind=''

case "$command" in
  build)
    build_index=$command_index
    build_kind=build
    ;;
  image|builder)
    next_index=$((command_index + 1))
    if (( next_index < argc )) && [[ "\${args[next_index]}" == build ]]; then
      build_index=$next_index
      build_kind=$command
    fi
    ;;
  bake)
    fail 'docker bake is unsupported; use a supported direct docker build command'
    ;;
esac

if [[ "$command" == buildx ]]; then
  buildx_command_index=-1
  buildx_builder_insert_index=-1
  buildx_error=''
  k=$((command_index + 1))
  while (( k < argc )); do
    token=\${args[k]}
    case "$token" in
      -D|--debug)
        ((k += 1))
        ;;
      --builder)
        buildx_error='--builder is unsupported; use the isolated local default Docker driver'
        if (( k + 1 >= argc )); then exec "$REAL_DOCKER" "$@"; fi
        ((k += 2))
        ;;
      --builder=*)
        buildx_error='--builder is unsupported; use the isolated local default Docker driver'
        ((k += 1))
        ;;
      --)
        buildx_builder_insert_index=$k
        ((k += 1))
        if (( k < argc )); then buildx_command_index=$k; fi
        break
        ;;
      -*)
        buildx_error="unrecognized docker buildx global option $token"
        ((k += 1))
        ;;
      *)
        buildx_command_index=$k
        buildx_builder_insert_index=$k
        break
        ;;
    esac
  done

  if (( buildx_command_index >= 0 )); then
    case "\${args[buildx_command_index]}" in
      build)
        build_index=$buildx_command_index
        build_kind=buildx
        if [[ -n "$buildx_error" ]]; then global_error=$buildx_error; fi
        ;;
      bake)
        fail 'docker buildx bake is unsupported; use docker buildx build directly'
        ;;
    esac
  fi
fi

if [[ "$command" == compose ]]; then
  compose_command_index=-1
  k=$((command_index + 1))
  while (( k < argc )); do
    token=\${args[k]}
    case "$token" in
      --all-resources|--compatibility|--dry-run)
        ((k += 1))
        ;;
      --ansi|--env-file|-f|--file|--parallel|--profile|--progress|--project-directory|-p|--project-name)
        if (( k + 1 >= argc )); then exec "$REAL_DOCKER" "$@"; fi
        ((k += 2))
        ;;
      --ansi=*|--env-file=*|-f=*|--file=*|--parallel=*|--profile=*|--progress=*|--project-directory=*|-p=*|--project-name=*|-f?*|-p?*)
        ((k += 1))
        ;;
      --)
        ((k += 1))
        if (( k < argc )); then compose_command_index=$k; fi
        break
        ;;
      -*)
        # Unknown future Compose globals remain exact pass-through rather than
        # guessing whether a following token is their value.
        break
        ;;
      *)
        compose_command_index=$k
        break
        ;;
    esac
  done

  if (( compose_command_index >= 0 )); then
    compose_command=\${args[compose_command_index]}
    if [[ "$compose_command" == build ]]; then
      fail 'Compose builds are unsupported; use docker build, docker image build, docker builder build, or docker buildx build directly'
    fi
    if [[ "$compose_command" == watch ]]; then
      fail 'Compose watch is unsupported because rebuild actions bypass the admitted direct-build path'
    fi

    if [[ "$compose_command" == run ]]; then
      # Pinned Compose 5.1.0 always gives run a BuildOptions path and exposes
      # no --no-build flag. Do not scan past SERVICE: run disables
      # interspersed flag parsing there, so later tokens belong to the payload.
      fail 'Compose builds are unsupported: docker compose run may build from its service definition and has no --no-build option; use docker run with a prebuilt image'
    fi

    if [[ "$compose_command" == up || "$compose_command" == create ]]; then
      compose_no_build=0
      j=$((compose_command_index + 1))
      while (( j < argc )); do
        token=\${args[j]}
        case "$token" in
          --)
            break
            ;;
          --no-build)
            compose_no_build=1
            ((j += 1))
            ;;
          --no-build=*)
            fail 'Compose builds are unsupported: use the exact --no-build flag without a value'
            ;;
          --build|--build=*)
            fail 'Compose builds are unsupported; use a supported direct docker build command first'
            ;;
          --watch|-w|--watch=*|-w?*)
            fail 'Compose watch is unsupported because rebuild actions bypass the admitted direct-build path'
            ;;
          --menu=false)
            ((j += 1))
            ;;
          --menu|--menu=*)
            fail 'Compose navigation menus are unsupported because they can activate watch/rebuild actions'
            ;;
          # Value-taking up/create options in pinned Compose 5.1.0. Skip the
          # value so a literal --no-build used as data cannot authorize the
          # command. Equal/attached spellings consume only their own token.
          --pull|--scale|--exit-code-from|--timeout|-t|--attach|--no-attach|--wait-timeout|--ansi|--env-file|-f|--file|--parallel|--profile|--progress|--project-directory|-p|--project-name)
            if (( j + 1 >= argc )); then break; fi
            ((j += 2))
            ;;
          --pull=*|--scale=*|--exit-code-from=*|--timeout=*|-t?*|--attach=*|--no-attach=*|--wait-timeout=*|--ansi=*|--env-file=*|-f=*|--file=*|--parallel=*|--profile=*|--progress=*|--project-directory=*|-p=*|--project-name=*|-f?*|-p?*)
            ((j += 1))
            ;;
          *)
            ((j += 1))
            ;;
        esac
      done
      if (( compose_no_build == 0 )); then
        fail "Compose builds are unsupported: docker compose $compose_command may build from service definitions; pass exact --no-build or use a supported direct docker build command first"
      fi
      if [[ "$compose_command" == up ]]; then
        # Compose 5.1 enables its navigation menu by default on a terminal and
        # COMPOSE_MENU can enable it implicitly. The menu exposes watch/rebuild,
        # so admitted non-building up always pins it off without changing argv.
        export COMPOSE_MENU=false
      fi
    fi
  fi
fi

# Every non-build command is byte-for-byte pass-through and receives no proxy
# configuration, even if its environment or global options would be rejected
# for a supported build.
if (( build_index < 0 )); then
  exec "$REAL_DOCKER" "$@"
fi

if [[ -n "$global_error" ]]; then fail "$global_error"; fi

if [[ \${DOCKER_CONTEXT+x} ]]; then fail 'unset DOCKER_CONTEXT; only the admitted private daemon is supported'; fi
if [[ \${DOCKER_CONFIG+x} ]]; then fail 'unset DOCKER_CONFIG; IronCurtain selects a credential-free build client configuration'; fi
if [[ \${BUILDKIT_HOST+x} ]]; then fail 'unset BUILDKIT_HOST; remote BuildKit daemons are unsupported'; fi
if [[ \${BUILDX_CONFIG+x} ]]; then fail 'unset BUILDX_CONFIG; IronCurtain isolates Buildx state'; fi
if [[ \${BUILDX_BUILDER+x} ]]; then fail 'unset BUILDX_BUILDER; custom Buildx builders are unsupported'; fi
if [[ \${DOCKER_TLS_VERIFY+x} ]]; then fail 'unset DOCKER_TLS_VERIFY; TLS daemon selection is unsupported'; fi
if [[ \${DOCKER_CERT_PATH+x} ]]; then fail 'unset DOCKER_CERT_PATH; TLS daemon selection is unsupported'; fi
if [[ \${DOCKER_HOST+x} ]]; then
  if [[ "\${DOCKER_HOST-}" != "$ADMITTED_DOCKER_HOST" ]]; then
    fail "DOCKER_HOST must be $ADMITTED_DOCKER_HOST"
  fi
fi

network=''
network_count=0
for ((j = 0; j < argc; j++)); do
  token=\${args[j]}
  case "$token" in
    --context|-c|--config|--builder)
      fail "$token is unsupported for IronCurtain package builds"
      ;;
    --context=*|-c=*|-c?*|--config=*|--builder=*)
      fail "$token is unsupported for IronCurtain package builds"
      ;;
    --host|-H)
      if (( j + 1 >= argc )); then fail "$token requires $ADMITTED_DOCKER_HOST"; fi
      value=\${args[j + 1]}
      if [[ "$value" != "$ADMITTED_DOCKER_HOST" ]]; then fail "$token must be $ADMITTED_DOCKER_HOST"; fi
      ((j += 1))
      ;;
    --host=*|-H=*)
      value=\${token#*=}
      if [[ "$value" != "$ADMITTED_DOCKER_HOST" ]]; then fail "--host must be $ADMITTED_DOCKER_HOST"; fi
      ;;
    -H?*)
      value=\${token#-H}
      if [[ "$value" != "$ADMITTED_DOCKER_HOST" ]]; then fail "-H must be $ADMITTED_DOCKER_HOST"; fi
      ;;
  esac

  if (( j <= build_index )); then continue; fi
  case "$token" in
    --network)
      if (( j + 1 >= argc )); then fail '--network requires host or none'; fi
      network=\${args[j + 1]}
      ((network_count += 1))
      ((j += 1))
      ;;
    --network=*)
      network=\${token#*=}
      ((network_count += 1))
      ;;
  esac
done

if (( network_count > 1 )); then fail 'specify --network at most once'; fi
if [[ -n "$network" && "$network" != host && "$network" != none ]]; then
  fail "--network=$network is unsupported; use host for package access or none for a per-build offline opt-out"
fi

export DOCKER_HOST="$ADMITTED_DOCKER_HOST"
export DOCKER_CONFIG="$BUILD_CONFIG_DIR"
export BUILDX_CONFIG="$BUILDX_STATE_DIR"

forward=()
for ((j = 0; j <= build_index; j++)); do
  # Buildx's selected-builder state is writable for normal non-build commands.
  # Override it for admitted builds with the daemon-created Docker-driver
  # builder, which Buildx reserves under the exact name "default".
  if [[ "$build_kind" == buildx ]] && (( j == buildx_builder_insert_index )); then
    forward+=(--builder "$BUILDX_DEFAULT_BUILDER")
  fi
  forward+=("\${args[j]}")
done
if (( network_count == 0 )); then forward+=(--network=host); fi
for ((j = build_index + 1; j < argc; j++)); do forward+=("\${args[j]}"); done
exec "$REAL_DOCKER" "\${forward[@]}"
`;
}

/** Return artifacts only for the admitted package-network mode. */
export function getDockerBuildShimStagingContract(
  networkAccess: DockerWorkloadNetworkAccess,
): DockerBuildShimStagingContract | undefined {
  if (networkAccess !== 'packages') return undefined;

  return {
    shimArtifact: {
      targetPath: DOCKER_BUILD_SHIM_PATH,
      content: renderDockerBuildShim(),
      mode: 0o555,
    },
    proxyConfigArtifact: {
      targetPath: DOCKER_BUILD_PROXY_CONFIG_PATH,
      content: renderDockerBuildProxyConfig(),
      mode: 0o444,
    },
    buildTrustWrapperArtifact: {
      targetPath: DOCKER_BUILD_TRUST_WRAPPER_PATH,
      packagePath: DOCKER_BUILD_TRUST_WRAPPER_PACKAGE_PATH,
      sha256: DOCKER_BUILD_TRUST_WRAPPER_SHA256,
      size: DOCKER_BUILD_TRUST_WRAPPER_SIZE,
      packageMode: DOCKER_BUILD_TRUST_WRAPPER_PACKAGE_MODE,
      guestMode: DOCKER_BUILD_TRUST_WRAPPER_GUEST_MODE,
    },
    buildTrustContractArtifact: {
      targetPath: DOCKER_BUILD_TRUST_CONTRACT_PATH,
      mode: 0o444,
    },
    aptConfigArtifact: {
      targetPath: DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
      mode: 0o444,
    },
    writableDirectories: [{ path: DOCKER_BUILDX_STATE_DIRECTORY, mode: 0o700 }],
    preflight: {
      executable: 'docker',
      expectedPath: DOCKER_BUILD_SHIM_PATH,
      argv: ['docker', 'version', '--format', '{{json .Client}}'],
    },
    buildTrustPreflight: {
      executable: 'runc',
      expectedPath: DOCKER_BUILD_TRUST_WRAPPER_PATH,
      versionArgv: ['runc', '--version'],
      expectedVersionPrefix: `runc version ${DOCKER_BUILD_TRUST_REAL_RUNC_VERSION}\n`,
      trustContract: {
        path: DOCKER_BUILD_TRUST_CONTRACT_PATH,
        parentDirectory: {
          path: DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
          uid: buildTrustRuntimeContract.trustContract.parentDirectory.uid,
          gid: buildTrustRuntimeContract.trustContract.parentDirectory.gid,
          mode: DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY_MODE,
          ownerPairs: buildTrustRuntimeContract.trustContract.parentDirectory.ownerPairs,
        },
        mode: DOCKER_BUILD_TRUST_CONTRACT_MODE,
        nlink: DOCKER_BUILD_TRUST_CONTRACT_NLINK,
        requiresEffectiveReadOnly: buildTrustRuntimeContract.trustContract.requiresEffectiveReadOnly,
      },
      realRunc: {
        path: DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
        sha256: DOCKER_BUILD_TRUST_REAL_RUNC_SHA256,
        size: DOCKER_BUILD_TRUST_REAL_RUNC_SIZE,
        outerUid: DOCKER_BUILD_TRUST_REAL_RUNC_OWNER_PAIRS[0].uid,
        outerGid: DOCKER_BUILD_TRUST_REAL_RUNC_OWNER_PAIRS[0].gid,
        mode: DOCKER_BUILD_TRUST_REAL_RUNC_MODE,
        nlink: DOCKER_BUILD_TRUST_REAL_RUNC_NLINK,
      },
    },
  };
}
