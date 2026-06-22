/**
 * MCP server definition and tool registration.
 * Registers all 5 memory tools with their input schemas from the design spec.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryEngine } from './engine.js';
import { FORMAT_MODES } from './retrieval/formatting.js';
import { handleStore } from './tools/store.js';
import { handleIngest } from './tools/ingest.js';
import { handleRecall } from './tools/recall.js';
import { handleContext } from './tools/context.js';
import { handleForget } from './tools/forget.js';
import { handleInspect } from './tools/inspect.js';
import { TOOL_DESCRIPTIONS } from './prompts.js';

export function createServer(engine: MemoryEngine): McpServer {
  const server = new McpServer({
    name: 'memory',
    version: '0.1.0',
  });

  registerTools(server, engine);

  return server;
}

// TODO: Migrate from deprecated `server.tool()` to `server.registerTool()` when
// the new API stabilizes. The registerTool API uses a different config shape.
/* eslint-disable @typescript-eslint/no-deprecated */
function registerTools(server: McpServer, engine: MemoryEngine): void {
  server.tool(
    'memory_store',
    TOOL_DESCRIPTIONS.memory_store,
    {
      content: z
        .string()
        .describe('The memory content. Should be a single fact, observation, decision, or preference.'),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags for filtering (e.g., 'preference', 'project:foo', 'person:alice')."),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Importance 0-1. Higher values resist decay. Default: 0.5.'),
    },
    async (args) => {
      try {
        const text = await handleStore(engine, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'memory_ingest',
    TOOL_DESCRIPTIONS.memory_ingest,
    {
      content: z.string().describe('Raw blob to decompose: a conversation transcript, document, or session summary.'),
      source: z
        .string()
        .optional()
        .describe("Provenance, e.g. 'session:abc', 'document', 'conversation'. Stored on each fact."),
      mode: z
        .enum(['conversation', 'document'])
        .optional()
        .describe(
          "'conversation' (default): STRICT — only DURABLE facts explicitly stated, no inference. " +
            "'document': broader — DURABLE facts with reasonable inference allowed. " +
            'Both modes keep stable preferences/identity/project facts/decisions and skip ' +
            'ephemeral task chatter. Use document for conversation transcripts.',
        ),
      tags: z.array(z.string()).optional().describe('Optional seed tags applied to EVERY extracted fact.'),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'SEED importance 0-1, used as the fallback when the extraction model does not emit a ' +
            'per-fact importance. Default: 0.5. Per-fact importance (when the model provides it) wins.',
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe('If true, run extraction and RETURN the facts WITHOUT writing anything. Default: false.'),
      on_extraction_failure: z
        .enum(['degrade', 'skip', 'error'])
        .optional()
        .describe(
          'How to handle a chunk/call that yields no facts (no LLM, LLM error, or unparseable). ' +
            "'degrade' (default): store the blob as a single memory (product behavior). " +
            "'skip': write nothing, return ingested 0. 'error': throw, so a bulk driver can retry.",
        ),
      as_of: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Backdate: stamp created_at/last_accessed_at of every extracted fact to this time ' +
            '(epoch ms or ISO 8601) instead of now. For ingesting historical exports.',
        ),
    },
    async (args) => {
      try {
        const text = await handleIngest(engine, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'memory_recall',
    TOOL_DESCRIPTIONS.memory_recall,
    {
      query: z.string().describe('Natural language query describing what you want to remember.'),
      token_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum approximate tokens in the response. Default: 500.'),
      tags: z.array(z.string()).optional().describe('Only search memories with ALL of these tags.'),
      format: z
        .enum(FORMAT_MODES)
        .optional()
        .describe(
          "'summary': compressed narrative (default). 'list': bullet points. 'raw': full JSON objects. 'answer': directly answer the query from memories (requires LLM, falls back to list).",
        ),
    },
    async (args) => {
      try {
        const text = await handleRecall(engine, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'memory_context',
    TOOL_DESCRIPTIONS.memory_context,
    {
      task: z
        .string()
        .optional()
        .describe(
          'Brief description of the current task or session purpose. Helps retrieve the most relevant memories.',
        ),
      token_budget: z.number().int().positive().optional().describe('Maximum tokens for the briefing. Default: 800.'),
    },
    async (args) => {
      try {
        const text = await handleContext(engine, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'memory_forget',
    TOOL_DESCRIPTIONS.memory_forget,
    {
      ids: z.array(z.string()).optional().describe('Specific memory IDs to forget.'),
      tags: z.array(z.string()).optional().describe('Forget all memories with ALL of these tags.'),
      query: z
        .string()
        .optional()
        .describe('Forget memories matching this query (top-10 matches, requires confirm=true).'),
      before: z.string().optional().describe('Forget memories created before this ISO 8601 timestamp.'),
      confirm: z.boolean().optional().describe('Must be true for query-based or bulk deletion. Default: false.'),
      dry_run: z
        .boolean()
        .optional()
        .describe('If true, return what would be forgotten without actually deleting. Default: false.'),
    },
    async (args) => {
      try {
        const text = await handleForget(engine, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'memory_inspect',
    TOOL_DESCRIPTIONS.memory_inspect,
    {
      view: z
        .enum(['stats', 'recent', 'important', 'tags', 'export'])
        .optional()
        .describe(
          "'stats': namespace statistics. 'recent': last N stored. 'important': highest importance. 'tags': tag frequency. 'export': JSONL export.",
        ),
      ids: z.array(z.string()).optional().describe('Inspect specific memories by ID.'),
      limit: z.number().int().positive().optional().describe('Max items for recent/important/tags views. Default: 20.'),
    },
    async (args) => {
      try {
        const text = await handleInspect(engine, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );
}

/* eslint-enable @typescript-eslint/no-deprecated */

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return 'An unexpected error occurred';
}
