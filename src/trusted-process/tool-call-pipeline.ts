/**
 * Tool Call Pipeline -- The core security evaluation logic.
 *
 * Owns the full tool-call policy pipeline: argument validation,
 * annotation-driven normalization, policy evaluation, escalation
 * (file-IPC and in-process), auto-approval, circuit breaking,
 * whitelist matching, roots expansion, dispatch, and audit logging.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import { PolicyEngine, extractAnnotatedPaths } from './policy-engine.js';
import { getPathRoles } from '../types/argument-roles.js';
import { AuditLog } from './audit-log.js';
import { prepareToolArgs, rewriteResultContent } from './path-utils.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { directoryForPath } from './policy-roots.js';
import { annotateSandboxViolation, type ResolvedSandboxConfig } from './sandbox-integration.js';
import type { ToolCallRequest, PolicyDecision } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import { ROOTS_REFRESH_TIMEOUT_MS, type ClientState, type McpRoot } from './mcp-client-manager.js';
import { CallCircuitBreaker } from './call-circuit-breaker.js';
import { autoApprove, extractArgsForAutoApprove, readUserContext, type UserContext } from './auto-approver.js';
import { extractMcpErrorMessage } from './mcp-error-utils.js';
import { type ServerContextMap, updateServerContext, formatServerContext } from './server-context.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ToolAnnotation } from '../pipeline/types.js';
import {
  extractWhitelistCandidates,
  type ApprovalWhitelist,
  type WhitelistCandidateIpc,
} from './approval-whitelist.js';
import { handleVirtualProxyTool, type ControlApiClient } from '../docker/proxy-tools.js';
import {
  ERROR_PREFIX_DENIED,
  ERROR_PREFIX_ESCALATION_REQUIRED,
  ERROR_PREFIX_ESCALATION_DENIED,
  ERROR_PREFIX_UNKNOWN_ARGS,
  ERROR_PREFIX_MISSING_ANNOTATION,
} from './error-prefixes.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Whitelist candidates extracted from this escalation's annotation. */
  whitelistCandidates?: WhitelistCandidateIpc[];
}

/** Re-exported from `mcp-client-manager.ts` for call-sites that import it from here. */
export type { ClientState } from './mcp-client-manager.js';

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

