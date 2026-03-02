/**
 * Agent adapter interface and supporting types.
 *
 * Each supported external agent (Claude Code, Goose, etc.) has an adapter
 * that handles its specific configuration needs: Docker image, MCP client
 * config format, system prompt injection, and output parsing.
 */

import type { IronCurtainConfig } from '../config/types.js';
import type { ProviderConfig } from './provider-config.js';
import type { ServerListing } from '../session/prompts.js';

/**
 * The workspace directory inside Docker containers. The host sandbox
 * directory is bind-mounted at this path. Used for path rewriting
 * between container and host in both directions.
 */
export const CONTAINER_WORKSPACE_DIR = '/workspace';

/**
 * Structured response from an agent adapter, carrying both the
 * text response and optional cost/usage metadata reported by the agent.
 */
export interface AgentResponse {
  /** The agent's text response. */
  readonly text: string;
  /** Cumulative session cost in USD, if reported by the agent. */
  readonly costUsd?: number;
}

/**
 * Branded agent identifier to prevent mixing with other string types.
 */
export type AgentId = string & { readonly __brand: 'AgentId' };

/**
 * A file to write into the container's orientation or config directory.
 */
export interface AgentConfigFile {
  /** Path relative to the orientation directory (or absolute in the container). */
  readonly path: string;
  /** File content. */
  readonly content: string;
  /** Optional file mode (e.g. 0o755 for executable scripts). */
  readonly mode?: number;
}

/**
 * Context passed to the adapter for generating orientation content.
 */
export interface OrientationContext {
  /** The sandbox directory path inside the container. */
  readonly workspaceDir: string;
  /** The host-side path that is bind-mounted as workspaceDir. */
  readonly hostSandboxDir: string;
  /** Server listings for progressive tool disclosure. */
  readonly serverListings: ServerListing[];
  /** Domains the agent may access via fetch MCP tool. */
  readonly allowedDomains: string[];
  /** Container network mode: 'none' (Linux UDS) or 'bridge' (macOS TCP). */
  readonly networkMode: 'none' | 'bridge';
}

/**
 * An agent adapter encapsulates the differences between external agents.
 *
 * Each adapter knows:
 * - What Docker image to use
 * - How to configure MCP server discovery for the agent
 * - How to construct the docker exec command
 * - How to collect the agent's response
 */
export interface AgentAdapter {
  /** Unique identifier for this agent type. */
  readonly id: AgentId;

  /** Human-readable name for display. */
  readonly displayName: string;

  /**
   * Returns the Docker image to use for this agent.
   * May trigger a build if the image doesn't exist yet.
   */
  getImage(): Promise<string>;

  /**
   * Generates the MCP client configuration file that tells
   * the agent how to connect to IronCurtain's proxy.
   *
   * @param socketPath - container-side UDS path (e.g., /run/ironcurtain/proxy.sock)
   */
  generateMcpConfig(socketPath: string): AgentConfigFile[];

  /**
   * Generates orientation documents that teach the agent about
   * the MCP-mediated environment.
   */
  generateOrientationFiles(context: OrientationContext): AgentConfigFile[];

  /**
   * Constructs the docker exec command for a turn.
   *
   * @param message - the user's message for this turn
   * @param systemPrompt - the orientation prompt
   */
  buildCommand(message: string, systemPrompt: string): readonly string[];

  /**
   * Builds the system prompt to append to the agent's default system prompt.
   */
  buildSystemPrompt(context: OrientationContext): string;

  /**
   * Returns LLM provider configurations for this agent.
   * The MITM proxy uses these to build the host allowlist,
   * generate fake API keys, swap keys in requests, and filter endpoints.
   *
   * @param authKind - When 'oauth', returns providers configured for bearer
   *   token injection instead of header-based API key injection.
   */
  getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[];

  /**
   * Constructs environment variables for the container.
   * Receives fake keys instead of real keys -- the real keys never
   * enter the container.
   *
   * @param fakeKeys - map of provider host -> fake sentinel key
   */
  buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Readonly<Record<string, string>>;

  /**
   * Parses the agent's output to extract the response and optional cost.
   *
   * @param exitCode - the container's exit code
   * @param stdout - captured stdout from the container
   */
  extractResponse(exitCode: number, stdout: string): AgentResponse;

  /**
   * Returns the Docker container command for PTY mode.
   * When provided, the container runs this command directly instead of
   * `sleep infinity`, and the host attaches via a PTY proxy.
   *
   * Adapters that do not implement this method do not support PTY mode.
   *
   * @param systemPrompt - the orientation prompt (written to a file, not embedded in shell)
   * @param ptySockPath - the UDS path for the PTY listener (Linux), or undefined for TCP mode
   * @param ptyPort - the TCP port for the PTY listener (macOS), or undefined for UDS mode
   */
  buildPtyCommand?(
    systemPrompt: string,
    ptySockPath: string | undefined,
    ptyPort: number | undefined,
  ): readonly string[];
}
