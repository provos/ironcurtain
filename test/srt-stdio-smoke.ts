/**
 * Smoke test: validate that `srt -s <settings> -c <cmd>` passes stdio
 * through correctly for MCP JSON-RPC communication.
 *
 * This is the critical assumption behind the per-server srt process design.
 * If srt breaks stdio passthrough, MCP communication fails.
 *
 * Run with: npx tsx test/srt-stdio-smoke.ts
 *
 * Requires: bubblewrap, socat (Linux)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const SRT_BIN = resolve('node_modules/.bin/srt');
const SANDBOX_DIR = join(tmpdir(), 'srt-smoke-test');

/**
 * Find the @modelcontextprotocol/server-filesystem binary.
 * npx -y won't work inside a no-network sandbox, so we need the local path.
 */
function findServerFilesystem(): string {
  // Check npx cache
  const npxCache = join(homedir(), '.npm', '_npx');
  if (existsSync(npxCache)) {
    for (const dir of readdirSync(npxCache)) {
      const candidate = join(npxCache, dir, 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js');
      if (existsSync(candidate)) return candidate;
    }
  }
  // Check local node_modules
  const local = resolve('node_modules/@modelcontextprotocol/server-filesystem/dist/index.js');
  if (existsSync(local)) return local;

  throw new Error(
    'Cannot find @modelcontextprotocol/server-filesystem. ' +
    'Run `node ${SERVER_FS_PATH} /tmp` once to cache it.'
  );
}

const SERVER_FS_PATH = findServerFilesystem();

// ── Helpers ──────────────────────────────────────────────────────────────

function createSettingsFile(dir: string, name: string, config: object): string {
  const path = join(dir, `${name}.srt-settings.json`);
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function log(label: string, msg: string) {
  console.log(`  [${label}] ${msg}`);
}

// ── Test 1: Basic MCP roundtrip through srt ──────────────────────────────

async function testMcpRoundtrip() {
  console.log('\n═══ Test 1: MCP JSON-RPC roundtrip through srt ═══\n');

  // Create sandbox dir and settings
  const settingsDir = join(tmpdir(), `srt-smoke-settings-${Date.now()}`);
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

  const settingsPath = createSettingsFile(settingsDir, 'filesystem', {
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [SANDBOX_DIR],
      denyWrite: [],
    },
  });

  log('setup', `Settings: ${settingsPath}`);
  log('setup', `Sandbox dir: ${SANDBOX_DIR}`);

  // The command to wrap: filesystem MCP server serving the sandbox dir
  const innerCmd = `node ${SERVER_FS_PATH} ${SANDBOX_DIR}`;

  // Spawn via srt with -c flag (pre-escaped command string)
  const transport = new StdioClientTransport({
    command: SRT_BIN,
    args: ['-s', settingsPath, '-c', innerCmd],
    env: { ...process.env as Record<string, string> },
    stderr: 'pipe',
  });

  // Capture stderr for debugging
  let stderrOutput = '';
  if (transport.stderr) {
    transport.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
  }

  const client = new Client(
    { name: 'srt-smoke-test', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    log('connect', 'Connecting to srt-wrapped MCP server...');
    await client.connect(transport);
    log('connect', 'Connected ✓');

    // List tools — verifies JSON-RPC request/response roundtrip
    log('listTools', 'Listing tools...');
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name);
    log('listTools', `Got ${toolNames.length} tools: ${toolNames.join(', ')}`);

    if (toolNames.length === 0) {
      throw new Error('No tools returned — MCP communication may be broken');
    }
    if (!toolNames.includes('list_directory')) {
      throw new Error('Expected list_directory tool not found');
    }
    log('listTools', 'PASS ✓');

    // Call a tool — verifies full roundtrip including tool execution inside sandbox
    log('callTool', `Calling list_directory({ path: "${SANDBOX_DIR}" })...`);
    const result = await client.callTool({
      name: 'list_directory',
      arguments: { path: SANDBOX_DIR },
    });
    log('callTool', `Result: ${JSON.stringify(result.content).slice(0, 200)}`);

    if (result.isError) {
      throw new Error(`Tool call returned error: ${JSON.stringify(result.content)}`);
    }
    log('callTool', 'PASS ✓');

    // Write a file inside the sandbox, then read it back
    log('writeFile', 'Writing test file inside sandbox...');
    const testContent = `smoke test ${Date.now()}`;
    const testFilePath = join(SANDBOX_DIR, 'srt-smoke-test.txt');
    const writeResult = await client.callTool({
      name: 'write_file',
      arguments: { path: testFilePath, content: testContent },
    });
    if (writeResult.isError) {
      throw new Error(`write_file failed: ${JSON.stringify(writeResult.content)}`);
    }
    log('writeFile', 'PASS ✓');

    log('readFile', 'Reading test file back...');
    const readResult = await client.callTool({
      name: 'read_file',
      arguments: { path: testFilePath },
    });
    if (readResult.isError) {
      throw new Error(`read_file failed: ${JSON.stringify(readResult.content)}`);
    }
    const readContent = (readResult.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    if (!readContent.includes(testContent)) {
      throw new Error(`Read content mismatch. Expected "${testContent}", got "${readContent}"`);
    }
    log('readFile', 'PASS ✓');

    console.log('\n  ✓ Test 1 PASSED: MCP JSON-RPC works through srt\n');
  } catch (err) {
    console.error('\n  ✗ Test 1 FAILED:', err);
    if (stderrOutput) {
      console.error('\n  srt stderr:\n', stderrOutput);
    }
    return false;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
    rmSync(settingsDir, { recursive: true, force: true });
  }

  return true;
}

// ── Test 2: Sandbox actually restricts writes ────────────────────────────

async function testSandboxBlocksWrites() {
  console.log('═══ Test 2: Sandbox blocks writes outside allowWrite ═══\n');

  const settingsDir = join(tmpdir(), `srt-smoke-settings-${Date.now()}`);
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

  // allowWrite only includes SANDBOX_DIR — writes to /tmp/outside should fail
  const settingsPath = createSettingsFile(settingsDir, 'filesystem', {
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [SANDBOX_DIR],
      denyWrite: [],
    },
  });

  // Serve /tmp so the server can "see" paths outside the sandbox
  const innerCmd = `node ${SERVER_FS_PATH} /tmp`;

  const transport = new StdioClientTransport({
    command: SRT_BIN,
    args: ['-s', settingsPath, '-c', innerCmd],
    env: { ...process.env as Record<string, string> },
    stderr: 'pipe',
  });

  let stderrOutput = '';
  if (transport.stderr) {
    transport.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
  }

  const client = new Client(
    { name: 'srt-smoke-test', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    log('connect', 'Connected ✓');

    // Try writing outside the sandbox — should be blocked
    const outsidePath = join(tmpdir(), `srt-smoke-outside-${Date.now()}.txt`);
    log('blockedWrite', `Attempting write to ${outsidePath} (should fail)...`);
    const writeResult = await client.callTool({
      name: 'write_file',
      arguments: { path: outsidePath, content: 'should not work' },
    });

    if (writeResult.isError) {
      const errorText = JSON.stringify(writeResult.content);
      log('blockedWrite', `Write blocked with error: ${errorText.slice(0, 200)}`);
      if (/EACCES|EPERM|Permission denied|Read-only/i.test(errorText)) {
        log('blockedWrite', 'PASS ✓ — sandbox correctly blocked the write');
      } else {
        log('blockedWrite', `WARN — write failed but error pattern unexpected: ${errorText}`);
      }
    } else {
      throw new Error('Write outside sandbox SUCCEEDED — sandbox is NOT working!');
    }

    // Verify writes inside the sandbox still work
    const insidePath = join(SANDBOX_DIR, `srt-smoke-inside-${Date.now()}.txt`);
    log('allowedWrite', `Writing to ${insidePath} (should succeed)...`);
    const insideResult = await client.callTool({
      name: 'write_file',
      arguments: { path: insidePath, content: 'inside sandbox' },
    });
    if (insideResult.isError) {
      throw new Error(`Write inside sandbox failed: ${JSON.stringify(insideResult.content)}`);
    }
    log('allowedWrite', 'PASS ✓');

    console.log('\n  ✓ Test 2 PASSED: Sandbox correctly restricts writes\n');
  } catch (err) {
    console.error('\n  ✗ Test 2 FAILED:', err);
    if (stderrOutput) {
      console.error('\n  srt stderr:\n', stderrOutput);
    }
    return false;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
    rmSync(settingsDir, { recursive: true, force: true });
  }

  return true;
}

// ── Test 3: Two srt processes with different network configs ─────────────

async function testPerServerNetworkIsolation() {
  console.log('═══ Test 3: Per-server network isolation via separate srt processes ═══\n');

  const settingsDir = join(tmpdir(), `srt-smoke-settings-${Date.now()}`);
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

  // Server A: no network
  const settingsA = createSettingsFile(settingsDir, 'no-network', {
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [SANDBOX_DIR],
      denyWrite: [],
    },
  });

  // Server B: allows example.com
  const settingsB = createSettingsFile(settingsDir, 'with-network', {
    network: {
      allowedDomains: ['example.com'],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [SANDBOX_DIR],
      denyWrite: [],
    },
  });

  // Both serve the same sandbox dir
  const innerCmd = `node ${SERVER_FS_PATH} ${SANDBOX_DIR}`;

  // Spawn both servers simultaneously
  const transportA = new StdioClientTransport({
    command: SRT_BIN,
    args: ['-s', settingsA, '-c', innerCmd],
    env: { ...process.env as Record<string, string> },
    stderr: 'pipe',
  });

  const transportB = new StdioClientTransport({
    command: SRT_BIN,
    args: ['-s', settingsB, '-c', innerCmd],
    env: { ...process.env as Record<string, string> },
    stderr: 'pipe',
  });

  let stderrA = '';
  let stderrB = '';
  if (transportA.stderr) {
    transportA.stderr.on('data', (chunk: Buffer) => { stderrA += chunk.toString(); });
  }
  if (transportB.stderr) {
    transportB.stderr.on('data', (chunk: Buffer) => { stderrB += chunk.toString(); });
  }

  const clientA = new Client({ name: 'srt-smoke-A', version: '0.1.0' }, { capabilities: {} });
  const clientB = new Client({ name: 'srt-smoke-B', version: '0.1.0' }, { capabilities: {} });

  try {
    log('connect', 'Connecting server A (no network)...');
    await clientA.connect(transportA);
    log('connect', 'Server A connected ✓');

    log('connect', 'Connecting server B (example.com allowed)...');
    await clientB.connect(transportB);
    log('connect', 'Server B connected ✓');

    // Both should list tools (basic MCP works)
    const toolsA = await clientA.listTools();
    const toolsB = await clientB.listTools();
    log('listTools', `Server A: ${toolsA.tools.length} tools, Server B: ${toolsB.tools.length} tools`);

    // Both should be able to list the sandbox directory
    const listA = await clientA.callTool({ name: 'list_directory', arguments: { path: SANDBOX_DIR } });
    const listB = await clientB.callTool({ name: 'list_directory', arguments: { path: SANDBOX_DIR } });

    if (listA.isError || listB.isError) {
      throw new Error('list_directory failed on one of the servers');
    }
    log('listDir', 'Both servers can list sandbox directory ✓');

    console.log('\n  ✓ Test 3 PASSED: Two srt processes coexist with independent configs\n');
    console.log('  Note: Network isolation is enforced by each srt process\'s proxy.');
    console.log('  Full network verification was done in test/sandbox-exploration.ts.');
    console.log('  This test confirms two srt processes can run simultaneously.\n');
  } catch (err) {
    console.error('\n  ✗ Test 3 FAILED:', err);
    if (stderrA) console.error('\n  Server A stderr:\n', stderrA);
    if (stderrB) console.error('\n  Server B stderr:\n', stderrB);
    return false;
  } finally {
    try { await clientA.close(); } catch { /* ignore */ }
    try { await clientB.close(); } catch { /* ignore */ }
    rmSync(settingsDir, { recursive: true, force: true });
  }

  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  srt stdio smoke test: MCP JSON-RPC through sandbox-runtime ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const results: boolean[] = [];

  results.push(await testMcpRoundtrip());
  results.push(await testSandboxBlocksWrites());
  results.push(await testPerServerNetworkIsolation());

  // Cleanup
  rmSync(SANDBOX_DIR, { recursive: true, force: true });

  console.log('═══ Summary ═══');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`  ${passed}/${total} tests passed`);

  if (passed < total) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
