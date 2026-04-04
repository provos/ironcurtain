import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentStateDefinition, WorkflowContext } from './types.js';
import { STATUS_BLOCK_INSTRUCTIONS } from './status-parser.js';
import { collectFilesRecursive } from './artifacts.js';

// ---------------------------------------------------------------------------
// Artifact reading helpers
// ---------------------------------------------------------------------------

/**
 * Reads all files from an artifact directory (recursively) and returns their
 * concatenated content with headers. Returns empty string if the directory
 * does not exist or contains no files.
 */
function readArtifactContent(artifactDir: string, artifactName: string): string {
  const dir = resolve(artifactDir, artifactName);
  const files = collectFilesRecursive(dir);
  if (files.length === 0) return '';

  const parts: string[] = [];
  for (const file of files) {
    const content = readFileSync(file.fullPath, 'utf-8');
    parts.push(`### ${artifactName}/${file.relativePath}\n\n${content}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Review history formatting
// ---------------------------------------------------------------------------

const MAX_REVIEW_HISTORY = 3;

function formatReviewHistory(reviewHistory: readonly string[]): string {
  if (reviewHistory.length === 0) return '';

  const recent = reviewHistory.slice(-MAX_REVIEW_HISTORY);
  const lines = recent.map((note, i) => `**Round ${reviewHistory.length - recent.length + i + 1}:** ${note}`);
  return `## Previous Review Feedback\n\n${lines.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assembles the full command string sent to an agent session.
 *
 * Includes:
 * - Input artifact content (read from disk)
 * - Review history (last 3 rounds)
 * - Human prompt (if present from a FORCE_REVISION gate)
 * - Status block format instructions
 */
export function buildAgentCommand(
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  artifactDir: string,
): string {
  const sections: string[] = [];

  // Task description
  sections.push(`## Task\n\n${context.taskDescription}`);

  // Input artifacts
  for (const inputRef of stateConfig.inputs) {
    const isOptional = inputRef.endsWith('?');
    const name = isOptional ? inputRef.slice(0, -1) : inputRef;
    const content = readArtifactContent(artifactDir, name);
    if (content) {
      sections.push(`## Input: ${name}\n\n${content}`);
    }
  }

  // Review history
  const reviewSection = formatReviewHistory(context.reviewHistory);
  if (reviewSection) {
    sections.push(reviewSection);
  }

  // Human prompt from gate
  if (context.humanPrompt) {
    sections.push(`## Human Feedback\n\n${context.humanPrompt}`);
  }

  // Expected outputs
  if (stateConfig.outputs.length > 0) {
    const outputList = stateConfig.outputs.map((o) => `- \`${o}/\``).join('\n');
    sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);
  }

  // Status block instructions
  sections.push(STATUS_BLOCK_INSTRUCTIONS);

  return sections.join('\n\n---\n\n');
}

/**
 * Builds a re-prompt for missing artifacts. Uses relative paths only
 * (no host-absolute paths, since Docker agents see /workspace).
 */
export function buildArtifactReprompt(missing: readonly string[]): string {
  const paths = missing.map((name) => `  - \`${name}/\``);
  return (
    'The following required output artifacts were not created in your workspace:\n' +
    paths.join('\n') +
    '\n\nPlease create them now. Each artifact should be a directory ' +
    'containing at least one file.\n\n' +
    STATUS_BLOCK_INSTRUCTIONS
  );
}
