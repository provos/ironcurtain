import { generateText, tool, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Sandbox } from '../sandbox/index.js';
import { buildSystemPrompt } from './prompts.js';
import * as logger from '../logger.js';

const MAX_AGENT_STEPS = 10;

/**
 * Runs the agent for a single task. This is the legacy single-shot entry point.
 *
 * @deprecated Use {@link createSession} from `src/session/index.ts` instead.
 * Sessions provide multi-turn conversation, per-session isolation, and
 * escalation routing. This function is retained for backward compatibility
 * with integration tests but should not be used in new code.
 */
export async function runAgent(
  task: string,
  sandbox: Sandbox,
): Promise<string> {
  const toolInterfaces = sandbox.getToolInterfaces();

  const tools = {
    execute_code: tool({
      description:
        'Execute TypeScript code in a secure sandbox with access to filesystem tools. ' +
        'Write code that calls tool functions like filesystem.filesystem_read_file({ path }), ' +
        'filesystem.filesystem_list_directory({ path }), etc. ' +
        'Tools are synchronous — no await needed. Use return to provide results. ' +
        'Call __getToolInterface(\'tool.name\') to discover the full type signature of any tool.',
      inputSchema: z.object({
        code: z.string().describe('TypeScript code to execute in the sandbox'),
      }),
      execute: async ({ code }) => {
        logger.info(`[sandbox] Executing code (${code.length} chars)`);
        try {
          const { result, logs } = await sandbox.executeCode(code);
          const output: Record<string, unknown> = {};
          if (logs.length > 0) {
            output.console = logs;
          }
          output.result = result;
          return output;
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
  };

  logger.info(`Agent starting with Code Mode sandbox`);
  logger.info(`Task: ${task}`);

  const result = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    system: buildSystemPrompt(toolInterfaces),
    prompt: task,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    onStepFinish({ text, toolCalls }) {
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.toolName === 'execute_code' && 'input' in tc) {
            const input = tc.input as { code: string };
            const preview = input.code.substring(0, 120).replace(/\n/g, '\\n');
            logger.info(`Tool: execute_code("${preview}${input.code.length > 120 ? '...' : ''}")`);
          }
        }
      }
      if (text) {
        logger.info(`Agent: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
      }
    },
  });

  return result.text;
}
