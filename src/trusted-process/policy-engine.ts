import { resolve } from 'node:path';
import type { ToolCallRequest } from '../types/mcp.js';
import type { PolicyRule, EvaluationResult } from './policy-types.js';

/**
 * Structural invariant: file name patterns that the agent must never
 * access. These protect the constitution, policy engine, audit log,
 * and server configuration from tampering by a compromised agent.
 */
const PROTECTED_PATTERNS = [
  'constitution.md',
  'policy-engine',
  'policy-types',
  'audit-log',
  'mcp-servers.json',
];

/**
 * Heuristically extracts filesystem paths from tool call arguments.
 * Any string value starting with '/' or '.' is treated as a path.
 */
function extractPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && (value.startsWith('/') || value.startsWith('.'))) {
      paths.push(value);
    }
  }
  return paths;
}

/**
 * Checks whether a target path is contained within a directory.
 * Both paths are resolved to absolute form before comparison,
 * which neutralizes path traversal attacks (e.g., "../../etc/passwd").
 */
function isWithinDirectory(targetPath: string, directory: string): boolean {
  const resolved = resolve(targetPath);
  const resolvedDir = resolve(directory);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + '/');
}

/**
 * Returns true if any path argument contains a protected file pattern.
 * Uses substring matching intentionally -- conservative over permissive.
 */
function touchesProtectedFile(args: Record<string, unknown>): boolean {
  const paths = extractPaths(args);
  return paths.some(p =>
    PROTECTED_PATTERNS.some(pattern => p.includes(pattern))
  );
}

const READ_TOOLS = new Set([
  'read_file',
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
]);

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
]);

const DELETE_TOOLS = new Set([
  'delete_file',
  'delete_directory',
]);

/**
 * Builds the ordered policy rule chain. Rules are evaluated top-to-bottom;
 * the first matching rule wins. This implements a subset of the full
 * policy evaluation order from the architecture doc:
 *
 *   Structural invariants -> (Task policy: not yet in PoC) ->
 *   Compiled constitution (deterministic rules) -> Default deny
 */
function buildRules(): PolicyRule[] {
  return [
    // Structural invariants: protect constitution, policy, and audit files
    {
      name: 'structural-protect-policy-files',
      description: 'Deny any access to constitution or policy files',
      condition: (req) => touchesProtectedFile(req.arguments),
      decision: 'deny',
      reason: 'Access to constitution/policy files is forbidden',
    },

    // Constitution: "The agent must never delete data permanently"
    {
      name: 'deny-delete-operations',
      description: 'Deny all delete operations',
      condition: (req) => DELETE_TOOLS.has(req.toolName),
      decision: 'deny',
      reason: 'Delete operations are not permitted',
    },

    // Constitution: allow read operations within the sandbox boundary
    {
      name: 'allow-read-in-allowed-dir',
      description: 'Allow read operations within the allowed directory',
      condition: (req, allowedDir) => {
        if (!READ_TOOLS.has(req.toolName)) return false;
        if (req.toolName === 'list_allowed_directories') return true;
        const paths = extractPaths(req.arguments);
        return paths.length > 0 && paths.every(p => isWithinDirectory(p, allowedDir));
      },
      decision: 'allow',
      reason: 'Read operation within allowed directory',
    },

    // Constitution: deny reads outside the sandbox boundary
    {
      name: 'deny-read-outside-allowed-dir',
      description: 'Deny read operations outside the allowed directory',
      condition: (req) => READ_TOOLS.has(req.toolName),
      decision: 'deny',
      reason: 'Read operation outside allowed directory',
    },

    // Constitution: allow writes within the sandbox boundary
    {
      name: 'allow-write-in-allowed-dir',
      description: 'Allow write operations within the allowed directory',
      condition: (req, allowedDir) => {
        if (!WRITE_TOOLS.has(req.toolName)) return false;
        const paths = extractPaths(req.arguments);
        return paths.length > 0 && paths.every(p => isWithinDirectory(p, allowedDir));
      },
      decision: 'allow',
      reason: 'Write operation within allowed directory',
    },

    // Constitution: escalate writes outside sandbox to human approval
    {
      name: 'escalate-write-outside-allowed-dir',
      description: 'Escalate write operations outside the allowed directory',
      condition: (req) => WRITE_TOOLS.has(req.toolName),
      decision: 'escalate',
      reason: 'Write operation outside allowed directory requires human approval',
    },
  ];
}

export class PolicyEngine {
  private rules: PolicyRule[];
  private allowedDirectory: string;

  constructor(allowedDirectory: string) {
    this.rules = buildRules();
    this.allowedDirectory = resolve(allowedDirectory);
  }

  evaluate(request: ToolCallRequest): EvaluationResult {
    for (const rule of this.rules) {
      if (rule.condition(request, this.allowedDirectory)) {
        return {
          decision: rule.decision,
          rule: rule.name,
          reason: rule.reason,
        };
      }
    }

    // Default deny
    return {
      decision: 'deny',
      rule: 'default-deny',
      reason: 'No matching policy rule — denied by default',
    };
  }
}
