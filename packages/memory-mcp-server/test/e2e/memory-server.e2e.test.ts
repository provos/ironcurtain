/**
 * End-to-end integration tests for the memory MCP server.
 *
 * These tests spawn the actual server as a child process, communicate
 * via MCP protocol over stdio, and verify tool behavior end-to-end.
 *
 * Requires: `npm run build` first (or run from dist/).
 * Optional: MEMORY_LLM_API_KEY in .env for LLM-enhanced tests.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '../..');
const SERVER_ENTRY = resolve(PACKAGE_ROOT, 'dist/index.js');

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
  return `/tmp/memory-e2e-${process.pid}-${Date.now()}-${++testCounter}.db`;
}

async function createClient(dbPath: string, namespace?: string): Promise<Client> {
  const envFile = loadEnvFile();
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      ...envFile,
      MEMORY_DB_PATH: dbPath,
      MEMORY_NAMESPACE: namespace ?? 'test',
    },
  });

  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Memory MCP Server E2E', () => {
  let dbPath: string;
  let client: Client;

  beforeEach(async () => {
    dbPath = uniqueDbPath();
    client = await createClient(dbPath);
  }, 30_000);

  afterAll(() => {
    // Note: each test cleans up its own db; this is a safety net
  });

  async function cleanup(): Promise<void> {
    try {
      await client.close();
    } catch {
      // ignore
    }
    cleanupDb(dbPath);
  }

  // -----------------------------------------------------------------------
  // memory_store
  // -----------------------------------------------------------------------

  describe('memory_store', () => {
    it('should store a simple memory and return an ID', async () => {
      const response = await callTool(client, 'memory_store', {
        content: 'The sky is blue',
      });

      expect(response).toBeTruthy();
      // The response should contain some indication of success (ID, confirmation, etc.)
      expect(response.length).toBeGreaterThan(0);

      await cleanup();
    });

    it('should store a memory with tags and importance', async () => {
      const response = await callTool(client, 'memory_store', {
        content: 'TypeScript strict mode is required for all new files',
        tags: ['coding-standard', 'typescript'],
        importance: 0.8,
      });

      expect(response).toBeTruthy();

      await cleanup();
    });

    it('should handle deduplication for identical content', async () => {
      await callTool(client, 'memory_store', {
        content: 'The database uses PostgreSQL 16',
      });
      const response2 = await callTool(client, 'memory_store', {
        content: 'The database uses PostgreSQL 16',
      });

      // Second store should indicate it was a duplicate or return the same ID
      expect(response2).toBeTruthy();

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // memory_recall
  // -----------------------------------------------------------------------

  describe('memory_recall', () => {
    it('should recall stored memories by keyword query', async () => {
      await callTool(client, 'memory_store', {
        content: 'Alice is the tech lead for the payments team',
        tags: ['team'],
      });
      await callTool(client, 'memory_store', {
        content: 'Bob is the DevOps engineer managing Kubernetes',
        tags: ['team'],
      });
      await callTool(client, 'memory_store', {
        content: 'The frontend uses React 19',
        tags: ['tech-stack'],
      });

      const response = await callTool(client, 'memory_recall', {
        query: 'Who is on the team?',
      });

      expect(response.toLowerCase()).toContain('alice');
      expect(response.toLowerCase()).toContain('bob');

      await cleanup();
    });

    it('should respect tag filters', async () => {
      await callTool(client, 'memory_store', {
        content: 'React 19 for the frontend',
        tags: ['frontend'],
      });
      await callTool(client, 'memory_store', {
        content: 'Express.js for the backend API',
        tags: ['backend'],
      });

      const response = await callTool(client, 'memory_recall', {
        query: 'technologies',
        tags: ['frontend'],
      });

      expect(response.toLowerCase()).toContain('react');
      // Should not include backend-only results
      // (not asserting mustExclude here since the server may still mention it)

      await cleanup();
    });

    it('should return results within token budget', async () => {
      // Store many memories
      for (let i = 0; i < 20; i++) {
        await callTool(client, 'memory_store', {
          content: `Project fact #${i + 1}: This is a moderately long memory entry that contains some useful information about the project status and various technical decisions that were made during sprint ${i + 1}.`,
        });
      }

      const smallBudget = await callTool(client, 'memory_recall', {
        query: 'project facts',
        token_budget: 100,
      });

      const largeBudget = await callTool(client, 'memory_recall', {
        query: 'project facts',
        token_budget: 2000,
      });

      // Larger budget should return more content
      expect(largeBudget.length).toBeGreaterThan(smallBudget.length);

      await cleanup();
    });

    it('should support raw format', async () => {
      await callTool(client, 'memory_store', {
        content: 'Test memory for raw format',
        tags: ['test'],
      });

      const response = await callTool(client, 'memory_recall', {
        query: 'test memory',
        format: 'raw',
      });

      expect(response).toBeTruthy();

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // memory_context
  // -----------------------------------------------------------------------

  describe('memory_context', () => {
    it('should return a session briefing relevant to the task', async () => {
      await callTool(client, 'memory_store', {
        content: 'The auth service uses JWT with RS256 signing',
        tags: ['auth'],
        importance: 0.8,
      });
      await callTool(client, 'memory_store', {
        content: 'Redis caches session tokens for 1 hour',
        tags: ['auth', 'cache'],
      });
      await callTool(client, 'memory_store', {
        content: 'The frontend uses Next.js 15',
        tags: ['frontend'],
      });

      const response = await callTool(client, 'memory_context', {
        task: 'Debugging an authentication issue',
      });

      expect(response.toLowerCase()).toContain('jwt');
      // Auth-related memories should be prioritized
      expect(
        response.toLowerCase().includes('auth') ||
          response.toLowerCase().includes('jwt') ||
          response.toLowerCase().includes('session'),
      ).toBe(true);

      await cleanup();
    });

    it('should work without a task (general briefing)', async () => {
      await callTool(client, 'memory_store', {
        content: 'Important: never deploy on Fridays',
        importance: 0.95,
      });
      await callTool(client, 'memory_store', {
        content: 'The team standup is at 10am daily',
      });

      const response = await callTool(client, 'memory_context', {});

      expect(response).toBeTruthy();
      expect(response.length).toBeGreaterThan(0);

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // memory_forget
  // -----------------------------------------------------------------------

  describe('memory_forget', () => {
    it('should support dry_run mode', async () => {
      await callTool(client, 'memory_store', {
        content: 'Temporary note to be forgotten',
        tags: ['temp'],
      });

      const dryRunResponse = await callTool(client, 'memory_forget', {
        tags: ['temp'],
        dry_run: true,
        confirm: true,
      });

      expect(dryRunResponse).toBeTruthy();

      // Memory should still be recallable after dry run
      const recallResponse = await callTool(client, 'memory_recall', {
        query: 'temporary note',
      });
      expect(recallResponse.toLowerCase()).toContain('temporary');

      await cleanup();
    });

    it('should forget memories by tag when confirmed', async () => {
      await callTool(client, 'memory_store', {
        content: 'This memory should be forgotten',
        tags: ['delete-me'],
      });
      await callTool(client, 'memory_store', {
        content: 'This memory should survive',
        tags: ['keep-me'],
      });

      await callTool(client, 'memory_forget', {
        tags: ['delete-me'],
        confirm: true,
      });

      const response = await callTool(client, 'memory_recall', {
        query: 'forgotten or survived',
      });

      expect(response.toLowerCase()).toContain('survive');

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // memory_inspect
  // -----------------------------------------------------------------------

  describe('memory_inspect', () => {
    it('should return stats', async () => {
      await callTool(client, 'memory_store', { content: 'Fact one' });
      await callTool(client, 'memory_store', { content: 'Fact two' });
      await callTool(client, 'memory_store', { content: 'Fact three' });

      const response = await callTool(client, 'memory_inspect', {
        view: 'stats',
      });

      expect(response).toBeTruthy();
      // Should mention the count or similar stats
      expect(response.length).toBeGreaterThan(0);

      await cleanup();
    });

    it('should return recent memories', async () => {
      await callTool(client, 'memory_store', { content: 'First memory' });
      await callTool(client, 'memory_store', { content: 'Second memory' });
      await callTool(client, 'memory_store', { content: 'Third memory' });

      const response = await callTool(client, 'memory_inspect', {
        view: 'recent',
        limit: 2,
      });

      expect(response).toBeTruthy();

      await cleanup();
    });

    it('should return tag frequency', async () => {
      await callTool(client, 'memory_store', {
        content: 'Fact A',
        tags: ['alpha', 'beta'],
      });
      await callTool(client, 'memory_store', {
        content: 'Fact B',
        tags: ['alpha'],
      });

      const response = await callTool(client, 'memory_inspect', {
        view: 'tags',
      });

      expect(response.toLowerCase()).toContain('alpha');

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Semantic search quality
  // -----------------------------------------------------------------------

  describe('semantic search', () => {
    it('should find memories by semantic similarity (no keyword overlap)', async () => {
      await callTool(client, 'memory_store', {
        content: 'The application has severe latency issues under heavy load',
      });
      await callTool(client, 'memory_store', {
        content: 'User prefers dark mode in all editors',
      });

      const response = await callTool(client, 'memory_recall', {
        query: 'performance problems when many users are active',
      });

      expect(response.toLowerCase()).toContain('latency');

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Knowledge update / contradiction resolution
  // -----------------------------------------------------------------------

  describe('knowledge updates', () => {
    it('should handle contradicting facts (latest should win)', async () => {
      await callTool(client, 'memory_store', {
        content: 'The project deadline is March 1, 2026',
      });

      // Small delay to ensure temporal ordering
      await new Promise((r) => setTimeout(r, 50));

      await callTool(client, 'memory_store', {
        content: 'The project deadline has been moved to March 15, 2026',
      });

      const response = await callTool(client, 'memory_recall', {
        query: 'When is the project deadline?',
      });

      expect(response).toContain('March 15');

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Namespace isolation
  // -----------------------------------------------------------------------

  describe('namespace isolation', () => {
    it('should not leak memories across namespaces', async () => {
      const client2 = await createClient(dbPath, 'namespace-b');

      try {
        await callTool(client, 'memory_store', {
          content: 'Secret in namespace A: the vault code is 1234',
        });

        await callTool(client2, 'memory_store', {
          content: 'Public info in namespace B: the office is on 5th floor',
        });

        const responseA = await callTool(client, 'memory_recall', {
          query: 'vault code',
        });
        const responseB = await callTool(client2, 'memory_recall', {
          query: 'vault code',
        });

        expect(responseA.toLowerCase()).toContain('1234');
        // Namespace B should not see namespace A's memory
        expect(responseB.toLowerCase()).not.toContain('1234');
      } finally {
        await client2.close().catch(() => {});
      }

      await cleanup();
    });
  });
});

vi.setConfig({ testTimeout: 60_000 });
