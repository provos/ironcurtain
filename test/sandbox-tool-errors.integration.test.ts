/**
 * Integration test for silent-tool-failure in Code Mode.
 *
 * Each probe below runs in its own fresh V8 isolate via `executeCode`
 * so failures are individually attributable. All probes exercise the
 * full production path:
 *
 *   [V8 isolate, LLM-generated code]
 *          ↓ global tool stub (throws iff parsed.success === false)
 *   [UTCP Code Mode toolCallRef wrapper]
 *          ↓ { success, result }
 *   [IronCurtainCommunicationProtocol.callTool]
 *          ↓ handleToolCall(server, tool, args)
 *   [ToolCallCoordinator → policy engine → MCPClientManager]
 *          ↓ stdio
 *   [mcp-proxy-server.ts relay subprocess]
 *          ↓ stdio
 *   [@modelcontextprotocol/server-filesystem backend]
 *
 * Four error probes describe the behavior an LLM-generated snippet must
 * see if it's going to self-correct, a happy-path control proves we
 * don't regress successful calls, and an audit-integrity probe proves
 * the audit log still records backend failures correctly. The four
 * error probes currently expose the silent-tool-failure bug: the MCP
 * response `{ isError: true, content: [...] }` is handed back to the
 * isolate as a successful return value instead of being thrown, so
 * nothing inside the isolate's try/catch fires.
 *
 * The one exception is the unknown-tool probe, which already throws at
 * the JS layer (the method simply doesn't exist on the `filesystem`
 * object), so its assertion is "threw: true" today as well as after
 * the fix.
 *
 * Do NOT adjust the `threw` assertions on error probes to match the
 * current silent behavior -- that is exactly the bug we intend to fix.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Sandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';
import { isIsolatedVmAvailable } from './helpers/isolated-vm-available.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const SANDBOX_DIR = `${REAL_TMP}/ironcurtain-tool-errors-test-${process.pid}`;
const AUDIT_LOG_PATH = `${REAL_TMP}/ironcurtain-tool-errors-audit-${process.pid}.jsonl`;
const GENERATED_DIR = `${REAL_TMP}/ironcurtain-tool-errors-generated-${process.pid}`;
const SEEDED_FILE = `${SANDBOX_DIR}/present.txt`;
const SEEDED_CONTENT = 'seeded content';

/**
 * Shape every in-isolate probe returns. `threw === true` is the signal
 * an LLM needs to enter a catch branch. `returned` is populated when
 * the call resolved without throwing — it's the exact payload the
 * LLM would treat as a successful return value.
 */
interface ProbeResult {
  threw: boolean;
  message: string;
  returned?: unknown;
}

/**
 * Wraps a single in-isolate expression in try/catch so probes return a
 * uniform `ProbeResult`. The body should be a single expression
 * (optionally assigned to a variable) that calls a tool and then
 * evaluates to the probe's "returned" value.
 *
 * We build the snippet here instead of inlining it six times so each
 * `it` block stays readable and the try/catch shape is guaranteed
 * identical across probes.
 */
function probeSnippet(body: string): string {
  return `
    try {
      ${body}
    } catch (err) {
      return {
        threw: true,
        message: err && err.message ? err.message : String(err),
      };
    }
  `;
}

function writeTestArtifacts(
  dir: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
  writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));
}

