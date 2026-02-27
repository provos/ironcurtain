/**
 * LLM integration test for progressive tool discovery.
 *
 * Gated by the LLM_INTEGRATION_TEST env var. Creates a real session with
 * claude-haiku-4-5, seeds the sandbox, and verifies the agent discovers
 * and uses tools via help.help().
 */
import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../src/session/index.js';
import { loadConfig } from '../src/config/index.js';
import { getSessionSandboxDir, getSessionDir } from '../src/config/paths.js';
import type { DiagnosticEvent, Session } from '../src/session/types.js';
import * as logger from '../src/logger.js';

describe.skipIf(!process.env.LLM_INTEGRATION_TEST)('Help system LLM integration', () => {
  let session: Session | null = null;

  afterAll(async () => {
    if (session) {
      const sessionDir = getSessionDir(session.getInfo().id);
      await session.close();
      session = null;
      logger.teardown();

      // Copy LLM interaction log to logs/ for inspection
      const __dir = dirname(fileURLToPath(import.meta.url));
      const logsDir = resolve(__dir, '..', 'logs');
      mkdirSync(logsDir, { recursive: true });
      const llmLogSrc = resolve(sessionDir, 'llm-interactions.jsonl');
      try {
        copyFileSync(llmLogSrc, resolve(logsDir, 'help-llm-integration.jsonl'));
      } catch {
        // log may not exist if test failed before any LLM calls
      }

      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('agent discovers tools via help.help() and uses them to list files', async () => {
    const baseConfig = loadConfig();
    const config = {
      ...baseConfig,
      agentModelId: 'anthropic:claude-haiku-4-5',
    };

    const diagnostics: DiagnosticEvent[] = [];

    session = await createSession({
      config,
      onDiagnostic: (event) => diagnostics.push(event),
    });

    // Seed sandbox with a test file
    const sandboxDir = getSessionSandboxDir(session.getInfo().id);
    writeFileSync(`${sandboxDir}/discovery-test.txt`, 'Tool discovery works!');

    const response = await session.sendMessage(
      'List the files in the sandbox directory. Return the list of filenames.',
    );

    // Agent should produce a meaningful response
    expect(response).toBeTruthy();
    expect(response.length).toBeGreaterThan(0);

    // The agent should have made at least one tool call
    const toolCalls = diagnostics.filter((e) => e.kind === 'tool_call');
    expect(toolCalls.length).toBeGreaterThan(0);

    // Report token usage
    const history = session.getHistory();
    let totalPrompt = 0;
    let totalCompletion = 0;
    for (const turn of history) {
      totalPrompt += turn.usage.promptTokens;
      totalCompletion += turn.usage.completionTokens;
    }
    console.log(
      `\n  Token usage: ${totalPrompt} prompt + ${totalCompletion} completion = ${totalPrompt + totalCompletion} total`,
    );
  }, 60_000);
});
