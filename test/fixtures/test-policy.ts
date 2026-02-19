/**
 * Deterministic test policy and annotations.
 *
 * Tests must NOT depend on the LLM-generated files in src/config/generated/
 * because those change with every pipeline run. This fixture provides a
 * stable, hand-crafted policy that exercises all the behaviors the tests
 * verify: sandbox containment, read escalation, write/delete denial,
 * move handling, and side-effect-free tool allowance.
 */

import type { CompiledPolicyFile, ToolAnnotationsFile } from '../../src/pipeline/types.js';

/**
 * Compiled policy rules. Order matters (first match wins per role).
 * Structural invariants (protected paths, unknown tools, sandbox containment)
 * are handled by the PolicyEngine before these rules are evaluated.
 */
export const testCompiledPolicy: CompiledPolicyFile = {
  generatedAt: 'test-fixture',
  constitutionHash: 'test-fixture',
  inputHash: 'test-fixture',
  rules: [
    {
      name: 'allow-list-allowed-directories',
      description: 'Allow list_allowed_directories (side-effect-free introspection).',
      principle: 'Least privilege',
      if: {
        server: ['filesystem'],
        tool: ['list_allowed_directories'],
      },
      then: 'allow',
      reason: 'No filesystem changes, no path arguments.',
    },
    {
      name: 'deny-delete-outside-permitted-areas',
      description: 'Deny delete-path operations outside sandbox.',
      principle: 'No destruction',
      if: {
        roles: ['delete-path'],
        server: ['filesystem'],
      },
      then: 'deny',
      reason: 'Deletes outside sandbox are forbidden. Structural sandbox invariant allows sandbox-internal deletes before this rule fires.',
    },
    {
      name: 'deny-write-outside-permitted-areas',
      description: 'Deny write-path operations outside sandbox.',
      principle: 'Least privilege',
      if: {
        roles: ['write-path'],
        server: ['filesystem'],
      },
      then: 'deny',
      reason: 'Writes outside sandbox are denied.',
    },
    {
      name: 'escalate-read-outside-permitted-areas',
      description: 'Escalate read-path operations outside sandbox to human.',
      principle: 'Human oversight',
      if: {
        roles: ['read-path'],
        server: ['filesystem'],
      },
      then: 'escalate',
      reason: 'Reads outside sandbox require human approval.',
    },
  ],
};

/**
 * Tool annotations for the filesystem MCP server.
 * Matches the stable tool set from @modelcontextprotocol/server-filesystem.
 */
export const testToolAnnotations: ToolAnnotationsFile = {
  generatedAt: 'test-fixture',
  servers: {
    filesystem: {
      inputHash: 'test-fixture',
      tools: [
        {
          toolName: 'read_file',
          serverName: 'filesystem',
          comment: 'Reads file contents.',
          sideEffects: true,
          args: { path: ['read-path'], tail: ['none'], head: ['none'] },
        },
        {
          toolName: 'read_text_file',
          serverName: 'filesystem',
          comment: 'Reads text file contents.',
          sideEffects: true,
          args: { path: ['read-path'], tail: ['none'], head: ['none'] },
        },
        {
          toolName: 'read_media_file',
          serverName: 'filesystem',
          comment: 'Reads image/audio file as base64.',
          sideEffects: true,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'read_multiple_files',
          serverName: 'filesystem',
          comment: 'Reads multiple files at once.',
          sideEffects: true,
          args: { paths: ['read-path'] },
        },
        {
          toolName: 'write_file',
          serverName: 'filesystem',
          comment: 'Creates or overwrites a file.',
          sideEffects: true,
          args: { path: ['write-path'], content: ['none'] },
        },
        {
          toolName: 'edit_file',
          serverName: 'filesystem',
          comment: 'Makes targeted edits to a file.',
          sideEffects: true,
          args: { path: ['read-path', 'write-path'], edits: ['none'], dryRun: ['none'] },
        },
        {
          toolName: 'create_directory',
          serverName: 'filesystem',
          comment: 'Creates a directory.',
          sideEffects: true,
          args: { path: ['write-path'] },
        },
        {
          toolName: 'list_directory',
          serverName: 'filesystem',
          comment: 'Lists directory contents.',
          sideEffects: true,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'list_directory_with_sizes',
          serverName: 'filesystem',
          comment: 'Lists directory contents with sizes.',
          sideEffects: true,
          args: { path: ['read-path'], sortBy: ['none'] },
        },
        {
          toolName: 'directory_tree',
          serverName: 'filesystem',
          comment: 'Recursive directory tree view.',
          sideEffects: true,
          args: { path: ['read-path'], excludePatterns: ['none'] },
        },
        {
          toolName: 'move_file',
          serverName: 'filesystem',
          comment: 'Moves or renames a file/directory.',
          sideEffects: true,
          args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
        },
        {
          toolName: 'search_files',
          serverName: 'filesystem',
          comment: 'Searches for files matching a pattern.',
          sideEffects: true,
          args: { path: ['read-path'], pattern: ['none'], excludePatterns: ['none'] },
        },
        {
          toolName: 'get_file_info',
          serverName: 'filesystem',
          comment: 'Gets file metadata.',
          sideEffects: true,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'list_allowed_directories',
          serverName: 'filesystem',
          comment: 'Lists allowed directories (no side effects).',
          sideEffects: false,
          args: {},
        },
      ],
    },
  },
};
