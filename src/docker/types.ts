/**
 * Types for Docker container lifecycle management.
 */

/** Configuration for creating a Docker container. */
export interface DockerContainerConfig {
  /** Docker image name (e.g., "ironcurtain-claude-code:latest"). */
  readonly image: string;

  /** Container name for identification and cleanup. */
  readonly name: string;

  /** Volume mounts. */
  readonly mounts: readonly DockerMount[];

  /** Docker network name for the container. */
  readonly network: string;

  /** Environment variables passed to the container. */
  readonly env: Readonly<Record<string, string>>;

  /** Command to execute (CMD). */
  readonly command: readonly string[];

  /**
   * Override the image's ENTRYPOINT.
   * Optional. When set, uses `--entrypoint` flag on `docker create`.
   * Needed for images like `alpine/socat` that set ENTRYPOINT to a binary.
   */
  readonly entrypoint?: string;

  /**
   * Bundle identity label — emitted as `ironcurtain.bundle=<value>`.
   * Always set for IronCurtain-owned containers; used as the primary
   * key for stale-container detection and for Docker queries. See
   * `docs/designs/workflow-session-identity.md` §7.
   */
  readonly bundleLabel?: string;

  /**
   * Workflow identity label — emitted as `ironcurtain.workflow=<value>`.
   * Set on workflow-mode containers; absent on standalone CLI / PTY
   * sessions. Enables `docker ps --filter label=ironcurtain.workflow=<id>`
   * for resume reclamation and orphan sweeps.
   */
  readonly workflowLabel?: string;

  /**
   * Container scope label — emitted as `ironcurtain.scope=<value>`.
   * Set on workflow-mode containers with the resolved scope value from
   * `AgentStateDefinition.containerScope` (default `"primary"`); absent
   * on standalone CLI / PTY sessions (which have no scope concept).
   */
  readonly scopeLabel?: string;

  /** Additional runtime ownership/housekeeping labels. */
  readonly labels?: Readonly<Record<string, string>>;

  /** Extra --add-host entries (e.g. ["host.docker.internal:172.30.0.3"]). When set, suppresses the default host-gateway mapping. */
  readonly extraHosts?: readonly string[];

  /** Optional resource limits. */
  readonly resources?: {
    readonly memoryMb?: number;
    readonly cpus?: number;
  };

  /**
   * Port bindings in 'hostPort:containerPort' format.
   * Optional. Defaults to no ports exposed.
   *
   * SECURITY NOTE: Agent containers must NEVER expose ports.
   * This field exists solely for service containers (e.g., signal-cli)
   * that need to expose a local API. Only bind to 127.0.0.1 in practice
   * (e.g., '127.0.0.1:18080:8080').
   */
  readonly ports?: readonly string[];

  /**
   * Docker restart policy (e.g., 'unless-stopped', 'on-failure:3').
   * Optional. Defaults to no restart policy (container stops when stopped).
   *
   * Agent containers must NEVER set a restart policy - they are
   * ephemeral per-session containers managed by session lifecycle.
   */
  readonly restartPolicy?: string;

  /**
   * Linux capabilities to re-add after --cap-drop=ALL.
   * Optional. Defaults to none (fully unprivileged).
   *
   * Agent containers add capabilities needed for `sudo apt-get install`
   * to work inside the container (SETUID, SETGID, CHOWN, FOWNER,
   * DAC_OVERRIDE, AUDIT_WRITE). Service containers may need additional
   * capabilities for their entrypoints.
   */
  readonly capAdd?: readonly string[];

  /**
   * Allocate a pseudo-TTY for the container (-t flag).
   * Required for PTY mode where the container runs an interactive process.
   * Optional. Defaults to false (no TTY allocated).
   */
  readonly tty?: boolean;

  /**
   * Guest-listens / host-connects Unix-domain-socket bridges
   * (`container create --publish-socket <hostPath>:<containerPath>`).
   *
   * Apple `container` only — the runtime creates a vsock relay so a
   * socket the guest `bind()`s at `containerPath` becomes reachable on
   * the host at `hostPath`. Used by PTY mode on the `uds` topology to
   * expose the in-container PTY listener without any network interface.
   * The host-side socket materializes when the guest binds, so
   * existence-polling is a valid readiness signal.
   *
   * Docker has no equivalent; `buildCreateArgs` throws when this is set.
   */
  readonly publishSockets?: readonly { readonly hostPath: string; readonly containerPath: string }[];

