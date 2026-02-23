/**
 * Agent adapter interface and supporting types.
 *
 * Each supported external agent (Claude Code, Goose, etc.) has an adapter
 * that handles its specific configuration needs: Docker image, MCP client
 * config format, system prompt injection, and output parsing.
 */

import type { IronCurtainConfig } from '../config/types.js';

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
}

/**
 * Information about a single MCP tool, used for orientation content.
 */
export interface ToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Context passed to the adapter for generating orientation content.
 */
export interface OrientationContext {
  /** The sandbox directory path inside the container. */
  readonly workspaceDir: string;
  /** The host-side path that is bind-mounted as workspaceDir. */
  readonly hostSandboxDir: string;
  /** List of available MCP tools with descriptions. */
  readonly tools: ToolInfo[];
  /** Domains the agent may access via fetch MCP tool. */
  readonly allowedDomains: string[];
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
   * @param tools - list of available MCP tools for documentation
   */
  generateMcpConfig(socketPath: string, tools: ToolInfo[]): AgentConfigFile[];

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
   * Returns hostnames the agent needs direct HTTPS access to for LLM API calls.
   * These are allowlisted in the per-session CONNECT proxy.
   */
  getAllowedApiHosts(): readonly string[];

  /**
   * Constructs environment variables for the container.
   * Includes API keys and agent-specific configuration.
   */
  buildEnv(config: IronCurtainConfig): Readonly<Record<string, string>>;

  /**
   * Parses the agent's output to extract the final response text.
   *
   * @param exitCode - the container's exit code
   * @param stdout - captured stdout from the container
   */
  extractResponse(exitCode: number, stdout: string): string;
}