/** Reads the audit log as an array of parsed entries (empty if missing). */
function readAudit(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(!isIsolatedVmAvailable())('Code Mode surfaces backend tool errors as thrown exceptions', () => {
  let sandbox: Sandbox;

  const config: IronCurtainConfig = {
    auditLogPath: AUDIT_LOG_PATH,
    allowedDirectory: SANDBOX_DIR,
    mcpServers: {
      filesystem: {
        description: 'Read, write, search, and manage files and directories',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX_DIR],
        sandbox: false,
      },
    },
    protectedPaths: [
      resolve(projectRoot, 'src/config/constitution.md'),
      resolve(projectRoot, 'src/config/generated'),
      resolve(projectRoot, 'src/config/mcp-servers.json'),
      resolve(AUDIT_LOG_PATH),
    ],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: '',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
    },
  };

  // One sandbox + one filesystem MCP subprocess for all probes. Each
  // `executeCode` call still spins a fresh V8 isolate, so probes remain
  // isolated from each other; we only avoid the per-probe cost of
  // reconnecting the filesystem backend.
  beforeAll(async () => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    writeFileSync(SEEDED_FILE, SEEDED_CONTENT);
    writeTestArtifacts(GENERATED_DIR, testCompiledPolicy, testToolAnnotations);

    sandbox = new Sandbox();
    await sandbox.initialize(config);
  }, 30_000);

  afterAll(async () => {
    await sandbox.shutdown();
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    rmSync(GENERATED_DIR, { recursive: true, force: true });
    rmSync(AUDIT_LOG_PATH, { force: true });
  });

  // ------------------------------------------------------------------
  // Error probes: each describes a distinct failure mode an LLM can
  // reasonably trigger and must be able to observe via a thrown
  // exception.
  // ------------------------------------------------------------------

  it('throws when the LLM calls a tool that does not exist on the server namespace', async () => {
    // UTCP Code Mode generates direct-binding function stubs on
    // `global.filesystem`. An unknown tool is simply an absent
    // property, so the JS layer itself throws `TypeError: X is not a
    // function` before any policy or transport is involved. This is
    // already the desired behavior today and must remain so after the
    // silent-failure fix.
    const code = probeSnippet(`
      const r = filesystem.tool_does_not_exist({ a: 1 });
      return { threw: false, message: '', returned: r };
    `);

    const { result } = await sandbox.executeCode(code);
    const probe = result as ProbeResult;

    expect(
      probe.threw,
      `expected the unknown-tool call to throw inside the isolate, got: ${JSON.stringify(probe)}`,
    ).toBe(true);
    // The thrown message should name the missing tool so an LLM can
    // spot the typo. "is not a function" is the TypeError hallmark
    // produced by the JS runtime.
    expect(probe.message).toContain('tool_does_not_exist');
    expect(probe.message).toMatch(/is not a function/i);
  }, 60_000);

  it('throws with a message naming the valid argument names when the LLM passes a wrong arg key', async () => {
    // `read_file` requires `path`. Passing `file` instead (with no
    // `path`) trips IronCurtain's `validateToolArguments`: the tool
    // schema has no `additionalProperties: true`, so unknown keys
    // fail fast with a listing of valid parameters. Today that error
    // is returned silently as `{ isError: true, content: [...] }`,
    // which the isolate treats as a successful return. Post-fix,
    // this must throw so the LLM hits the catch.
    const code = probeSnippet(`
      const r = filesystem.read_file({ file: 'something' });
      return { threw: false, message: '', returned: r };
    `);

    const { result } = await sandbox.executeCode(code);
    const probe = result as ProbeResult;

    expect(
      probe.threw,
      `wrong arg name must throw so the LLM can self-correct. Got: ${JSON.stringify(probe.returned)}`,
    ).toBe(true);
    // The IronCurtain validator's message lists the valid parameter
    // names — crucially including `path` — so the LLM has enough
    // information to fix the call on retry.
    expect(probe.message.toLowerCase()).toContain('path');
    expect(probe.message.toLowerCase()).toMatch(/unknown argument|valid parameter/);
  }, 60_000);

  it('throws with a type-mismatch message when the LLM passes an object where a string path is required', async () => {
    // `path` must be a string. Passing an object tests the type-
    // validation layer. Today the pipeline's path normalization
    // stringifies the object (→ `'[object Object]'`), which is
    // outside the sandbox, so the call surfaces as "ESCALATION
    // REQUIRED: ... no escalation handler" -- still silent. What the
    // LLM actually needs is a type-mismatch signal on the
    // `path` argument. Post-fix this must throw; the message may
    // mention `path`, "string", or at least the escalation reason,
    // but it must be informative.
    const code = probeSnippet(`
      const r = filesystem.read_file({ path: { nested: 'object' } });
      return { threw: false, message: '', returned: r };
    `);

    const { result } = await sandbox.executeCode(code);
    const probe = result as ProbeResult;

    expect(
      probe.threw,
      `wrong arg type must throw so the LLM can self-correct. Got: ${JSON.stringify(probe.returned)}`,
    ).toBe(true);
    // Post-fix, `validateToolArguments` catches type mismatches
    // before `prepareToolArgs` can stringify an object to
    // `[object Object]` and trigger an escalation. The thrown
    // message must clearly tell the LLM that a string was expected.
    expect(probe.message.length).toBeGreaterThan(0);
    expect(probe.message).not.toBe('undefined');
    expect(probe.message).not.toBe('[object Object]');
    expect(probe.message.toLowerCase()).toContain('must be a string');
  }, 60_000);

  it('throws with an ENOENT message when the LLM reads a path that does not exist', async () => {
    // Well-formed, policy-allowed call that the backend cannot
    // satisfy: the file doesn't exist. The MCP filesystem server
    // wraps `fs.readFile`'s ENOENT as
    // `{ isError: true, content: [{text: "ENOENT: no such file..."}] }`.
    // IronCurtain forwards the response shape verbatim. Today the
    // isolate sees this as a successful return; post-fix it must
    // throw with the ENOENT message.
    // Randomize the filename so no two test runs race on the same
    // path (prevents filesystem-level flakiness if rerun quickly).
    const missingPath = `${SANDBOX_DIR}/missing-${randomUUID()}.txt`;
    const code = probeSnippet(`
      const r = filesystem.read_file({ path: ${JSON.stringify(missingPath)} });
      return { threw: false, message: '', returned: r };
    `);

    const { result } = await sandbox.executeCode(code);
    const probe = result as ProbeResult;

    expect(
      probe.threw,
      `missing-file reads must throw so the LLM can self-correct. Got: ${JSON.stringify(probe.returned)}`,
    ).toBe(true);
    // The backend's ENOENT message is the informative signal. We
    // tolerate variation ("ENOENT", "no such file or directory",
    // "not found") because the MCP SDK may wrap the original message.
    expect(probe.message.toLowerCase()).toMatch(/enoent|no such file|not found/);
  }, 60_000);

  // ------------------------------------------------------------------
  // Happy-path regression guard: the fix must not convert successful
  // calls into thrown exceptions.
  // ------------------------------------------------------------------

  it('returns the content without throwing when the LLM reads a seeded file', async () => {
    const code = probeSnippet(`
      const r = filesystem.read_file({ path: ${JSON.stringify(SEEDED_FILE)} });
      return { threw: false, message: '', returned: r };
    `);

    const { result } = await sandbox.executeCode(code);
    const probe = result as ProbeResult;

    expect(probe.threw, `happy-path read unexpectedly threw: ${probe.message}`).toBe(false);
    // Round-trip check: the seeded string must appear somewhere in
    // the returned MCP content blob. We don't pin the exact shape
    // because the protocol wrapping may evolve.
    expect(JSON.stringify(probe.returned)).toContain(SEEDED_CONTENT);
  }, 60_000);

  // ------------------------------------------------------------------
  // Audit integrity: backend errors must be recorded regardless of
  // whether the isolate sees them as thrown or returned. This test
  // passes both before and after the silent-failure fix -- it locks
  // in that audit writes are already correct on the current code.
  // ------------------------------------------------------------------

  it('records backend errors as audit entries with result.status=error and a non-empty error message', async () => {
    // Unique path so we can pick this probe's entry out of the shared
    // audit log without racing against the other error probes.
    const uniqueMissingPath = `${SANDBOX_DIR}/audit-probe-${randomUUID()}.txt`;
    const beforeTimestamp = new Date().toISOString();

    const code = probeSnippet(`
      const r = filesystem.read_file({ path: ${JSON.stringify(uniqueMissingPath)} });
      return { threw: false, message: '', returned: r };
    `);
    await sandbox.executeCode(code);

    // Audit writes are synchronous but the pipeline clears the
    // call mutex after writing; tiny spin just to avoid read-during-
    // write flakiness on slow CI.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const entries = readAudit(AUDIT_LOG_PATH);
    const matching = entries.find(
      (e) =>
        typeof (e as { toolName?: unknown }).toolName === 'string' &&
        (e as { toolName: string }).toolName === 'read_file' &&
        typeof (e as { timestamp?: unknown }).timestamp === 'string' &&
        (e as { timestamp: string }).timestamp >= beforeTimestamp &&
        JSON.stringify((e as { arguments?: unknown }).arguments ?? {}).includes(uniqueMissingPath),
    );

    expect(matching, 'expected an audit entry for the deliberate missing-file call scoped to this test').toBeDefined();
    if (!matching) return;

    const auditResult = matching.result as { status: string; error?: string } | undefined;
    expect(auditResult).toBeDefined();
    expect(auditResult?.status).toBe('error');
    expect(auditResult?.error ?? '').not.toBe('');
    // The underlying ENOENT text should be preserved in the error
    // message so operators can triage from the log alone.
    expect((auditResult?.error ?? '').toLowerCase()).toMatch(/enoent|no such file|not found/);
  }, 60_000);
});
