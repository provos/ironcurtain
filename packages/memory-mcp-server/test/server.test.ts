import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MemoryEngine } from '../src/engine.js';
import { createServer } from '../src/server.js';

function createMockEngine(): MemoryEngine {
  return {
    store: vi.fn().mockResolvedValue({ id: 'test-id', action: 'created' }),
    recall: vi.fn().mockResolvedValue({
      content: 'test recall',
      memories_used: 1,
      total_matches: 1,
    }),
    context: vi.fn().mockResolvedValue('## Briefing\nSome context'),
    forget: vi.fn().mockResolvedValue({ forgotten: 1 }),
    inspect: vi.fn().mockResolvedValue({
      total_memories: 10,
      active_memories: 8,
      decayed_memories: 1,
      compacted_memories: 1,
      oldest_memory: null,
      newest_memory: null,
      storage_bytes: 4096,
      top_tags: [],
    }),
    close: vi.fn(),
  };
}

async function createConnectedClient(engine: MemoryEngine) {
  const server = createServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server };
}

describe('MCP server', () => {
  it('lists all 5 memory tools', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();

    expect(toolNames).toEqual(['memory_context', 'memory_forget', 'memory_inspect', 'memory_recall', 'memory_store']);
  });

  it('memory_store tool has correct schema', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const storeTool = tools.find((t) => t.name === 'memory_store');

    expect(storeTool).toBeDefined();
    expect(storeTool!.description).toContain('Store a memory');
    expect(storeTool!.inputSchema.required).toContain('content');
  });

  it('memory_recall tool has correct schema', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const recallTool = tools.find((t) => t.name === 'memory_recall');

    expect(recallTool).toBeDefined();
    expect(recallTool!.description).toContain('Recall memories');
    expect(recallTool!.inputSchema.required).toContain('query');
  });

  it('memory_context tool has no required params', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const contextTool = tools.find((t) => t.name === 'memory_context');

    expect(contextTool).toBeDefined();
    expect(contextTool!.description).toContain('briefing');
    // All params are optional
    expect(contextTool!.inputSchema.required ?? []).toEqual([]);
  });

  it('calls engine.store via memory_store tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { content: 'User prefers dark mode', tags: ['preference'] },
    });

    expect(engine.store).toHaveBeenCalledWith('User prefers dark mode', {
      tags: ['preference'],
      importance: undefined,
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Stored memory test-id' }]);
  });

  it('calls engine.recall via memory_recall tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'testing preferences' },
    });

    expect(engine.recall).toHaveBeenCalledWith({
      query: 'testing preferences',
      token_budget: undefined,
      tags: undefined,
      format: undefined,
    });
    expect(result.content).toEqual([{ type: 'text', text: 'test recall' }]);
  });

  it('calls engine.context via memory_context tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_context',
      arguments: { task: 'Fix auth bug' },
    });

    expect(engine.context).toHaveBeenCalledWith({
      task: 'Fix auth bug',
      token_budget: undefined,
    });
    expect(result.content).toEqual([{ type: 'text', text: '## Briefing\nSome context' }]);
  });

  it('calls engine.forget via memory_forget tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_forget',
      arguments: { ids: ['abc'] },
    });

    expect(engine.forget).toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: 'Forgot 1 memories.' }]);
  });

  it('calls engine.inspect via memory_inspect tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_inspect',
      arguments: { view: 'stats' },
    });

    expect(engine.inspect).toHaveBeenCalledWith({
      view: 'stats',
      ids: undefined,
      limit: undefined,
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Memory Statistics');
  });

  it('returns error for engine failures without crashing', async () => {
    const engine = createMockEngine();
    (engine.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection failed'));

    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { content: 'test' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: DB connection failed' }]);
  });
});
