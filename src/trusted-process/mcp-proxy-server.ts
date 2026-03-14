/**
 * MCP Proxy Server -- The trusted process running as a standalone MCP server.
 *
 * Code Mode spawns this as a child process via stdio transport. It acts
 * as the security boundary between the sandbox and real MCP servers:
 *
 * 1. Connects to real MCP servers as a client
 * 2. Exposes their tools with passthrough schemas
 * 3. Evaluates every tool call against the policy engine
 * 4. Forwards allowed calls to real servers, denies or escalates others
 * 5. Logs every request and decision to the append-only audit log
 *
 * Configuration via environment variables:
 *   AUDIT_LOG_PATH     -- path to the audit log file
 *   MCP_SERVERS_CONFIG -- JSON string of MCP server configs to proxy
 *   GENERATED_DIR      -- path to the generated artifacts directory
 *   PROTECTED_PATHS    -- JSON array of protected paths
 *   ALLOWED_DIRECTORY  -- (optional) sandbox directory for structural containment check
 *   ESCALATION_DIR     -- (optional) directory for file-based escalation IPC
 *   SESSION_LOG_PATH   -- (optional) path for capturing child process stderr
 *   SANDBOX_POLICY     -- (optional) "enforce" | "warn" (default: "warn")
 *   AUDIT_REDACTION    -- (optional) "true" to redact PII/credentials in audit log entries
 *   SERVER_FILTER      -- (optional) when set, only connect to this single server name
 *   AUTO_APPROVE_ENABLED   -- (optional) "true" to enable auto-approval of escalations
 *   AUTO_APPROVE_MODEL_ID  -- (optional) qualified model ID for auto-approve LLM
 *   AUTO_APPROVE_API_KEY   -- (optional) API key for the auto-approve model's provider
 *   AUTO_APPROVE_LLM_LOG_PATH -- (optional) path to JSONL file for auto-approve LLM logging
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UdsServerTransport } from './uds-server-transport.js';
import { TcpServerTransport } from './tcp-server-transport.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { loadGeneratedPolicy, extractServerDomainAllowlists, getPackageGeneratedDir } from '../config/index.js';
import { PolicyEngine, extractAnnotatedPaths } from './policy-engine.js';
import { getPathRoles } from '../types/argument-roles.js';
import { AuditLog } from './audit-log.js';
import { prepareToolArgs, rewriteResultContent } from './path-utils.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import {
  checkSandboxAvailability,
  resolveSandboxConfig,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  annotateSandboxViolation,
  type ResolvedSandboxConfig,
} from './sandbox-integration.js';
import type { ToolCallRequest, PolicyDecision } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import { ROOTS_REFRESH_TIMEOUT_MS, type McpRoot } from './mcp-client-manager.js';
import { CallCircuitBreaker } from './call-circuit-breaker.js';
import { autoApprove, extractArgsForAutoApprove, readUserContext, type UserContext } from './auto-approver.js';
import { createLanguageModelFromEnv } from '../config/model-provider.js';
import { wrapLanguageModel } from 'ai';
import { createLlmLoggingMiddleware } from '../pipeline/llm-logger.js';
import { extractMcpErrorMessage } from './mcp-error-utils.js';
import { type ServerContextMap, updateServerContext, formatServerContext } from './server-context.js';
import { permissiveJsonSchemaValidator } from './permissive-output-validator.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import type { ToolAnnotation } from '../pipeline/types.js';
import { VERSION } from '../version.js';
import { buildTrustedServerSet } from '../memory/memory-annotations.js';
import { loadToolDescriptionHints, applyToolDescriptionHints } from './tool-description-hints.js';

export interface ProxiedTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
}

export interface ClientState {
  client: Client;
  roots: McpRoot[];
  rootsRefreshed?: () => void;
}

/**
 * Adds a root to a client's root list and waits for the server to
 * fetch the updated list. No-op if the root URI is already present.
 * Times out after ROOTS_REFRESH_TIMEOUT_MS if the server never requests
 * the updated list (e.g. servers that don't implement Roots protocol).
 *
 * Returns `'added'` when the server acknowledged the update (called
 * `roots/list`), `'timeout'` when the server didn't respond in time,
 * or `false` when the root was already present.
 */
async function addRootToClient(state: ClientState, root: McpRoot): Promise<'added' | 'timeout' | false> {
  if (state.roots.some((r) => r.uri === root.uri)) return false;
  state.roots.push(root);

  let timer: ReturnType<typeof setTimeout>;
  let outcome: 'added' | 'timeout' = 'timeout';
  const refreshed = new Promise<void>((resolve) => {
    state.rootsRefreshed = () => {
      clearTimeout(timer);
      outcome = 'added';
      resolve();
    };
  });
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      state.rootsRefreshed = undefined;
      resolve();
    }, ROOTS_REFRESH_TIMEOUT_MS);
    timer.unref();
  });
  await state.client.sendRootsListChanged();
  await Promise.race([refreshed, timeout]);
  return outcome;
}