/** Parsed escalation response with optional whitelist selection. */
interface EscalationResponseData {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

/**
 * Reads and parses the escalation response file if it exists.
 * Returns the response data, or undefined if the file is not present.
 */
function readEscalationResponse(responsePath: string): EscalationResponseData | undefined {
  if (!existsSync(responsePath)) return undefined;
  const raw = JSON.parse(readFileSync(responsePath, 'utf-8')) as Record<string, unknown>;

  // Validate whitelistSelection: must be an integer if present, discard otherwise
  let whitelistSelection: number | undefined;
  if (typeof raw.whitelistSelection === 'number' && Number.isInteger(raw.whitelistSelection)) {
    whitelistSelection = raw.whitelistSelection;
  }

  return {
    decision: raw.decision as 'approved' | 'denied',
    ...(whitelistSelection !== undefined ? { whitelistSelection } : {}),
  };
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
): Promise<EscalationResponseData> {
  const requestPath = resolve(escalationDir, `request-${request.escalationId}.json`);
  const responsePath = resolve(escalationDir, `response-${request.escalationId}.json`);

  atomicWriteJsonSync(requestPath, request);

  const deadline = Date.now() + getEscalationTimeoutMs();

  while (Date.now() < deadline) {
    const response = readEscalationResponse(responsePath);
    if (response) {
      cleanupEscalationFiles(requestPath, responsePath);
      return response;
    }
    await new Promise((r) => setTimeout(r, ESCALATION_POLL_INTERVAL_MS));
  }

  // Final check -- response may have arrived between last poll and deadline
  const lateResponse = readEscalationResponse(responsePath);
  cleanupEscalationFiles(requestPath, responsePath);
  return lateResponse ?? { decision: 'denied' };
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
 * Validates that all argument keys exist in the tool's `inputSchema`.
 * Returns `null` if valid, or an error message listing unknown and
 * valid keys.
 *
 * Skips validation in two cases:
 *   1. The schema has no `properties` object (nothing to check against).
 *   2. `additionalProperties` is truthy (explicit opt-out).
 *
 * NOTE: This is stricter than plain JSON Schema, which treats a
 * missing `additionalProperties` as equivalent to `true`. Here we
 * treat it as forbidding unknown keys so typos in tool arguments
 * fail fast instead of silently passing through to the MCP server.
 * Servers that genuinely accept extra keys must declare
 * `additionalProperties: true` explicitly.
 */
export function validateToolArguments(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): string | null {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object') return null;
  if (inputSchema.additionalProperties) return null;

  const validKeys = new Set(Object.keys(properties as Record<string, unknown>));
  const unknownKeys = Object.keys(args).filter((k) => !validKeys.has(k));
  if (unknownKeys.length === 0) return null;

  const unknownList = unknownKeys.map((k) => `"${k}"`).join(', ');
  const validList = [...validKeys]
    .sort()
    .map((k) => `"${k}"`)
    .join(', ');
  return `${ERROR_PREFIX_UNKNOWN_ARGS} ${unknownList}. Valid parameters are: ${validList}`;
}

/**
 * Splits a coordinator tool key of the form `server__tool` into its
 * component parts. Falls back to `('unknown', key)` when the key has
 * no separator (e.g. a raw tool name passed from an unregistered
 * caller). Used for audit-log attribution on unknown-tool rejections.
 */
export function splitToolKey(key: string): [server: string, tool: string] {
  const sep = key.indexOf('__');
  if (sep < 0) return ['unknown', key];
  return [key.slice(0, sep), key.slice(sep + 2)];
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
    whitelistApproved?: boolean;
    whitelistPatternId?: string;
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
    whitelistApproved: options.whitelistApproved || undefined,
    whitelistPatternId: options.whitelistPatternId,
  };
}

// ---------------------------------------------------------------------------
// MCP tool call response shape
// ---------------------------------------------------------------------------

/** MCP tool call response shape returned by handleCallTool. */
export interface ToolCallResponse {
  content: unknown;
  isError?: boolean;
  /**
   * Internal-only: the realized PolicyDecision from this call. Not part
   * of the MCP protocol; the field is present on the JS object but the
   * MCP SDK serializes only `content` and `isError` over stdio.
   * Used by the coordinator's `handleStructuredToolCall` to surface the
   * full decision trace to in-process callers.
   */
  _policyDecision?: PolicyDecision;
  [key: string]: unknown;
}

/**
 * In-process escalation callback. When set on `CallToolDeps`, the
 * coordinator-driven code path invokes this instead of the file-IPC
 * `waitForEscalationDecision` flow.
 *
 * Callers must resolve to `'approved'` or `'denied'` and may optionally
 * indicate a whitelist pattern to persist (`whitelistSelection`).
 */
export interface InProcessEscalation {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

export type InProcessEscalationFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
  whitelistCandidates?: readonly WhitelistCandidateIpc[],
) => Promise<InProcessEscalation>;

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
  /** Ephemeral approval whitelist for this session. */
  whitelist: ApprovalWhitelist;
  /** Control API client for virtual proxy tools. Only set in virtual-only mode. */
  controlApiClient?: ControlApiClient | null;
  /**
   * Optional in-process escalation handler. When set, supersedes the
   * file-IPC escalation path. Used by the coordinator when callers
   * provide a direct callback (e.g., integration tests).
   */
  onEscalation?: InProcessEscalationFn;
  /**
   * Optional trusted-user message for auto-approval context. When set,
   * bypasses the file-based `readUserContext` lookup and feeds this
   * directly to the auto-approver. Used by the coordinator when the
   * in-process caller knows the user's last message.
   */
  autoApproveUserMessage?: string;
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Handles a single tool call request: policy evaluation, escalation,
 * circuit breaker check, and forwarding to the real MCP server.
 *
 * This is the core security logic -- the single source of truth for
 * the policy evaluation pipeline.
 */
export async function handleCallTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  deps: CallToolDeps,
): Promise<ToolCallResponse> {
  const toolInfo = deps.toolMap.get(toolName);

  if (!toolInfo) {
    // Security invariant: every tool call outcome is audited, even
    // the ones that short-circuit before policy evaluation.
    const reason = `Unknown tool: ${toolName}`;
    const [unknownServer, unknownTool] = splitToolKey(toolName);
    deps.auditLog.log({
      timestamp: new Date().toISOString(),
      requestId: uuidv4(),
      serverName: unknownServer,
      toolName: unknownTool,
      arguments: rawArgs,
      policyDecision: { status: 'deny', rule: 'unknown-tool', reason },
      result: { status: 'denied', error: reason },
      durationMs: 0,
    });
    return {
      content: [{ type: 'text', text: reason }],
      isError: true,
      _policyDecision: { status: 'deny', rule: 'unknown-tool', reason },
    };
  }

  // Annotation-driven normalization: split into transport vs policy args.
  // Trusted servers skip annotation lookup and prepareToolArgs -- use raw args directly.
  const annotation = deps.policyEngine.getAnnotation(toolInfo.serverName, toolInfo.name, rawArgs);
  const isTrusted = !annotation && deps.policyEngine.isTrustedServer(toolInfo.serverName);

  if (!annotation && !isTrusted) {
    const reason = `${ERROR_PREFIX_MISSING_ANNOTATION} ${toolInfo.serverName}__${toolInfo.name}. Re-run 'ironcurtain annotate-tools' to update.`;
    // Security invariant: every tool call outcome is audited.
    deps.auditLog.log({
      timestamp: new Date().toISOString(),
      requestId: uuidv4(),
      serverName: toolInfo.serverName,
      toolName: toolInfo.name,
      arguments: rawArgs,
      policyDecision: { status: 'deny', rule: 'missing-annotation', reason },
      result: { status: 'denied', error: reason },
      durationMs: 0,
    });
    return {
      content: [{ type: 'text', text: reason }],
      isError: true,
      _policyDecision: { status: 'deny', rule: 'missing-annotation', reason },
    };
  }

  // Validate argument names against the tool's schema.
  // Skip for trusted servers (check directly, not via isTrusted which also requires missing annotation).
  if (!deps.policyEngine.isTrustedServer(toolInfo.serverName)) {
    const validationError = validateToolArguments(rawArgs, toolInfo.inputSchema);
    if (validationError) {
      deps.auditLog.log({
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
        serverName: toolInfo.serverName,
        toolName: toolInfo.name,
        arguments: rawArgs,
        policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: validationError },
        result: { status: 'denied', error: validationError },
        durationMs: 0,
      });
      return {
        content: [{ type: 'text', text: validationError }],
        isError: true,
        _policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: validationError },
      };
    }
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
          _policyDecision: { status: 'deny', rule: 'git-path-enrichment-failed', reason: errorMsg },
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
  let whitelistApproved = false;
  let whitelistPatternId: string | undefined;
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
      whitelistApproved: whitelistApproved || undefined,
      whitelistPatternId,
    });
    deps.auditLog.log(entry);
  }

  if (evaluation.decision === 'escalate') {
    // Annotation is guaranteed non-null here: trusted servers always allow (never escalate),
    // and missing-annotation returns early above. Narrow the type for TypeScript.
    const resolvedAnnotation = annotation as ToolAnnotation;
    const whitelistMatch = deps.whitelist.match(toolInfo.serverName, toolInfo.name, argsForPolicy, resolvedAnnotation);
    if (whitelistMatch.matched) {
      whitelistApproved = true;
      whitelistPatternId = whitelistMatch.patternId;
      escalationResult = 'approved';
      policyDecision.status = 'allow';
      policyDecision.reason = `Whitelist-approved: ${whitelistMatch.pattern.description}`;
    }

    if (!whitelistApproved) {
      // Escalation routing: in-process callback supersedes file-IPC.
      // If neither is configured, auto-deny with a descriptive error.
      const hasInProcess = typeof deps.onEscalation === 'function';
      if (!hasInProcess && !deps.escalationDir) {
        logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
        return {
          content: [
            {
              type: 'text',
              text: `${ERROR_PREFIX_ESCALATION_REQUIRED} ${evaluation.reason}. Action denied (no escalation handler).`,
            },
          ],
          isError: true,
          _policyDecision: { ...policyDecision },
        };
      }

      const escalationId = uuidv4();

      // Try auto-approve before falling through to human escalation.
      // Prefer the caller-provided `autoApproveUserMessage` when set;
      // otherwise fall back to the file-IPC user context.
      if (deps.autoApproveModel) {
        const userMessage =
          deps.autoApproveUserMessage ??
          (deps.escalationDir ? readUserContext(deps.escalationDir)?.userMessage : undefined);

        if (userMessage !== undefined && userMessage !== '') {
          // When using the file-IPC context, validate trust metadata
          // the same way the legacy code did. Direct callers bypass
          // this check (they establish trust out-of-band).
          let trusted = true;
          if (deps.autoApproveUserMessage === undefined && deps.escalationDir) {
            const ctx = readUserContext(deps.escalationDir);
            const isPtySession = process.env.IRONCURTAIN_PTY_SESSION === '1';
            trusted = ctx !== null && isUserContextTrusted(ctx, isPtySession);
          }

          if (trusted) {
            const autoResult = await autoApprove(
              {
                userMessage,
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
        // Extract whitelist candidates just before human escalation (avoids
        // wasted work when auto-approve succeeds).
        const { patterns: candidatePatterns, ipcs: candidateIpcs } = extractWhitelistCandidates(
          toolInfo.serverName,
          toolInfo.name,
          argsForPolicy,
          resolvedAnnotation,
          evaluation.escalatedRoles,
          escalationId,
          evaluation.reason,
        );
        const escalationContext = formatServerContext(deps.serverContextMap, toolInfo.serverName);

        // One of these paths is guaranteed to be taken: we returned
        // early above when both `onEscalation` and `escalationDir`
        // were unset. Declare `response` with a default to satisfy
        // TS's control-flow analysis without weakening runtime
        // guarantees.
        let response: { decision: 'approved' | 'denied'; whitelistSelection?: number } = {
          decision: 'denied',
        };
        if (deps.onEscalation) {
          // In-process path: invoke the caller's callback synchronously
          // in async terms and use its return value directly.
          response = await deps.onEscalation(
            {
              requestId: request.requestId,
              serverName: request.serverName,
              toolName: request.toolName,
              arguments: argsForTransport,
              timestamp: request.timestamp,
            },
            evaluation.reason,
            escalationContext,
            candidateIpcs.length > 0 ? candidateIpcs : undefined,
          );
        } else if (deps.escalationDir !== undefined) {
          // File-IPC path (unchanged): the session on the other side
          // of the escalation directory writes the response file.
          response = await waitForEscalationDecision(deps.escalationDir, {
            escalationId,
            serverName: request.serverName,
            toolName: request.toolName,
            arguments: argsForTransport,
            reason: evaluation.reason,
            context: escalationContext,
            whitelistCandidates: candidateIpcs.length > 0 ? candidateIpcs : undefined,
          });
        }

        if (response.decision === 'denied') {
          const deniedDecision: PolicyDecision = {
            status: 'deny',
            rule: policyDecision.rule,
            reason: 'Denied by human during escalation',
          };
          logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
          return {
            content: [{ type: 'text', text: `${ERROR_PREFIX_ESCALATION_DENIED} ${evaluation.reason}` }],
            isError: true,
            _policyDecision: deniedDecision,
          };
        }

        escalationResult = 'approved';
        policyDecision.status = 'allow';
        policyDecision.reason = 'Approved by human during escalation';

        // Handle whitelist selection from the response. For in-process
        // callers, the candidates are supplied directly; for file-IPC
        // callers, they are looked up from the pending cache.
        if (response.whitelistSelection !== undefined) {
          if (response.whitelistSelection >= 0 && response.whitelistSelection < candidatePatterns.length) {
            const selectedPattern = candidatePatterns[response.whitelistSelection];
            deps.whitelist.add(selectedPattern);
          }
        }
      }
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
      content: [{ type: 'text', text: `${ERROR_PREFIX_DENIED} ${evaluation.reason}` }],
      isError: true,
      _policyDecision: { ...policyDecision },
    };
  }

  // Circuit breaker: deny if the same tool+args is called too many times
  const cbVerdict = deps.circuitBreaker.check(toolInfo.name, argsForTransport);
  if (!cbVerdict.allowed) {
    logAudit({ status: 'denied', error: cbVerdict.reason }, 0);
    return {
      content: [{ type: 'text', text: cbVerdict.reason }],
      isError: true,
      _policyDecision: { status: 'deny', rule: 'circuit-breaker', reason: cbVerdict.reason },
    };
  }

  // Virtual proxy tools: handle locally, no backend forwarding
  if (toolInfo.serverName === 'proxy' && deps.controlApiClient) {
    const startTime = Date.now();
    try {
      const result = await handleVirtualProxyTool(toolInfo.name, argsForTransport, deps.controlApiClient);
      logAudit({ status: 'success' }, Date.now() - startTime);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        _policyDecision: { ...policyDecision },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
        _policyDecision: { ...policyDecision },
      };
    }
  }

  // Policy allows -- forward to the real MCP server with transport args
  const startTime = Date.now();
  try {
    const clientState = deps.clientStates.get(toolInfo.serverName);
    if (!clientState) {
      const err = `Internal error: no client connection for server "${toolInfo.serverName}"`;
      logAudit({ status: 'denied', error: err }, 0);
      return {
        content: [{ type: 'text', text: err }],
        isError: true,
        _policyDecision: { status: 'deny', rule: 'no-client-connection', reason: err },
      };
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
      return {
        content: rewrittenContent,
        isError: true,
        _policyDecision: { ...policyDecision },
      };
    }

    updateServerContext(deps.serverContextMap, toolInfo.serverName, toolInfo.name, argsForTransport);
    logAudit({ status: 'success' }, Date.now() - startTime);
    return { content: rewrittenContent, _policyDecision: { ...policyDecision } };
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
      _policyDecision: { ...policyDecision },
    };
  }
}
