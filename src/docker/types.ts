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

  /** IronCurtain session label for stale container detection. */
  readonly sessionLabel?: string;

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
   * Third-party service containers may need specific capabilities
   * for their entrypoints (e.g., CHOWN, SETUID). Agent containers
   * must NEVER set this field.
   */
  readonly capAdd?: readonly string[];

  /**
   * Allocate a pseudo-TTY for the container (-t flag).
   * Required for PTY mode where the container runs an interactive process.
   * Optional. Defaults to false (no TTY allocated).
   */
  readonly tty?: boolean;
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

/**
 * Manages Docker container lifecycle for agent sessions.
 *
 * Uses the Docker CLI (not the Docker API) for simplicity.
 * The Docker socket is only accessed from the host process,
 * never from inside agent containers.
 */
export interface DockerManager {
  /** Check that Docker is available and the image exists. */
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
   */
  exec(nameOrId: string, command: readonly string[], timeoutMs?: number): Promise<DockerExecResult>;

  /** Stop a running container (SIGTERM, then SIGKILL after grace period). */
  stop(nameOrId: string): Promise<void>;

  /** Remove a container (must be stopped). */
  remove(nameOrId: string): Promise<void>;

  /** Check if a container is running. */
  isRunning(nameOrId: string): Promise<boolean>;

  /** Check if a Docker image exists locally. */
  imageExists(image: string): Promise<boolean>;

  /** Build a Docker image from a Dockerfile. Optional labels are stamped on the image. */
  buildImage(tag: string, dockerfilePath: string, contextDir: string, labels?: Record<string, string>): Promise<void>;

  /** Read a label value from a Docker image. Returns undefined if image or label doesn't exist. */
  getImageLabel(image: string, label: string): Promise<string | undefined>;

  /** Create a Docker network. No-op if it already exists. */
  createNetwork(name: string, options?: { internal?: boolean; subnet?: string; gateway?: string }): Promise<void>;

  /** Remove a Docker network. Ignores errors (e.g., already removed). */
  removeNetwork(name: string): Promise<void>;

  /** Pull a Docker image from a registry. */
  pullImage(image: string): Promise<void>;

  /**
   * Check if a container exists (running or stopped).
   * Unlike isRunning(), returns true for stopped containers.
   */
  containerExists(nameOrId: string): Promise<boolean>;

  /** Returns the image ID (sha256 digest) for a container or image. undefined if not found. */
  getImageId(nameOrId: string): Promise<string | undefined>;

  /** Connect an existing container to a Docker network. */
  connectNetwork(networkName: string, containerId: string): Promise<void>;

  /** Get a container's IP address on a specific network. */
  getContainerIp(containerId: string, network: string): Promise<string>;
}
