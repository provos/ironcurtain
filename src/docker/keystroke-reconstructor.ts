/**
 * Keystroke buffer and LLM-based reconstruction for PTY mode.
 *
 * In PTY mode, the user types directly into Claude Code's terminal.
 * The trusted process never sees the conversation, so user-context.json
 * (used by the auto-approver) is never updated after the initial task.
 *
 * This module captures raw host->container keystrokes in a rolling
 * buffer and reconstructs the user's most recent message on demand
 * using a cheap LLM. Reconstruction is lazy -- it only happens when
 * an escalation triggers auto-approval.
 *
 * Security note: the keystroke stream is trusted data captured on the
 * host before it enters the untrusted container.
 */

import { resolve } from 'node:path';
import { generateText } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import * as logger from '../logger.js';

/** Maximum buffer size in bytes (~32KB). Older data is discarded. */
const MAX_BUFFER_SIZE = 32 * 1024;

/** Default model for keystroke reconstruction (cheap and fast). */
export const DEFAULT_RECONSTRUCT_MODEL_ID = 'anthropic:claude-haiku-4-5';

const RECONSTRUCT_PROMPT = `The following is a raw byte stream of keystrokes typed by a user into a terminal running an AI coding assistant. The stream contains the user's typed text interspersed with terminal control characters (backspace, escape sequences, arrow keys, etc.).

Reconstruct the user's most recent message or instruction. Focus on the last coherent message the user typed -- ignore earlier messages, control characters, escape sequences, and terminal noise. If the user used backspace to correct text, apply those corrections.

Return ONLY the reconstructed text, nothing else. If you cannot determine any meaningful user input, return an empty string.

Raw keystroke bytes (hex-encoded):
`;

/**
 * Rolling buffer that captures raw keystrokes from the PTY proxy.
 * Thread-safe for single-threaded Node.js (no concurrent writes).
 */
export class KeystrokeBuffer {
  private chunks: Buffer[] = [];
  private totalSize = 0;

  /** Appends raw input data to the buffer. */
  append(data: Buffer): void {
    this.chunks.push(data);
    this.totalSize += data.length;

    // Trim from the front when over capacity
    while (this.totalSize > MAX_BUFFER_SIZE && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.totalSize -= removed.length;
    }

    // If a single chunk exceeds the limit, truncate it
    if (this.totalSize > MAX_BUFFER_SIZE && this.chunks.length === 1) {
      const chunk = this.chunks[0];
      const excess = this.totalSize - MAX_BUFFER_SIZE;
      this.chunks[0] = chunk.subarray(excess);
      this.totalSize = this.chunks[0].length;
    }
  }

  /** Returns the current buffer contents as a single Buffer. */
  getContents(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Returns the current buffer size in bytes. */
  get size(): number {
    return this.totalSize;
  }

  /** Clears the buffer. */
  clear(): void {
    this.chunks = [];
    this.totalSize = 0;
  }
}

/**
 * Reconstructs the user's most recent message from raw keystroke data
 * using a cheap LLM.
 *
 * @param buffer - The raw keystroke buffer contents
 * @param model - The language model to use for reconstruction
 * @returns The reconstructed user message, or empty string on failure
 */
export async function reconstructUserInput(buffer: Buffer, model: LanguageModelV3): Promise<string> {
  if (buffer.length === 0) return '';

  // Encode as hex for the LLM (readable, unambiguous for binary data)
  const hexEncoded = buffer.toString('hex');

  try {
    const result = await generateText({
      model,
      prompt: RECONSTRUCT_PROMPT + hexEncoded,
      maxOutputTokens: 1024,
    });
    return result.text.trim();
  } catch (error) {
    logger.warn(`Keystroke reconstruction failed: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * Writes reconstructed user context to the escalation directory.
 * Uses the same format as DockerAgentSession.writeUserContext().
 */
export function writeUserContext(escalationDir: string, userMessage: string): void {
  try {
    const contextPath = resolve(escalationDir, 'user-context.json');
    atomicWriteJsonSync(contextPath, { userMessage });
  } catch {
    // Ignore write failures -- fail-open to human escalation
  }
}
