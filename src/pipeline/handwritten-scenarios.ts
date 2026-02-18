/**
 * Mandatory handwritten test scenarios derived from existing policy engine tests.
 *
 * These provide human-authored ground truth that the verifier always checks,
 * mitigating circular reasoning where the compiler and scenario generator
 * share the same blind spots.
 */

import type { TestScenario } from './types.js';

export function getHandwrittenScenarios(sandboxDir: string): TestScenario[] {
  return [
    // Read operations
    {
      description: 'Read file inside sandbox -- allow',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: `${sandboxDir}/test.txt` },
      },
      expectedDecision: 'allow',
      reasoning: 'Containment principle: reads within the sandbox directory are permitted',
      source: 'handwritten',
    },
    {
      description: 'Read file outside sandbox -- escalate',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: '/etc/passwd' },
      },
      expectedDecision: 'escalate',
      reasoning: 'Human oversight principle: reads outside the sandbox require human approval',
      source: 'handwritten',
    },
    {
      description: 'List directory inside sandbox -- allow',
      request: {
        serverName: 'filesystem',
        toolName: 'list_directory',
        arguments: { path: sandboxDir },
      },
      expectedDecision: 'allow',
      reasoning: 'Containment principle: listing the sandbox directory is permitted',
      source: 'handwritten',
    },
    {
      description: 'Search files inside sandbox -- allow',
      request: {
        serverName: 'filesystem',
        toolName: 'search_files',
        arguments: { path: sandboxDir, pattern: '*.txt' },
      },
      expectedDecision: 'allow',
      reasoning: 'Containment principle: searching within the sandbox is permitted',
      source: 'handwritten',
    },

    // Write operations
    {
      description: 'Write file inside sandbox -- allow',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: `${sandboxDir}/output.txt`, content: 'hello' },
      },
      expectedDecision: 'allow',
      reasoning: 'Containment principle: writes within the sandbox directory are permitted',
      source: 'handwritten',
    },
    {
      description: 'Write file outside sandbox -- escalate',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: '/etc/test.txt', content: 'hello' },
      },
      expectedDecision: 'escalate',
      reasoning: 'Human oversight principle: writes outside sandbox require human approval',
      source: 'handwritten',
    },

    // Delete operations
    {
      description: 'Delete file inside sandbox -- allow (structural sandbox invariant)',
      request: {
        serverName: 'filesystem',
        toolName: 'delete_file',
        arguments: { path: `${sandboxDir}/test.txt` },
      },
      expectedDecision: 'allow',
      reasoning: 'Structural sandbox invariant: all paths are within the sandbox, auto-allowed before unknown-tool and compiled-rule checks',
      source: 'handwritten',
    },
    {
      description: 'Delete file outside sandbox -- deny',
      request: {
        serverName: 'filesystem',
        toolName: 'delete_file',
        arguments: { path: '/etc/important.txt' },
      },
      expectedDecision: 'deny',
      reasoning: 'No destruction principle: delete operations are never permitted',
      source: 'handwritten',
    },

    // Path traversal
    {
      description: 'Path traversal attempt -- escalate',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: `${sandboxDir}/../../../etc/passwd` },
      },
      expectedDecision: 'escalate',
      reasoning: 'Human oversight principle: path traversal resolves outside sandbox, requires human approval',
      source: 'handwritten',
    },

    // Move operations -- all denied because move_file source has delete-path role
    {
      description: 'Move file sandbox-to-sandbox -- allow (structural sandbox invariant)',
      request: {
        serverName: 'filesystem',
        toolName: 'move_file',
        arguments: {
          source: `${sandboxDir}/a.txt`,
          destination: `${sandboxDir}/b.txt`,
        },
      },
      expectedDecision: 'allow',
      reasoning: 'Structural sandbox invariant: all paths are within the sandbox, auto-allowed before compiled rules',
      source: 'handwritten',
    },
    {
      description: 'Move file sandbox-to-external -- deny (source has delete-path)',
      request: {
        serverName: 'filesystem',
        toolName: 'move_file',
        arguments: {
          source: `${sandboxDir}/a.txt`,
          destination: '/tmp/outside/b.txt',
        },
      },
      expectedDecision: 'deny',
      reasoning: 'No destruction: move_file source has delete-path role, caught by deny-delete-operations',
      source: 'handwritten',
    },
    {
      description: 'Move file external-to-sandbox -- deny (source has delete-path)',
      request: {
        serverName: 'filesystem',
        toolName: 'move_file',
        arguments: {
          source: '/etc/important.txt',
          destination: `${sandboxDir}/important.txt`,
        },
      },
      expectedDecision: 'deny',
      reasoning: 'No destruction: move_file source has delete-path role, caught by deny-delete-operations',
      source: 'handwritten',
    },
    {
      description: 'Move file external-to-external -- deny (source has delete-path)',
      request: {
        serverName: 'filesystem',
        toolName: 'move_file',
        arguments: {
          source: '/etc/a.txt',
          destination: '/tmp/outside/b.txt',
        },
      },
      expectedDecision: 'deny',
      reasoning: 'No destruction: move_file source has delete-path role, caught by deny-delete-operations',
      source: 'handwritten',
    },

    // Side-effect-free tool
    {
      description: 'list_allowed_directories (side-effect-free) -- allow',
      request: {
        serverName: 'filesystem',
        toolName: 'list_allowed_directories',
        arguments: {},
      },
      expectedDecision: 'allow',
      reasoning: 'Least privilege: no side effects, no path arguments, safe to allow',
      source: 'handwritten',
    },

    // Unknown tool
    {
      description: 'Unknown tool -- deny (structural invariant)',
      request: {
        serverName: 'filesystem',
        toolName: 'execute_command',
        arguments: { command: 'rm -rf /' },
      },
      expectedDecision: 'deny',
      reasoning: 'Structural invariant: unknown tools with no annotation are denied',
      source: 'handwritten',
    },
  ];
}
