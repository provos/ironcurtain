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

  /** Command to execute as the container entrypoint. */
  readonly command: readonly string[];

  /** IronCurtain session label for stale container detection. */
  readonly sessionLabel?: string;

  /** Optional resource limits. */
  readonly resources?: {
    readonly memoryMb?: number;
    readonly cpus?: number;
  };
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
  start(containerId: string): Promise<void>;

  /**
   * Execute a command inside a running container via `docker exec`.
   * Returns when the command exits. Both stdout and stderr are captured.
   *
   * @param timeoutMs - kill the exec process after this many ms.
   */
  exec(containerId: string, command: readonly string[], timeoutMs?: number): Promise<DockerExecResult>;

  /** Stop a running container (SIGTERM, then SIGKILL after grace period). */
  stop(containerId: string): Promise<void>;

  /** Remove a container (must be stopped). */
  remove(containerId: string): Promise<void>;

  /** Check if a container is running. */
  isRunning(containerId: string): Promise<boolean>;

  /** Check if a Docker image exists locally. */
  imageExists(image: string): Promise<boolean>;

  /** Build a Docker image from a Dockerfile. */
  buildImage(tag: string, dockerfilePath: string, contextDir: string): Promise<void>;

  /** Create a Docker network. No-op if it already exists. */
  createNetwork(name: string): Promise<void>;

  /** Remove a Docker network. Ignores errors (e.g., already removed). */
  removeNetwork(name: string): Promise<void>;
}