/**
 * Delay before retrying a tool call that returned "access denied" immediately
 * after roots expansion. The filesystem server needs time to async-validate
 * (fs.realpath, fs.stat) the new roots after receiving the rootsListChanged
 * notification. Exported for test access.
 */
export const ROOTS_RACE_RETRY_DELAY_MS = 200;

/**
 * Checks whether an MCP tool call result looks like a roots-race "access denied"
 * error -- the filesystem server rejected the call because it hasn't finished
 * processing the updated roots yet.
 */
function isRootsRaceError(result: Record<string, unknown>): boolean {
  if (!('isError' in result) || !result.isError) return false;
  const text = extractTextFromContent(result.content);
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('access denied') || lower.includes('outside allowed directories');
}

/** Appends a timestamped line to the session log file. */
function logToSessionFile(sessionLogPath: string, message: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(sessionLogPath, `${timestamp} INFO  ${message}\n`);
  } catch {
    /* ignore write failures */
  }
}

/**
 * Detects Docker-style `-e VAR_NAME` args (no `=`) where the env var is unset.
 * Returns the names of missing variables, or an empty array if all are present.
 */
function getMissingEnvVars(args: string[]): string[] {
  const missing: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && i + 1 < args.length) {
      const val = args[i + 1];
      // "-e VAR_NAME" (no =) means forward from host env; "-e VAR=value" sets explicitly
      if (!val.includes('=') && !process.env[val]) {
        missing.push(val);
      }
      i++; // skip the value arg
    }
  }
  return missing;
}

/** Extracts concatenated text from MCP content blocks. */
export function extractTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((c: Record<string, unknown>) => c.type === 'text' && typeof c.text === 'string')
    .map((c: Record<string, unknown>) => c.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Replaces known credential values in a string with `***REDACTED***`.
 * Prevents credential leakage in session log files.
 */
function redactCredentials(text: string, credentials: Record<string, string>): string {
  let result = text;
  for (const value of Object.values(credentials)) {
    if (value.length > 0 && result.includes(value)) {
      result = result.replaceAll(value, '***REDACTED***');
    }
  }
  return result;
}

const ESCALATION_POLL_INTERVAL_MS = 500;
const DEFAULT_ESCALATION_TIMEOUT_SECONDS = 300;

/** Auto-approve trusted input older than this is rejected as stale. */
const TRUSTED_INPUT_STALENESS_MS = 120_000;

/**
 * Returns true when a user context is safe to act on for auto-approval.
 *
 * For PTY sessions (isPtySession=true):
 *   - source must be 'mux-trusted-input' (set by the trusted mux layer)
 *   - timestamp must be present, valid, not in the future, and within
 *     TRUSTED_INPUT_STALENESS_MS of `now`
 *
 * For non-PTY sessions:
 *   - source is not checked (no mux layer in the path)
 *   - a missing or invalid timestamp does not prevent trust; a valid stale
 *     timestamp still prevents trust (belt-and-suspenders for future callers)
 *
 * @param context - The user context parsed from user-context.json
 * @param isPtySession - Whether this is a PTY interactive session
 * @param now - Current time in ms; defaults to Date.now() (injectable for tests)
 */
export function isUserContextTrusted(context: UserContext, isPtySession: boolean, now: number = Date.now()): boolean {
  const sourceValid = !isPtySession || context.source === 'mux-trusted-input';
  if (!sourceValid) return false;

  let stale = isPtySession; // non-PTY sessions don't require timestamps
  if (context.timestamp !== undefined) {
    const tsMs = new Date(context.timestamp).getTime();
    if (!Number.isNaN(tsMs)) {
      const ageMs = now - tsMs;
      stale = ageMs > TRUSTED_INPUT_STALENESS_MS || ageMs < 0;
    }
  }
  return !stale;
}

/** Reads escalation timeout from env var, falling back to default. */
function getEscalationTimeoutMs(): number {
  const envValue = process.env.ESCALATION_TIMEOUT_SECONDS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }
  return DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000;
}

/** Silently removes a file. Ignores errors (e.g. file already gone). */
function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/**
 * Removes both escalation IPC files. Request is deleted first so the
 * session side sees "request gone + response exists" as normal
 * approval-in-progress rather than an expiry.
 */
function cleanupEscalationFiles(requestPath: string, responsePath: string): void {
  tryUnlink(requestPath);
  tryUnlink(responsePath);
}

/**
 * Reads and parses the escalation response file if it exists.
 * Returns the decision, or undefined if the file is not present.
 */
