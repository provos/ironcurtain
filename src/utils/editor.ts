/**
 * Shared utilities for launching the user's preferred editor.
 *
 * Used by persona-command.ts and job-commands.ts for interactive
 * constitution and task editing flows.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Returns the user's preferred editor from environment variables. */
export function resolveEditor(): string {
  return process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'nano';
}

/**
 * Opens the user's $VISUAL / $EDITOR with a temporary file and returns
 * the edited content. Lines beginning with '#' are stripped (instructions).
 * Returns undefined if the user saves an empty file.
 *
 * @param instructions - Comment lines prepended to the temp file (prefixed with #).
 * @param initialContent - Pre-populate the file with existing content (for editing).
 * @param opts.prefix - Prefix for the temp file name (default: 'ironcurtain').
 */
export function openEditorForMultiline(
  instructions: string,
  initialContent = '',
  opts?: { prefix?: string },
): string | undefined {
  const editor = resolveEditor();
  const prefix = opts?.prefix ?? 'ironcurtain';
  const tmpFile = join(tmpdir(), `${prefix}-${Date.now()}.md`);

  const header = instructions
    .split('\n')
    .map((l) => `# ${l}`)
    .join('\n');
  writeFileSync(tmpFile, `${header}\n\n${initialContent}`, 'utf-8');

  try {
    const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
    if (result.error) throw result.error;

    const raw = readFileSync(tmpFile, 'utf-8');
    const content = raw
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim();

    return content || undefined;
  } finally {
    try {
      rmSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Opens $EDITOR with the given file path. Returns true if the file changed.
 */
export function openEditor(filePath: string): boolean {
  const editor = resolveEditor();
  const before = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const result = spawnSync(editor, [filePath], { stdio: 'inherit' });
  if (result.error) throw result.error;
  const after = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  return before !== after;
}