  /**
   * Override the container's effective user at creation time.
   * Maps to `docker create --user <value>` (formats: `uid`, `uid:gid`,
   * or `name[:group]`).
   *
   * Used on Linux to start the agent container as `0:0` so the
   * entrypoint can renumber the baked codespace user to match the
   * host UID/GID before dropping privileges (see issue #232 and
   * `docker/entrypoint-claude-code.sh`). Must be omitted on macOS,
   * where Docker Desktop's VirtioFS translates UIDs transparently and
   * passing `--user 0:0` would defeat that translation.
   *
   * When this is set to anything other than `codespace`, every
   * `docker exec` against the container must pass `--user codespace`
   * explicitly — Docker treats this field as the default exec user,
   * overriding the Dockerfile `USER` directive.
   */
  readonly user?: string;
}

/** A volume mount for a Docker container. */
export interface DockerMount {
  /** Host path. */
  readonly source: string;
  /** Container path. */
  readonly target: string;
  /** Mount as read-only. */
  readonly readonly: boolean;
}

/** Result of a docker exec command. */
export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockerCommitOptions {
  readonly tag?: string;
  readonly changes?: readonly string[];
  readonly pause?: boolean;
  readonly timeoutMs?: number;
  /**
   * When true, snapshot through docker export/import instead of docker commit
   * so the resulting image is flattened and does not retain the source image
   * as an inspectable parent (a superseded snapshot digest can then be
   * force-removed without a dependent-child-image conflict). Intended for
   * workflow resume snapshots. The image Config that export/import would
   * otherwise drop (ENTRYPOINT/CMD/WORKDIR/USER/ENV) is re-baked from the
   * source container, so a flattened image still behaves like its source.
   */
  readonly flatten?: boolean;
}

export interface DockerImageInfo {
  readonly id: string;
  readonly repoTags: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly created: string;
}

/** Docker network state used by crash reconciliation and subnet allocation. */
export interface DockerNetworkInfo {
  readonly id: string;
  readonly name: string;
  readonly created: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly subnets: readonly string[];
  readonly containerIds: readonly string[];
}