function readEscalationResponse(responsePath: string): 'approved' | 'denied' | undefined {
  if (!existsSync(responsePath)) return undefined;
  const response = JSON.parse(readFileSync(responsePath, 'utf-8')) as { decision: 'approved' | 'denied' };
  return response.decision;
}

/**
 * Waits for a human decision via file-based IPC.
 *
 * Writes a request file to the escalation directory, then polls
 * for a response file. The session process (on the other side)
 * detects the request, surfaces it to the user, and writes the response.
 *
 * Returns 'approved' or 'denied'. On timeout, returns 'denied'.
 */
async function waitForEscalationDecision(
  escalationDir: string,
  request: EscalationFileRequest,
): Promise<'approved' | 'denied'> {
  const requestPath = resolve(escalationDir, `request-${request.escalationId}.json`);
  const responsePath = resolve(escalationDir, `response-${request.escalationId}.json`);

  atomicWriteJsonSync(requestPath, request);

  const deadline = Date.now() + getEscalationTimeoutMs();

  while (Date.now() < deadline) {
    const decision = readEscalationResponse(responsePath);
    if (decision) {
      cleanupEscalationFiles(requestPath, responsePath);
      return decision;
    }
    await new Promise((r) => setTimeout(r, ESCALATION_POLL_INTERVAL_MS));
  }

  // Final check -- response may have arrived between last poll and deadline
  const lateDecision = readEscalationResponse(responsePath);
  cleanupEscalationFiles(requestPath, responsePath);
  return lateDecision ?? 'denied';
}

/**
 * Creates the auto-approve LLM model from environment variables.
 * Returns null when auto-approve is not enabled or env vars are missing.
 * Wraps with LLM logging middleware when a log path is provided.
 */
async function createAutoApproveModel(sessionLogPath?: string): Promise<LanguageModelV3 | null> {
  if (process.env.AUTO_APPROVE_ENABLED !== 'true') return null;

  const modelId = process.env.AUTO_APPROVE_MODEL_ID;
  if (!modelId) return null;

  const apiKey = process.env.AUTO_APPROVE_API_KEY ?? '';

  try {
    const baseModel = await createLanguageModelFromEnv(modelId, apiKey);

    const llmLogPath = process.env.AUTO_APPROVE_LLM_LOG_PATH;
    if (sessionLogPath) {
      logToSessionFile(sessionLogPath, `Auto-approve model created: ${modelId}`);
    }
    if (!llmLogPath) return baseModel;

    return wrapLanguageModel({
      model: baseModel,
      middleware: createLlmLoggingMiddleware(llmLogPath, { stepName: 'auto-approve' }),
    });
  } catch (err) {
    // Model creation failure should not prevent the proxy from starting.
    // Auto-approve simply won't be available for this session.
    const message = err instanceof Error ? err.message : String(err);
    if (sessionLogPath) {
      logToSessionFile(sessionLogPath, `Auto-approve model creation failed for ${modelId}: ${message}`);
    }
    return null;
  }
}

// ── Exported types for extracted functions ─────────────────────────────

/** Parsed environment configuration for the proxy server. */
export interface ProxyEnvConfig {
  auditLogPath: string;
  serversConfig: Record<string, MCPServerConfig>;
  generatedDir: string;
  /** Directory for tool-annotations.json. Defaults to generatedDir if unset. */
  toolAnnotationsDir: string;
  protectedPaths: string[];
  sessionLogPath: string | undefined;
  allowedDirectory: string | undefined;
  escalationDir: string | undefined;
  serverCredentials: Record<string, string>;
  sandboxPolicy: SandboxAvailabilityPolicy;
  auditRedaction: boolean;
}

/** Result of sandbox availability validation. */
export interface SandboxValidationResult {
  sandboxAvailable: boolean;
}

