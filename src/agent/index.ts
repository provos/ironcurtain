import { generateText, tool, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import type { Sandbox } from '../sandbox/index.js';

const MAX_AGENT_STEPS = 10;

function buildSystemPrompt(codeModePrompt: string, toolInterfaces: string): string {
  return `You are a helpful assistant. You complete tasks by writing TypeScript code that executes in a secure sandbox.

Every tool call in your code goes through a security policy engine. Calls may be ALLOWED, DENIED, or require ESCALATION (human approval). If a call is denied, do NOT retry it — explain the denial to the user.

${codeModePrompt}

## Currently available tool interfaces

${toolInterfaces}
`;
}

export async function runAgent(
  task: string,
  sandbox: Sandbox,
): Promise<string> {
  const toolInterfaces = sandbox.getToolInterfaces();
  const codeModePrompt = CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE;

  const tools = {
    execute_code: tool({
      description:
        'Execute TypeScript code in a secure sandbox with access to filesystem tools. ' +
        'Write code that calls tool functions like filesystem.read_file(), filesystem.list_directory(), etc. ' +
        'Tools are synchronous — no await needed. Use return to provide results.',
      inputSchema: z.object({
        code: z.string().describe('TypeScript code to execute in the sandbox'),
      }),
      execute: async ({ code }) => {
        console.error(`  [sandbox] Executing code (${code.length} chars)`);
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

  console.error(`Agent starting with Code Mode sandbox`);
  console.error(`Task: ${task}\n`);

  const result = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    system: buildSystemPrompt(codeModePrompt, toolInterfaces),
    prompt: task,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    onStepFinish({ text, toolCalls }) {
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.toolName === 'execute_code' && 'input' in tc) {
            const input = tc.input as { code: string };
            const preview = input.code.substring(0, 120).replace(/\n/g, '\\n');
            console.error(`  Tool: execute_code("${preview}${input.code.length > 120 ? '...' : ''}")`);
          }
        }
      }
      if (text) {
        console.error(`  Agent: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
      }
    },
  });

  return result.text;
}
