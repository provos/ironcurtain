/**
 * Exploration test: validate sandbox-runtime capabilities.
 *
 * Run with: npx tsx test/sandbox-exploration.ts
 *
 * Tests two things:
 * 1. Basic sandbox containment (filesystem + no-network) — uses low-level API if socat missing
 * 2. Per-command network isolation via customConfig — requires socat
 *
 * Key finding: SandboxManager.initialize() checks ALL dependencies upfront (including
 * socat) even when no network features are used. For filesystem-only sandboxing on
 * Linux without socat, we must use the lower-level wrapCommandWithSandboxLinux() directly.
 */
import { SandboxManager, getDefaultWritePaths } from '@anthropic-ai/sandbox-runtime';
// Low-level Linux API for filesystem-only sandboxing without socat
import { wrapCommandWithSandboxLinux, checkLinuxDependencies } from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';

const SANDBOX_DIR = '/tmp/sandbox-test';

function hasSocat(): boolean {
  try {
    execSync('which socat', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function ensureSandboxDir() {
  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  }
}

// ── Test 1: No-network sandbox (filesystem containment only) ────────────
// Uses low-level API to avoid socat dependency check.
async function testNoNetworkSandbox() {
  console.log('═══ Test 1: No-Network Sandbox (exec use case) ═══\n');

  const deps = checkLinuxDependencies();
  console.log('Linux dependency check:', JSON.stringify(deps));
  if (!hasSocat()) {
    console.log('socat not installed — using low-level wrapCommandWithSandboxLinux() directly');
    console.log('(SandboxManager.initialize() requires socat even for no-network sandboxing)\n');
  }

  // If socat is available, test via SandboxManager. Otherwise, use low-level API.
  const useLowLevel = !hasSocat();

  async function wrapCommand(cmd: string, overrides?: {
    denyRead?: string[];
    allowWrite?: string[];
  }): Promise<string> {
    const allowWrite = overrides?.allowWrite ?? [SANDBOX_DIR, ...getDefaultWritePaths()];
    const denyRead = overrides?.denyRead ?? [];

    if (useLowLevel) {
      return wrapCommandWithSandboxLinux({
        command: cmd,
        needsNetworkRestriction: true, // use --unshare-net for no-network
        // No socket paths = --unshare-net but no proxy bridge = total network block
        readConfig: { denyOnly: denyRead },
        writeConfig: { allowOnly: allowWrite, denyWithinAllow: [] },
      });
    } else {
      return SandboxManager.wrapWithSandbox(cmd, undefined, {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead, allowWrite, denyWrite: [] },
      });
    }
  }

  if (!useLowLevel) {
    const config = {
      network: { allowedDomains: [] as string[], deniedDomains: [] as string[] },
      filesystem: {
        denyRead: [] as string[],
        allowWrite: [SANDBOX_DIR, ...getDefaultWritePaths()],
        denyWrite: [] as string[],
      },
    };
    await SandboxManager.initialize(config);
    console.log('Initialized via SandboxManager. Proxy port:', SandboxManager.getProxyPort());
  }

  // 1a. Basic command execution works
  console.log('\n--- 1a: Basic echo through sandbox ---');
  const echoCmd = await wrapCommand('echo "hello from sandbox"');
  console.log('Wrapped command (first 300 chars):\n', echoCmd.substring(0, 300), '\n');
  try {
    const output = execSync(echoCmd, { encoding: 'utf-8', timeout: 10000, env: process.env });
    console.log('PASS: echo output:', output.trim());
  } catch (err: any) {
    console.log('FAIL: echo failed:', err.message.substring(0, 200));
    if (err.stderr) console.log('stderr:', err.stderr.toString().substring(0, 300));
  }

  // 1b. Write inside sandbox dir succeeds
  console.log('\n--- 1b: Write inside sandbox dir ---');
  const writeInsideCmd = await wrapCommand(
    `echo "test data" > ${SANDBOX_DIR}/test-file.txt && cat ${SANDBOX_DIR}/test-file.txt`,
  );
  try {
    const output = execSync(writeInsideCmd, { encoding: 'utf-8', timeout: 10000, env: process.env });
    console.log('PASS: write inside sandbox:', output.trim());
  } catch (err: any) {
    console.log('FAIL: write inside sandbox:', err.message.substring(0, 200));
    if (err.stderr) console.log('stderr:', err.stderr.toString().substring(0, 300));
  }

  // 1c. Write outside sandbox dir fails
  console.log('\n--- 1c: Write outside sandbox dir (should fail) ---');
  const writeOutsideCmd = await wrapCommand(
    'echo "escape attempt" > /tmp/outside-sandbox.txt 2>&1 || echo "BLOCKED: write denied"',
  );
  try {
    const output = execSync(writeOutsideCmd, { encoding: 'utf-8', timeout: 10000, env: process.env });
    console.log('Result:', output.trim());
    if (output.includes('BLOCKED') || output.includes('Read-only')) {
      console.log('PASS: write outside sandbox was blocked');
    } else {
      console.log('FAIL: write outside sandbox was NOT blocked');
    }
  } catch (err: any) {
    console.log('PASS (via error): write outside sandbox blocked:', err.message.substring(0, 200));
  }

  // 1d. Network access blocked
  console.log('\n--- 1d: Network access (should fail) ---');
  const curlCmd = await wrapCommand(
    'curl -s --max-time 3 http://example.com 2>&1 || echo "BLOCKED: no network"',
  );
  try {
    const output = execSync(curlCmd, { encoding: 'utf-8', timeout: 15000, env: process.env });
    console.log('Result:', output.trim().substring(0, 200));
    if (output.includes('BLOCKED') || output.includes('Could not resolve') || output.includes('Network is unreachable')) {
      console.log('PASS: network was blocked');
    } else {
      console.log('FAIL: network was NOT blocked');
    }
  } catch (err: any) {
    console.log('PASS (via error): network blocked:', err.message.substring(0, 200));
  }

  // 1e. Read of /etc/passwd works (not in denyRead)
  console.log('\n--- 1e: Read /etc/passwd (should succeed) ---');
  const readEtcCmd = await wrapCommand('head -1 /etc/passwd');
  try {
    const output = execSync(readEtcCmd, { encoding: 'utf-8', timeout: 10000, env: process.env });
    console.log('PASS: read /etc/passwd:', output.trim());
  } catch (err: any) {
    console.log('FAIL: read /etc/passwd:', err.message.substring(0, 200));
  }

  // 1f. Per-command denyRead
  console.log('\n--- 1f: Per-command denyRead ---');
  const denyReadCmd = await wrapCommand(
    'cat /etc/hostname 2>&1 || echo "BLOCKED: read denied"',
    { denyRead: ['/etc/hostname'] },
  );
  try {
    const output = execSync(denyReadCmd, { encoding: 'utf-8', timeout: 10000, env: process.env });
    console.log('Result:', output.trim());
    if (output.includes('BLOCKED') || output.includes('Permission denied') || output.includes('No such file')) {
      console.log('PASS: per-command denyRead worked');
    } else {
      console.log('FAIL: per-command denyRead did NOT work');
    }
  } catch (err: any) {
    console.log('PASS (via error): per-command denyRead worked:', err.message.substring(0, 200));
  }

  // 1g. Per-command tighter allowWrite
  console.log('\n--- 1g: Per-command allowWrite override (tighter) ---');
  const tightWriteCmd = await wrapCommand(
    `echo "tight" > ${SANDBOX_DIR}/test-tight.txt 2>&1 || echo "BLOCKED: write denied"`,
    { allowWrite: ['/tmp/sandbox-test-other'] }, // NOT the sandbox dir
  );
  try {
    const output = execSync(tightWriteCmd, { encoding: 'utf-8', timeout: 10000, env: process.env });
    console.log('Result:', output.trim());
    if (output.includes('BLOCKED') || output.includes('Read-only') || output.includes('Permission denied')) {
      console.log('PASS: per-command tighter allowWrite worked');
    } else {
      console.log('FAIL: per-command tighter allowWrite did NOT restrict writes');
    }
  } catch (err: any) {
    console.log('PASS (via error): per-command tighter allowWrite worked:', err.message.substring(0, 200));
  }

  if (!useLowLevel) {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  }
  console.log('\nTest 1 complete.\n');
}

// ── Test 2: Per-command network isolation ────────────────────────────────
// Tests whether customConfig.network actually changes network access
// on a per-command basis. This is the critical question: can the exec
// MCP server be fully network-isolated while the git MCP server can
// reach github.com?
async function testPerCommandNetworkIsolation() {
  console.log('═══ Test 2: Per-Command Network Isolation ═══\n');

  if (!hasSocat()) {
    console.log('SKIP: socat not installed — cannot test network isolation.');
    console.log('Install socat to run this test: apt install socat');
    return;
  }

  // Initialize with broad network access (union of what all servers need)
  const config = {
    network: {
      allowedDomains: ['example.com', '*.example.com', 'github.com', '*.github.com'],
      deniedDomains: [] as string[],
    },
    filesystem: {
      denyRead: [] as string[],
      allowWrite: [SANDBOX_DIR, ...getDefaultWritePaths()],
      denyWrite: [] as string[],
    },
  };

  await SandboxManager.initialize(config);
  console.log('Initialized with network (example.com + github.com).');
  console.log('Proxy port:', SandboxManager.getProxyPort());
  console.log('SOCKS port:', SandboxManager.getSocksProxyPort());

  // Wait for network to be ready
  const networkReady = await SandboxManager.waitForNetworkInitialization();
  console.log('Network initialization ready:', networkReady);

  // Helper for consistent filesystem config
  const fsConfig = {
    denyRead: [] as string[],
    allowWrite: [SANDBOX_DIR, ...getDefaultWritePaths()],
    denyWrite: [] as string[],
  };

  // 2a. Default config: curl example.com (should work — in allowedDomains)
  console.log('\n--- 2a: Default config — curl example.com (should work) ---');
  const defaultCurl = await SandboxManager.wrapWithSandbox(
    'curl -sv --max-time 5 http://example.com 2>&1 | head -20 || echo "NETWORK_FAILED"',
  );
  try {
    const output = execSync(defaultCurl, { encoding: 'utf-8', timeout: 20000, env: process.env });
    const trimmed = output.trim().substring(0, 200);
    console.log('Result:', trimmed);
    console.log(trimmed.includes('NETWORK_FAILED') ? 'FAIL: could not reach example.com' : 'PASS: reached example.com');
  } catch (err: any) {
    console.log('FAIL:', err.message.substring(0, 200));
  }

  // 2b. customConfig with NO domains — should block ALL network
  // This simulates the exec MCP server: completely network-isolated
  console.log('\n--- 2b: customConfig NO domains — curl example.com (should fail) ---');
  const noNetCurl = await SandboxManager.wrapWithSandbox(
    'curl -sv --max-time 3 http://example.com 2>&1 | head -20; echo "EXIT:$?"',
    undefined,
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: fsConfig,
    },
  );

  // Structural analysis
  console.log('\nStructural comparison (default vs no-network):');
  console.log('  default has socat:', defaultCurl.includes('socat'));
  console.log('  noNet has socat:', noNetCurl.includes('socat'));
  console.log('  default has --unshare-net:', defaultCurl.includes('--unshare-net'));
  console.log('  noNet has --unshare-net:', noNetCurl.includes('--unshare-net'));
  console.log('  Commands identical:', defaultCurl === noNetCurl);

  try {
    const output = execSync(noNetCurl, { encoding: 'utf-8', timeout: 15000, env: process.env });
    const trimmed = output.trim();
    console.log('Result:', trimmed.substring(0, 200));
    const blocked = trimmed.includes('Could not resolve') ||
      trimmed.includes('Network is unreachable') ||
      trimmed.includes('Connection refused') ||
      trimmed.includes('EXIT:7') || trimmed.includes('EXIT:6') || trimmed.includes('EXIT:28');
    console.log(blocked
      ? 'PASS: network blocked with empty allowedDomains'
      : 'FAIL: network NOT blocked — per-command network isolation may not work');
  } catch (err: any) {
    console.log('PASS (via error): network blocked:', err.message.substring(0, 200));
  }

  // 2c. customConfig with ONLY example.com — should reach example.com but NOT github.com
  // This simulates: can we restrict a server to specific domains?
  console.log('\n--- 2c: customConfig example.com only — curl example.com (should work) ---');
  const exampleOnlyCurl = await SandboxManager.wrapWithSandbox(
    'curl -sv --max-time 5 http://example.com 2>&1 | head -20 || echo "NETWORK_FAILED"',
    undefined,
    {
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: fsConfig,
    },
  );
  try {
    const output = execSync(exampleOnlyCurl, { encoding: 'utf-8', timeout: 20000, env: process.env });
    const trimmed = output.trim().substring(0, 200);
    console.log('Result:', trimmed);
    console.log(trimmed.includes('NETWORK_FAILED') ? 'FAIL' : 'PASS: reached example.com with customConfig');
  } catch (err: any) {
    console.log('FAIL:', err.message.substring(0, 200));
  }

  // 2d. Same customConfig (example.com only) — curl github.com (should FAIL)
  // This is the key test: does customConfig.network actually RESTRICT per-command?
  console.log('\n--- 2d: customConfig example.com only — curl github.com (should FAIL) ---');
  const exampleOnlyGithubCurl = await SandboxManager.wrapWithSandbox(
    'curl -sv --max-time 3 http://github.com 2>&1 | head -20; echo "EXIT:$?"',
    undefined,
    {
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: fsConfig,
    },
  );
  try {
    const output = execSync(exampleOnlyGithubCurl, { encoding: 'utf-8', timeout: 15000, env: process.env });
    const trimmed = output.trim();
    console.log('Result:', trimmed.substring(0, 300));
    // If github.com was blocked, we'd see connection errors or proxy rejection
    const blocked = trimmed.includes('Could not resolve') ||
      trimmed.includes('Connection refused') ||
      trimmed.includes('Proxy CONNECT aborted') ||
      trimmed.includes('EXIT:7') || trimmed.includes('EXIT:56') || trimmed.includes('EXIT:28');
    // If github.com was reachable, we'd see HTML or a redirect
    const reachable = trimmed.includes('github') || trimmed.includes('GitHub') ||
      trimmed.includes('301') || trimmed.includes('Location');
    if (blocked) {
      console.log('PASS: github.com blocked when customConfig only allows example.com');
      console.log('>>> PER-COMMAND NETWORK ISOLATION WORKS <<<');
    } else if (reachable) {
      console.log('FAIL: github.com reachable despite customConfig restricting to example.com');
      console.log('>>> PER-COMMAND NETWORK ISOLATION DOES NOT WORK <<<');
      console.log('>>> Network filtering is process-wide, not per-command <<<');
    } else {
      console.log('UNCLEAR: unexpected output — manual inspection needed');
    }
  } catch (err: any) {
    console.log('Result (error):', err.message.substring(0, 200));
    console.log('PASS (likely): github.com blocked');
  }

  SandboxManager.cleanupAfterCommand();
  await SandboxManager.reset();
  console.log('\nTest 2 complete.\n');
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('sandbox-runtime exploration tests\n');
  console.log('Platform:', SandboxManager.isSupportedPlatform());
  console.log('Default write paths:', getDefaultWritePaths());
  console.log();

  ensureSandboxDir();

  await testNoNetworkSandbox();
  await testPerCommandNetworkIsolation();

  console.log('All tests complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