/** MCP tool call response shape returned by handleCallTool. */
export interface ToolCallResponse {
  content: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** Dependencies injected into handleCallTool for testability. */
export interface CallToolDeps {
  toolMap: Map<string, ProxiedTool>;
  policyEngine: PolicyEngine;
  auditLog: AuditLog;
  circuitBreaker: CallCircuitBreaker;
  clientStates: Map<string, ClientState>;
  resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  allowedDirectory: string | undefined;
  escalationDir: string | undefined;
  autoApproveModel: LanguageModelV3 | null;
  serverContextMap: ServerContextMap;
}

// ── Extracted functions ────────────────────────────────────────────────

/**
 * Reads and validates proxy environment variables.
 * Returns a typed config object or calls process.exit(1) on missing required vars.
 */
export function parseProxyEnvConfig(): ProxyEnvConfig {
  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';
  const serversConfigJson = process.env.MCP_SERVERS_CONFIG;
  const generatedDir = process.env.GENERATED_DIR;
  const protectedPathsJson = process.env.PROTECTED_PATHS ?? '[]';
  const sessionLogPath = process.env.SESSION_LOG_PATH;
  const allowedDirectory = process.env.ALLOWED_DIRECTORY;
  const escalationDir = process.env.ESCALATION_DIR;

  if (!serversConfigJson) {
    process.stderr.write('MCP_SERVERS_CONFIG environment variable is required\n');
    process.exit(1);
  }

  if (!generatedDir) {
    process.stderr.write('GENERATED_DIR environment variable is required\n');
    process.exit(1);
  }

  // Parse per-server credentials and immediately scrub from process.env
  // so they are not inherited by child MCP server processes.
  const serverCredentials: Record<string, string> = process.env.SERVER_CREDENTIALS
    ? (JSON.parse(process.env.SERVER_CREDENTIALS) as Record<string, string>)
    : {};
  delete process.env.SERVER_CREDENTIALS;

  const sandboxPolicy = (process.env.SANDBOX_POLICY ?? 'warn') as SandboxAvailabilityPolicy;
  const auditRedaction = process.env.AUDIT_REDACTION === 'true';

  const allServersConfig = JSON.parse(serversConfigJson) as Record<string, MCPServerConfig>;
  const protectedPaths = JSON.parse(protectedPathsJson) as string[];

  // When SERVER_FILTER is set, only connect to that single backend server.
  const serverFilter = process.env.SERVER_FILTER;
  const serversConfig: Record<string, MCPServerConfig> = serverFilter
    ? { [serverFilter]: allServersConfig[serverFilter] }
    : allServersConfig;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Record index may be undefined at runtime
  if (serverFilter && !allServersConfig[serverFilter]) {
    process.stderr.write(`SERVER_FILTER: unknown server "${serverFilter}"\n`);
    process.exit(1);
  }

  // When TOOL_ANNOTATIONS_DIR is set, annotations come from there.
  // Otherwise they default to the same directory as compiled policy.
  const toolAnnotationsDir = process.env.TOOL_ANNOTATIONS_DIR ?? generatedDir;

  return {
    auditLogPath,
    serversConfig,
    generatedDir,
    toolAnnotationsDir,
    protectedPaths,
    sessionLogPath,
    allowedDirectory,
    escalationDir,
    serverCredentials,
    sandboxPolicy,
    auditRedaction,
  };
}

/**
 * Validates sandbox availability against the configured policy.
 * Logs warnings to session log. Throws when enforce mode is active
 * but sandboxing is unavailable.
 */
export function validateSandboxAvailability(
  sandboxPolicy: SandboxAvailabilityPolicy,
  sessionLogPath: string | undefined,
  platform: string,
): SandboxValidationResult {
  const { platformSupported, errors: depErrors, warnings: depWarnings } = checkSandboxAvailability();

  if (sessionLogPath) {
    for (const warning of depWarnings) {
      logToSessionFile(sessionLogPath, `[sandbox] WARNING: ${warning}`);
    }
  }

  if (sandboxPolicy === 'enforce' && (!platformSupported || depErrors.length > 0)) {
    const reasons = !platformSupported ? [`Platform ${platform} not supported`] : depErrors;
    throw new Error(
      `[sandbox] FATAL: sandboxPolicy is "enforce" but sandboxing is unavailable:\n` +
        reasons.map((r) => `  - ${r}`).join('\n') +
        '\n' +
        `Install with: sudo apt-get install -y bubblewrap socat`,
    );
  }

  const sandboxAvailable = platformSupported && depErrors.length === 0;

  if (!sandboxAvailable && sessionLogPath) {
    const missing = depErrors.length > 0 ? depErrors.join(', ') : `platform ${platform}`;
    logToSessionFile(
      sessionLogPath,
      `[sandbox] WARNING: OS-level sandboxing unavailable (${missing}). ` +
        `Servers will run without OS containment. ` +
        `Set SANDBOX_POLICY=enforce to require sandboxing.`,
    );
  }

  return { sandboxAvailable };
}

/**
 * Resolves per-server sandbox configurations and writes srt settings
 * files for sandboxed servers. Returns the config map and the temp
 * settings directory path.
 */
export function resolveServerSandboxConfigs(
  serversConfig: Record<string, MCPServerConfig>,
  allowedDirectory: string | undefined,
  sandboxAvailable: boolean,
  sandboxPolicy: SandboxAvailabilityPolicy,
): {
  resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  settingsDir: string;
  serverCwdPaths: Map<string, string>;
} {
  const resolvedSandboxConfigs = new Map<string, ResolvedSandboxConfig>();
  const serverCwdPaths = new Map<string, string>();
  const settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-srt-'));

  for (const [serverName, config] of Object.entries(serversConfig)) {
    const resolved = resolveSandboxConfig(config, allowedDirectory ?? '/tmp', sandboxAvailable, sandboxPolicy);
    resolvedSandboxConfigs.set(serverName, resolved);

    if (resolved.sandboxed) {
      const { cwdPath } = writeServerSettings(serverName, resolved.config, settingsDir);
      serverCwdPaths.set(serverName, cwdPath);
    }
  }

  return { resolvedSandboxConfigs, settingsDir, serverCwdPaths };
}

/** Builds a lookup map from tool name to ProxiedTool for routing. */
export function buildToolMap(allTools: ProxiedTool[]): Map<string, ProxiedTool> {
  const toolMap = new Map<string, ProxiedTool>();
  for (const tool of allTools) {
    toolMap.set(tool.name, tool);
  }
  return toolMap;
}

/**
 * Creates an audit entry and logs it. Extracted so the audit shape
 * construction is testable independently.
 */
export function buildAuditEntry(
  request: ToolCallRequest,
  argsForTransport: Record<string, unknown>,
  policyDecision: PolicyDecision,
  result: AuditEntry['result'],
  durationMs: number,
  options: {
    escalationResult?: 'approved' | 'denied';
    sandboxed?: boolean;
    autoApproved?: boolean;
  },
): AuditEntry {
  return {
    timestamp: request.timestamp,
    requestId: request.requestId,
    serverName: request.serverName,
    toolName: request.toolName,
    arguments: argsForTransport,
    policyDecision,
    escalationResult: options.escalationResult,
    result,
    durationMs,
    sandboxed: options.sandboxed || undefined,
    autoApproved: options.autoApproved || undefined,
  };
}

/**
 * Handles a single tool call request: policy evaluation, escalation,
 * circuit breaker check, and forwarding to the real MCP server.
 *
 * This is the core security logic extracted from the CallTool handler
 * for independent unit testing.
 */
export async function handleCallTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  deps: CallToolDeps,
): Promise<ToolCallResponse> {
  const toolInfo = deps.toolMap.get(toolName);

  if (!toolInfo) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  // Annotation-driven normalization: split into transport vs policy args.
  // Trusted servers skip annotation lookup and prepareToolArgs — use raw args directly.
  const annotation = deps.policyEngine.getAnnotation(toolInfo.serverName, toolInfo.name, rawArgs);
  const isTrusted = !annotation && deps.policyEngine.isTrustedServer(toolInfo.serverName);

  if (!annotation && !isTrusted) {
    return {
      content: [
        {
          type: 'text',
          text: `Missing annotation for tool: ${toolInfo.serverName}__${toolInfo.name}. Re-run 'ironcurtain annotate-tools' to update.`,
        },
      ],
      isError: true,
    };
  }

  let argsForTransport: Record<string, unknown>;
  let argsForPolicy: Record<string, unknown>;

  if (isTrusted) {
    // Trusted server with no annotation: use raw args for both transport and policy
    argsForTransport = rawArgs;
    argsForPolicy = rawArgs;
  } else {
    // annotation is guaranteed non-null here: we returned early if both are falsy
    const resolvedAnnotation = annotation as ToolAnnotation;

    // Enrich git tool args with the locally tracked working directory when
    // the agent omits the `path` argument. The git MCP server tracks its own
    // CWD (set via git_set_working_dir) and uses it implicitly, but the
    // policy engine needs the explicit path to resolve sandbox containment
    // and the default remote URL for domain-based policy rules.
    // The serverContextMap mirrors the git server's working directory from
    // successful git_set_working_dir / git_clone calls, avoiding an RPC.
    let effectiveRawArgs = rawArgs;
    const hasEffectivePath = 'path' in rawArgs && typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
    if (toolInfo.serverName === 'git' && 'path' in resolvedAnnotation.args && !hasEffectivePath) {
      const gitWorkDir = deps.serverContextMap.get('git')?.workingDirectory;
      if (!gitWorkDir) {
        const errorMsg = 'Git server has no working directory set. Call git_set_working_dir first.';
        deps.auditLog.log(
          buildAuditEntry(
            {
              requestId: uuidv4(),
              serverName: toolInfo.serverName,
              toolName: toolInfo.name,
              arguments: rawArgs,
              timestamp: new Date().toISOString(),
            },
            rawArgs,
            { status: 'deny', rule: 'git-path-enrichment-failed', reason: errorMsg },
            { status: 'denied', error: errorMsg },
            0,
            {},
          ),
        );
        return {
          content: [{ type: 'text', text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
      effectiveRawArgs = { ...rawArgs, path: gitWorkDir };
    }

    ({ argsForTransport, argsForPolicy } = prepareToolArgs(
      effectiveRawArgs,
      resolvedAnnotation,
      deps.allowedDirectory,
      CONTAINER_WORKSPACE_DIR,
    ));
  }

  const request: ToolCallRequest = {
    requestId: uuidv4(),
    serverName: toolInfo.serverName,
    toolName: toolInfo.name,
    arguments: argsForPolicy,
    timestamp: new Date().toISOString(),
  };

  const evaluation = deps.policyEngine.evaluate(request);
  const policyDecision: PolicyDecision = {
    status: evaluation.decision,
    rule: evaluation.rule,
    reason: evaluation.reason,
  };

  let escalationResult: 'approved' | 'denied' | undefined;
  let autoApproved = false;
  let rootsExpanded = false;

  const serverSandboxConfig = deps.resolvedSandboxConfigs.get(toolInfo.serverName);
  const serverIsSandboxed = serverSandboxConfig?.sandboxed === true;

  function logAudit(
    result: AuditEntry['result'],
    durationMs: number,
    overrideEscalation?: 'approved' | 'denied',
  ): void {
    const entry = buildAuditEntry(request, argsForTransport, policyDecision, result, durationMs, {
      escalationResult: overrideEscalation ?? escalationResult,
      sandboxed: serverIsSandboxed,
      autoApproved,
    });
    deps.auditLog.log(entry);
  }

  if (evaluation.decision === 'escalate') {
    if (!deps.escalationDir) {
      logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
      return {
        content: [
          {
            type: 'text',
            text: `ESCALATION REQUIRED: ${evaluation.reason}. Action denied (no escalation handler).`,
          },
        ],
        isError: true,
      };
    }

    // Try auto-approve before falling through to human escalation
    if (deps.autoApproveModel) {
      const userContext = readUserContext(deps.escalationDir);
      if (userContext) {
        const isPtySession = process.env.IRONCURTAIN_PTY_SESSION === '1';
        if (isUserContextTrusted(userContext, isPtySession)) {
          const autoResult = await autoApprove(
            {
              userMessage: userContext.userMessage,
              toolName: `${toolInfo.serverName}/${toolInfo.name}`,
              escalationReason: evaluation.reason,
              arguments: extractArgsForAutoApprove(argsForPolicy, annotation),
            },
            deps.autoApproveModel,
          );

          if (autoResult.decision === 'approve') {
            autoApproved = true;
            escalationResult = 'approved';
            policyDecision.status = 'allow';
            policyDecision.reason = `Auto-approved: ${autoResult.reasoning}`;
          }
        }
      }
    }

    if (!autoApproved) {
      const escalationId = uuidv4();
      const decision = await waitForEscalationDecision(deps.escalationDir, {
        escalationId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: argsForTransport,
        reason: evaluation.reason,
        context: formatServerContext(deps.serverContextMap, toolInfo.serverName),
      });

      if (decision === 'denied') {
        logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
        return {
          content: [{ type: 'text', text: `ESCALATION DENIED: ${evaluation.reason}` }],
          isError: true,
        };
      }

      escalationResult = 'approved';
      policyDecision.status = 'allow';
      policyDecision.reason = 'Approved by human during escalation';
    }

    // Expand roots for approved path arguments only (skip URLs, opaques)
    const state = deps.clientStates.get(toolInfo.serverName);
    if (state && annotation) {
      const pathValues = extractAnnotatedPaths(argsForTransport, annotation, getPathRoles());
      for (const p of pathValues) {
        const result = await addRootToClient(state, {
          uri: `file://${directoryForPath(p)}`,
          name: 'escalation-approved',
        });
        if (result === 'added') rootsExpanded = true;
      }
    }
  }

  if (evaluation.decision === 'deny') {
    logAudit({ status: 'denied', error: evaluation.reason }, 0);
    return {
      content: [{ type: 'text', text: `DENIED: ${evaluation.reason}` }],
      isError: true,
    };
  }

  // Circuit breaker: deny if the same tool+args is called too many times
  const cbVerdict = deps.circuitBreaker.check(toolInfo.name, argsForTransport);
  if (!cbVerdict.allowed) {
    logAudit({ status: 'denied', error: cbVerdict.reason }, 0);
    return {
      content: [{ type: 'text', text: cbVerdict.reason }],
      isError: true,
    };
  }

  // Policy allows -- forward to the real MCP server with transport args
  const startTime = Date.now();
  try {
    const clientState = deps.clientStates.get(toolInfo.serverName);
    if (!clientState) {
      const err = `Internal error: no client connection for server "${toolInfo.serverName}"`;
      logAudit({ status: 'denied', error: err }, 0);
      return { content: [{ type: 'text', text: err }], isError: true };
    }
    const client = clientState.client;

    // CompatibilityCallToolResultSchema accepts the legacy `toolResult` response format
    // (protocol version 2024-10-07). Output schema validation is intentionally
    // bypassed by the permissiveJsonSchemaValidator injected at Client construction time.
    const callToolArgs = { name: toolInfo.name, arguments: argsForTransport };
    const callToolOpts = { timeout: getEscalationTimeoutMs() };
    let result = await client.callTool(callToolArgs, CompatibilityCallToolResultSchema, callToolOpts);

    // Race condition mitigation: after roots expansion the filesystem server
    // has been notified but may not have finished async-validating the new
    // roots (fs.realpath, fs.stat). Retry once after a short delay.
    if (rootsExpanded && isRootsRaceError(result)) {
      const initialError = extractTextFromContent(result.content) ?? 'access denied (roots race)';
      logAudit({ status: 'error', error: `Roots race detected, retrying: ${initialError}` }, Date.now() - startTime);
      await new Promise((r) => setTimeout(r, ROOTS_RACE_RETRY_DELAY_MS));
      result = await client.callTool(callToolArgs, CompatibilityCallToolResultSchema, callToolOpts);
    }

    // Reverse-rewrite host sandbox paths to container workspace paths in results
    const rewrittenContent = deps.allowedDirectory
      ? rewriteResultContent(result.content, deps.allowedDirectory, CONTAINER_WORKSPACE_DIR)
      : result.content;

    if (result.isError) {
      const errorText = extractTextFromContent(rewrittenContent) ?? 'Unknown tool error';
      const errorMessage = annotateSandboxViolation(errorText, serverIsSandboxed);
      logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
      return { content: rewrittenContent, isError: true };
    }

    updateServerContext(deps.serverContextMap, toolInfo.serverName, toolInfo.name, argsForTransport);
    logAudit({ status: 'success' }, Date.now() - startTime);
    return { content: rewrittenContent };
  } catch (err) {
    const rawError = extractMcpErrorMessage(err);
    const errorMessage = annotateSandboxViolation(rawError, serverIsSandboxed);
    logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
    const errorContent = [{ type: 'text', text: `Error: ${errorMessage}` }];
    return {
      content: deps.allowedDirectory
        ? rewriteResultContent(errorContent, deps.allowedDirectory, CONTAINER_WORKSPACE_DIR)
        : errorContent,
      isError: true,
    };
  }
}

/**
 * Selects and validates the proxy transport based on environment variables.
 * Returns 'tcp', 'uds', or 'stdio' along with the transport options.
 */
export function selectTransportConfig():
  | {
      kind: 'tcp';
      port: number;
      portFilePath: string | undefined;
    }
  | {
      kind: 'uds';
      socketPath: string;
    }
  | {
      kind: 'stdio';
    } {
  const proxyTcpPort = process.env.PROXY_TCP_PORT;
  const proxySocketPath = process.env.PROXY_SOCKET_PATH;

  if (proxyTcpPort) {
    const parsedPort = parseInt(proxyTcpPort, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid PROXY_TCP_PORT value "${proxyTcpPort}". Expected an integer between 0 and 65535.`);
    }
    return { kind: 'tcp', port: parsedPort, portFilePath: process.env.PROXY_PORT_FILE };
  }

  if (proxySocketPath) {
    return { kind: 'uds', socketPath: proxySocketPath };
  }

  return { kind: 'stdio' };
}

// ── main() -- thin orchestrator ────────────────────────────────────────

async function main(): Promise<void> {
  const envConfig = parseProxyEnvConfig();
  const {
    auditLogPath,
    serversConfig,
    generatedDir,
    toolAnnotationsDir,
    protectedPaths,
    sessionLogPath,
    allowedDirectory,
    escalationDir,
    serverCredentials,
    sandboxPolicy,
    auditRedaction,
  } = envConfig;

  const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy({
    policyDir: generatedDir,
    toolAnnotationsDir,
    fallbackDir: getPackageGeneratedDir(),
  });

  const serverDomainAllowlists = extractServerDomainAllowlists(serversConfig);
  const trustedServers = buildTrustedServerSet(serversConfig);
  const policyEngine = new PolicyEngine(
    compiledPolicy,
    toolAnnotations,
    protectedPaths,
    allowedDirectory,
    serverDomainAllowlists,
    dynamicLists,
    trustedServers,
  );
  const auditLog = new AuditLog(auditLogPath, { redact: auditRedaction });
  const circuitBreaker = new CallCircuitBreaker();

  const autoApproveModel = await createAutoApproveModel(sessionLogPath);

  const policyRoots = extractPolicyRoots(compiledPolicy, allowedDirectory ?? '/tmp');
  const mcpRoots = toMcpRoots(policyRoots);

  // ── Sandbox availability & config resolution ──────────────────────
  const { sandboxAvailable } = validateSandboxAvailability(sandboxPolicy, sessionLogPath, process.platform);
  const { resolvedSandboxConfigs, settingsDir, serverCwdPaths } = resolveServerSandboxConfigs(
    serversConfig,
    allowedDirectory,
    sandboxAvailable,
    sandboxPolicy,
  );

  // ── Connect to real MCP servers ───────────────────────────────────
  const clientStates = new Map<string, ClientState>();
  const allTools: ProxiedTool[] = [];

  for (const [serverName, config] of Object.entries(serversConfig)) {
    // Skip servers whose args reference env vars (Docker -e VAR_NAME syntax)
    // that aren't set — the server will fail to start without them.
    const missingEnvVars = getMissingEnvVars(config.args);
    if (missingEnvVars.length > 0) {
      const warning = `Skipping MCP server "${serverName}": missing environment variable(s) ${missingEnvVars.join(', ')}`;
      process.stderr.write(`WARNING: ${warning}\n`);
      if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${warning}`);
      continue;
    }

    const resolved = resolvedSandboxConfigs.get(serverName);
    if (!resolved) throw new Error(`Missing sandbox config for server "${serverName}"`);
    const wrapped = wrapServerCommand(serverName, config.command, config.args, resolved, settingsDir);

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}), ...serverCredentials },
      stderr: 'pipe',
      // Sandboxed servers use a per-server temp dir as CWD (not the sandbox)
      // to prevent srt/bwrap ghost dotfiles from polluting the sandbox directory.
      ...(resolved.sandboxed && serverCwdPaths.has(serverName) ? { cwd: serverCwdPaths.get(serverName) } : {}),
    });

    let serverStderr = '';
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        serverStderr += text;
        if (sessionLogPath) {
          const lines = text.trimEnd();
          if (lines) {
            const redacted = redactCredentials(lines, serverCredentials);
            logToSessionFile(sessionLogPath, `[mcp:${serverName}] ${redacted}`);
          }
        }
      });
    }

    // See permissive-output-validator.ts for why this is needed.
    const client = new Client(
      { name: 'ironcurtain-proxy', version: VERSION },
      {
        capabilities: { roots: { listChanged: true } },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
      },
    );

    const state: ClientState = { client, roots: [...mcpRoots] };

    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (state.rootsRefreshed) {
        state.rootsRefreshed();
        state.rootsRefreshed = undefined;
      }
      return { roots: state.roots };
    });

    try {
      await client.connect(transport);
    } catch (err) {
      const cmd = `${wrapped.command} ${wrapped.args.join(' ')}`;
      const stderrSnippet = serverStderr ? `\nServer stderr: ${serverStderr.substring(0, 1000)}` : '';
      throw new Error(
        `Failed to connect to MCP server "${serverName}" (${cmd}): ${err instanceof Error ? err.message : String(err)}${stderrSnippet}`,
        { cause: err },
      );
    }
    clientStates.set(serverName, state);

    const result = await client.listTools();
    for (const tool of result.tools) {
      allTools.push({
        serverName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      });
    }
  }

  const toolMap = buildToolMap(allTools);
  const toolDescriptionHints = loadToolDescriptionHints();
  const hintedTools = applyToolDescriptionHints(allTools, toolDescriptionHints);
  const listToolsResponse = {
    tools: hintedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };

  // ── Create the proxy MCP server ───────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional use of low-level Server for raw JSON schema passthrough
  const server = new Server({ name: 'ironcurtain-proxy', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => listToolsResponse);

  const serverContextMap: ServerContextMap = new Map();

  const callToolDeps: CallToolDeps = {
    toolMap,
    policyEngine,
    auditLog,
    circuitBreaker,
    clientStates,
    resolvedSandboxConfigs,
    allowedDirectory,
    escalationDir,
    autoApproveModel,
    serverContextMap,
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleCallTool(req.params.name, req.params.arguments ?? {}, callToolDeps);
  });

  // ── Transport selection ───────────────────────────────────────────
  const transportConfig = selectTransportConfig();
  let transport: Transport;
  if (transportConfig.kind === 'tcp') {
    const tcpTransport = new TcpServerTransport('0.0.0.0', transportConfig.port);
    transport = tcpTransport;
    await tcpTransport.start();
    if (transportConfig.portFilePath) {
      writeFileSync(transportConfig.portFilePath, String(tcpTransport.port));
    }
    if (sessionLogPath) {
      logToSessionFile(sessionLogPath, `MCP proxy listening on 0.0.0.0:${tcpTransport.port}`);
    }
  } else if (transportConfig.kind === 'uds') {
    transport = new UdsServerTransport(transportConfig.socketPath);
  } else {
    transport = new StdioServerTransport();
  }
  await server.connect(transport);

  // ── Shutdown handler ──────────────────────────────────────────────
  async function shutdown(): Promise<void> {
    for (const state of clientStates.values()) {
      try {
        await state.client.close();
      } catch {
        /* ignore */
      }
    }
    cleanupSettingsFiles(settingsDir);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    await auditLog.close();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

// Only run main() when this module is the entry point (not when imported for testing)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`MCP Proxy Server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
