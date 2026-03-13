/**
 * End-to-end integration test for the consolidation pipeline.
 *
 * Verifies that LLM-driven consolidation merges duplicates and resolves
 * contradictions when triggered by the maintenance interval.
 *
 * Requires an LLM backend: either MEMORY_LLM_* env vars in .env,
 * or a running Ollama instance at localhost:11434.
 */

import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '../..');
const SERVER_ENTRY = resolve(PACKAGE_ROOT, 'src/index.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnvFile(): Record<string, string> {
  const envPath = resolve(PACKAGE_ROOT, '.env');
  const env: Record<string, string> = {};
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
      if (match) {
        env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return env;
}

let testCounter = 0;
function uniqueDbPath(): string {
  return `/tmp/memory-e2e-consolidation-${process.pid}-${Date.now()}-${++testCounter}.db`;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

// ---------------------------------------------------------------------------
// LLM availability detection
// ---------------------------------------------------------------------------

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

async function detectLLM(): Promise<LLMConfig | null> {
  const envFile = loadEnvFile();

  // Check .env for explicit LLM config
  if (envFile.MEMORY_LLM_BASE_URL && envFile.MEMORY_LLM_API_KEY) {
    return {
      baseUrl: envFile.MEMORY_LLM_BASE_URL,
      apiKey: envFile.MEMORY_LLM_API_KEY,
      model: envFile.MEMORY_LLM_MODEL || 'claude-haiku-4-5-20251001',
    };
  }

  // Try Ollama at default endpoint
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('http://localhost:11434/v1/models', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const models = body.data ?? [];
      if (models.length > 0) {
        return {
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'ollama',
          model: models[0].id,
        };
      }
    }
  } catch {
    // Ollama not available
  }

  return null;
}

const llmConfig = await detectLLM();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!llmConfig)('Consolidation E2E', () => {
  async function createConsolidationClient(dbPath: string): Promise<Client> {
    const envFile = loadEnvFile();
    const transport = new StdioClientTransport({
      command: 'tsx',
      args: [SERVER_ENTRY],
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        ...envFile,
        MEMORY_DB_PATH: dbPath,
        MEMORY_NAMESPACE: 'consolidation-test',
        MEMORY_MAINTENANCE_INTERVAL: '5',
        MEMORY_LLM_BASE_URL: llmConfig!.baseUrl,
        MEMORY_LLM_API_KEY: llmConfig!.apiKey,
        MEMORY_LLM_MODEL: llmConfig!.model,
      },
    });

    const client = new Client({ name: 'consolidation-e2e', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  it('should merge duplicates and resolve contradictions via consolidation', async () => {
    const dbPath = uniqueDbPath();
    const client = await createConsolidationClient(dbPath);

    try {
      // Store 5 memories — maintenance triggers after the 5th store
      // Memory 1: original database fact
      await callTool(client, 'memory_store', {
        content: 'The project uses PostgreSQL 15 as its primary database',
        tags: ['tech'],
      });

      // Memory 2: near-duplicate of #1
      await callTool(client, 'memory_store', {
        content: 'PostgreSQL 15 is the main database for the project',
        tags: ['tech'],
      });

      // Memory 3: deployment schedule
      await callTool(client, 'memory_store', {
        content: 'The deployment schedule is every Tuesday at 3pm',
        tags: ['process'],
      });

      // Memory 4: contradicts #3 with updated schedule
      await callTool(client, 'memory_store', {
        content: 'Deployments now happen every Thursday at 2pm',
        tags: ['process'],
      });

      // Memory 5: distinct fact — this triggers maintenance (interval=5)
      await callTool(client, 'memory_store', {
        content: 'Alice joined the team as a frontend engineer in January 2025',
        tags: ['team'],
      });

      // Verification: consolidation runs synchronously during the 5th store call.

      // 1. Check total memory count decreased (at least one merge/supersede)
      const statsResponse = await callTool(client, 'memory_inspect', {
        view: 'stats',
      });
      // Parse total count from stats output
      const totalMatch = statsResponse.match(/total[^\d]*(\d+)/i);
      expect(totalMatch).toBeTruthy();
      const totalCount = parseInt(totalMatch![1], 10);

      // At least one consolidation should have happened (5 -> 4 or fewer)
      // but distinct memories (Alice, at least one DB, at least one deployment) survive
      expect(totalCount).toBeLessThanOrEqual(4);
      expect(totalCount).toBeGreaterThanOrEqual(3);

      // 2. The distinct memory about Alice should survive
      const aliceResponse = await callTool(client, 'memory_recall', {
        query: 'frontend engineer',
        format: 'list',
      });
      expect(aliceResponse.toLowerCase()).toContain('alice');

      // 3. Database information should still be retrievable
      const dbResponse = await callTool(client, 'memory_recall', {
        query: 'database',
        format: 'list',
      });
      expect(dbResponse.toLowerCase()).toContain('postgresql');

      // 4. Deployment information should still be retrievable
      const deployResponse = await callTool(client, 'memory_recall', {
        query: 'deployment schedule',
        format: 'list',
      });
      const deployLower = deployResponse.toLowerCase();
      expect(deployLower.includes('tuesday') || deployLower.includes('thursday')).toBe(true);
    } finally {
      await client.close().catch(() => {});
      cleanupDb(dbPath);
    }
  });
});

vi.setConfig({ testTimeout: 120_000 });