/** Docker container state used by crash reconciliation. */
export interface DockerContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly created: string;
  readonly running: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerNetworkCreateOptions {
  readonly internal?: boolean;
  readonly subnet?: string;
  readonly gateway?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Manages container lifecycle for agent sessions.
 *
 * Implementations wrap a specific container runtime CLI -- Docker today
 * (`createDockerManager()` in docker-manager.ts), Apple `container` planned
 * (see docs/designs/apple-container-runtime.md). Select via
 * `createContainerRuntime()` in container-runtime.ts.
 *
 * Implementations use the runtime's CLI (not an engine API) for simplicity.
 * The runtime is only invoked from the host process, never from inside
 * agent containers.
 */
export interface ContainerRuntime {
  /** True when this runtime can commit containers to images and manage snapshot images. */
  readonly supportsImageSnapshots: boolean;

  /** Check that the runtime is available and the image exists. */
  preflight(image: string): Promise<void>;

  /** Create a container with the given configuration. Returns container ID. */
  create(config: DockerContainerConfig): Promise<string>;

  /** Start a created container. */
  start(nameOrId: string): Promise<void>;

  /**
   * Execute a command inside a running container via `docker exec`.
   * Returns when the command exits. Both stdout and stderr are captured.
   *
   * @param timeoutMs - kill the exec process after this many ms.
   * @param execUser - override the exec user via `docker exec --user <value>`.
   *   - `undefined` (default): pins `--user codespace`, the correct behavior
   *     for agent containers (which on Linux are created with `--user 0:0`
   *     so the entrypoint can renumber the baked codespace user — every
   *     subsequent exec must opt back into codespace explicitly).
   *   - A string: passes that value as `--user`.
   *   - `null`: skip the `--user` flag entirely. Required for non-agent
   *     containers that have no `codespace` account (e.g. the
   *     `bbernhard/signal-cli-rest-api` image).
   * @param workdir - optional working directory passed via
   *   `docker exec --workdir <dir>`.
   */
  exec(
    nameOrId: string,
    command: readonly string[],
    timeoutMs?: number,
    execUser?: string | null,
    workdir?: string,
  ): Promise<DockerExecResult>;

  /** Stop a running container (SIGTERM, then SIGKILL after grace period). */
  stop(nameOrId: string): Promise<void>;

  /** Remove a container (must be stopped). */
  remove(nameOrId: string): Promise<void>;

  /** Check if a container is running. */
  isRunning(nameOrId: string): Promise<boolean>;

  /** Check if a Docker image exists locally. */
  imageExists(image: string): Promise<boolean>;

  /** Commit a container writable layer to an image and return its immutable sha256 image ID. */
  commit(containerId: string, options?: DockerCommitOptions): Promise<string>;

  /** Remove a Docker image by digest or tag. Returns true when a removal was attempted successfully. */
  removeImage(ref: string): Promise<boolean>;

  /** List local Docker images, optionally filtered by label. */
  listImages(options?: { readonly labelFilter?: string }): Promise<readonly DockerImageInfo[]>;

  /** Inspect one local Docker image. Returns undefined when the image does not exist. */
  inspectImage(ref: string): Promise<DockerImageInfo | undefined>;

  /** Build a Docker image from a Dockerfile. Optional labels are stamped on the image. */
  buildImage(tag: string, dockerfilePath: string, contextDir: string, labels?: Record<string, string>): Promise<void>;

  /** Read a label value from a Docker image. Returns undefined if image or label doesn't exist. */
  getImageLabel(image: string, label: string): Promise<string | undefined>;

  /**
   * Probe the version string of an agent binary baked into an image by running
   * a throwaway, network-isolated container (`run --rm --network none
   * --entrypoint <command[0]> <image> <command[1..]>`) and returning its trimmed
   * stdout. Network isolation is required — the probe executes an agent binary
   * that may attempt update-check/telemetry egress. Best-effort: returns
   * undefined on any failure. Optional — runtimes that cannot cheaply run an
   * ephemeral container may omit it, in which case callers skip version logging.
   */
  probeImageVersion?(image: string, command: readonly string[]): Promise<string | undefined>;

  /** Create a Docker network. No-op if it already exists. */
  createNetwork(name: string, options?: DockerNetworkCreateOptions): Promise<void>;

  /** Enumerate Docker networks. Optional for non-Docker runtimes. */
  listNetworks?(): Promise<readonly DockerNetworkInfo[]>;

  /** Enumerate Docker containers, including stopped containers. Optional for non-Docker runtimes. */
  listContainers?(options?: { readonly labelFilter?: string }): Promise<readonly DockerContainerInfo[]>;

  /** Remove a Docker network. Ignores errors (e.g., already removed). */
  removeNetwork(name: string): Promise<void>;

  /** Check whether a named network still exists. Optional for non-Docker runtimes. */
  networkExists?(name: string): Promise<boolean>;

  /** Pull a Docker image from a registry. */
  pullImage(image: string): Promise<void>;

  /**
   * Check if a container exists (running or stopped).
   * Unlike isRunning(), returns true for stopped containers.
   */
  containerExists(nameOrId: string): Promise<boolean>;

  /**
   * Remove a stale container left behind by a crashed session.
   * Stops and force-removes if it exists; no-ops otherwise.
   * Returns true if a stale container was found and removed.
   */
  removeStaleContainer(name: string): Promise<boolean>;

  /** Returns a label value from a container, or undefined if not found. */
  getContainerLabel(container: string, label: string): Promise<string | undefined>;

  /** Returns the image ID (sha256 digest) for a container or image. undefined if not found. */
  getImageId(nameOrId: string): Promise<string | undefined>;

  /** Connect an existing container to a Docker network. */
  connectNetwork(networkName: string, containerId: string): Promise<void>;

  /**
   * Returns the host-side IPv4 gateway address of a network, or undefined
   * if the network does not exist or has no gateway. Optional: only the
   * tcp-hostonly topology consumes it (see network-topology.ts), and it
   * falls back to deriving the gateway from the subnet when absent.
   */
  getNetworkGateway?(name: string): Promise<string | undefined>;

  /** Get a container's IP address on a specific network. */
  getContainerIp(containerId: string, network: string): Promise<string>;
}
