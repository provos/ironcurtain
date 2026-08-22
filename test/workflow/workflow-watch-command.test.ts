import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import type { DaemonClient } from '../../src/daemon-client/daemon-client.js';
import { JsonlTailer, runWorkflowWatch } from '../../src/workflow/workflow-watch-command.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRun(): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-watch-'));
  temporaryDirectories.push(root);
  const runDir = resolve(root, 'wf-test');
  mkdirSync(runDir);
  writeFileSync(
    resolve(runDir, 'definition.json'),
    JSON.stringify({
      initial: 'work',
      states: {
        work: { type: 'agent' },
        done: { type: 'terminal' },
        FAILED_REVIEW: { type: 'terminal' },
      },
    }),
  );
  return runDir;
}

function record(type: string, ts: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ts, workflowId: 'wf-test', state: 'work', ...fields });
}

describe('JsonlTailer', () => {
  it('waits for complete lines and decodes a UTF-8 code point split across appends', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    const raw = Buffer.from(record('error', '2026-08-21T12:00:00.000Z', { error: 'bad 💥' }));
    const emojiStart = raw.indexOf(Buffer.from('💥'));
    writeFileSync(path, raw.subarray(0, emojiStart + 2));

    const seen: string[] = [];
    const warnings: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ raw: line }) => seen.push(line),
      onWarning: (warning) => warnings.push(warning),
    });
    expect(await tailer.poll()).toBe(0);
    expect(warnings).toEqual([]);

    appendFileSync(path, Buffer.concat([raw.subarray(emojiStart + 2), Buffer.from('\n')]));
    expect(await tailer.poll()).toBe(1);
    expect(seen).toEqual([raw.toString('utf8')]);
    expect(warnings).toEqual([]);
  });

  it('assembles a large record split across many read chunks', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    const raw = record('error', '2026-08-21T12:00:00.000Z', { error: 'x'.repeat(512 * 1024) });
    writeFileSync(path, raw.slice(0, 200_000));
    const seen: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ raw: line }) => seen.push(line),
      onWarning: vi.fn(),
    });

    expect(await tailer.poll()).toBe(0);
    appendFileSync(path, raw.slice(200_000, 400_000));
    expect(await tailer.poll()).toBe(0);
    appendFileSync(path, `${raw.slice(400_000)}\n`);
    expect(await tailer.poll()).toBe(1);
    expect(seen).toEqual([raw]);
  });

  it('drops an oversized record and continues at the next newline', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    const valid = record('error', '2026-08-21T12:00:01.000Z', { error: 'after' });
    writeFileSync(
      path,
      `${record('error', '2026-08-21T12:00:00.000Z', { error: 'x'.repeat(1024 * 1024 + 1) })}\n${valid}\n`,
    );
    const seen: string[] = [];
    const warnings: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ raw }) => seen.push(raw),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(await tailer.poll()).toBe(1);
    expect(seen).toEqual([valid]);
    expect(warnings).toEqual([expect.stringContaining('larger than')]);
  });

  it('warns for malformed complete lines and resumes with the next record', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    writeFileSync(path, `{broken}\n${record('error', '2026-08-21T12:00:00.000Z', { error: 'boom' })}\n`);
    const seen: string[] = [];
    const warnings: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ record: parsed }) => seen.push(parsed.type),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(await tailer.poll()).toBe(1);
    expect(seen).toEqual(['error']);
    expect(warnings).toHaveLength(1);
  });

  it('handles file replacement without repeating records retained in the replacement', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    const first = record('error', '2026-08-21T12:00:00.000Z', { error: 'first' });
    writeFileSync(path, `${first}\n`);
    const seen: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ raw }) => seen.push(raw),
      onWarning: vi.fn(),
    });
    expect(await tailer.poll()).toBe(1);

    const replacement = resolve(runDir, 'replacement.jsonl');
    const second = record('error', '2026-08-21T12:00:01.000Z', { error: 'second' });
    writeFileSync(replacement, `${first}\n${second}\n`);
    renameSync(replacement, path);

    expect(await tailer.poll()).toBe(1);
    expect(seen).toEqual([first, second]);
  });

  it('preserves intentional identical records appended in the same file generation', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    const duplicate = record('error', '2026-08-21T12:00:00.000Z', { error: 'same' });
    writeFileSync(path, `${duplicate}\n${duplicate}\n`);
    const seen: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ raw }) => seen.push(raw),
      onWarning: vi.fn(),
    });

    expect(await tailer.poll()).toBe(2);
    expect(seen).toEqual([duplicate, duplicate]);
  });

  it('processes only the requested number of complete records per poll', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    const records = [0, 1, 2].map((index) =>
      record('error', `2026-08-21T12:00:0${String(index)}.000Z`, { error: String(index) }),
    );
    writeFileSync(path, `${records.join('\n')}\n`);
    const seen: string[] = [];
    const tailer = new JsonlTailer(path, {
      onLine: ({ raw }) => seen.push(raw),
      onWarning: vi.fn(),
    });

    expect(await tailer.poll(1)).toBe(1);
    expect(tailer.hasUnreadData()).toBe(true);
    expect(await tailer.poll(1)).toBe(1);
    expect(tailer.hasUnreadData()).toBe(true);
    expect(await tailer.poll(1)).toBe(1);
    expect(tailer.hasUnreadData()).toBe(false);
    expect(seen).toEqual(records);
  });

  it('bounds work for an unterminated oversized record', async () => {
    const runDir = temporaryRun();
    const path = resolve(runDir, 'messages.jsonl');
    writeFileSync(path, 'x'.repeat(2 * 1024 * 1024));
    const tailer = new JsonlTailer(path, {
      onLine: vi.fn(),
      onWarning: vi.fn(),
    });

    expect(await tailer.poll(1)).toBe(0);
    expect(tailer.hasUnreadData()).toBe(true);
  });
});

describe('workflow watch', () => {
  it('waits for an asynchronous output writer before continuing replay', async () => {
    const runDir = temporaryRun();
    const error = record('error', '2026-08-21T12:00:00.000Z', { error: 'boom' });
    const terminal = record('run_terminal', '2026-08-21T12:00:01.000Z', { phase: 'completed' });
    writeFileSync(resolve(runDir, 'messages.jsonl'), `${error}\n${terminal}\n`);
    let releaseWrite: (() => void) | undefined;
    const writeStdout = vi.fn(
      () =>
        new Promise<void>((resolveWrite) => {
          releaseWrite = resolveWrite;
        }),
    );
    let settled = false;
    const watching = runWorkflowWatch([runDir], {
      installProcessSignals: false,
      pollIntervalMs: 1,
      writeStdout,
      writeStderr: vi.fn(),
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(writeStdout).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    releaseWrite?.();
    expect(await watching).toBe(0);
  });

  it('replays selected JSON records with inclusive --since and exits on checkpoint-less completion', async () => {
    const runDir = temporaryRun();
    const at = '2026-08-21T12:00:00.000Z';
    const sent = record('agent_sent', '2026-08-21T11:59:59.999Z', { role: 'coder', message: 'secret prompt' });
    const received = record('agent_received', at, {
      role: 'coder',
      verdict: 'approved',
      confidence: 'deprecated',
      message: 'looks good',
    });
    const terminal = record('state_transition', '2026-08-21T12:00:01.000Z', { from: 'work', event: 'done' });
    writeFileSync(resolve(runDir, 'messages.jsonl'), `${sent}\n${received}\n${terminal}\n`);
    const output: string[] = [];

    const code = await runWorkflowWatch([runDir, '--json', '--since', at, '--events', 'verdict'], {
      installProcessSignals: false,
      pollIntervalMs: 1,
      quiescenceMs: 1,
      writeStdout: (text) => output.push(text),
      writeStderr: vi.fn(),
    });

    expect(code).toBe(0);
    expect(output.join('')).toBe(`${received}\n`);
  });

  it('does not display confidence in human verdict output', async () => {
    const runDir = temporaryRun();
    const received = record('agent_received', '2026-08-21T12:00:00.000Z', {
      role: 'reviewer',
      verdict: 'revise',
      confidence: 'high',
      message: 'tighten it',
    });
    const terminal = record('state_transition', '2026-08-21T12:00:01.000Z', { from: 'work', event: 'done' });
    writeFileSync(resolve(runDir, 'messages.jsonl'), `${received}\n${terminal}\n`);
    const output: string[] = [];

    expect(
      await runWorkflowWatch([runDir], {
        installProcessSignals: false,
        pollIntervalMs: 1,
        quiescenceMs: 1,
        writeStdout: (text) => output.push(text),
        writeStderr: vi.fn(),
      }),
    ).toBe(0);
    expect(output.join('')).toContain('verdict/reviewer revise tighten it');
    expect(output.join('')).not.toContain('confidence');
    expect(output.join('')).not.toContain('high');
  });

  it('ignores terminal checkpoint and transition evidence before the latest resume marker', async () => {
    const runDir = temporaryRun();
    const oldTimestamp = '2026-08-21T12:00:00.000Z';
    const markerTimestamp = '2026-08-21T12:01:00.000Z';
    writeFileSync(
      resolve(runDir, 'checkpoint.json'),
      JSON.stringify({
        timestamp: oldTimestamp,
        machineState: 'work',
        finalStatus: { phase: 'completed' },
      }),
    );
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('state_transition', oldTimestamp, { from: 'work', event: 'done' })}\n` +
        `${record('run_resumed', markerTimestamp)}\n`,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const code = await runWorkflowWatch([runDir], {
      signal: controller.signal,
      installProcessSignals: false,
      pollIntervalMs: 1,
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
    });
    expect(code).toBe(130);
  });

  it('uses checkpoint fingerprints when timestamp and mtime freshness signals tie', async () => {
    const runDir = temporaryRun();
    const tiedTimestamp = '2026-08-21T12:00:00.000Z';
    const checkpointPath = resolve(runDir, 'checkpoint.json');
    const oldCheckpoint = JSON.stringify({
      timestamp: tiedTimestamp,
      machineState: 'work',
      finalStatus: { phase: 'aborted', pad: 'xx' },
    });
    writeFileSync(checkpointPath, oldCheckpoint);
    const tiedMtime = new Date('2026-08-21T12:00:00.000Z');
    utimesSync(checkpointPath, tiedMtime, tiedMtime);
    const oldMtimeMs = statSync(checkpointPath).mtimeMs;
    const oldFingerprint = createHash('sha256').update(oldCheckpoint).digest('hex');
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('run_resumed', tiedTimestamp, {
        checkpointMtimeMs: oldMtimeMs,
        checkpointFingerprint: oldFingerprint,
      })}\n`,
    );
    const newCheckpoint = JSON.stringify({
      timestamp: tiedTimestamp,
      machineState: 'work',
      finalStatus: { phase: 'completed', pad: '' },
    });
    expect(Buffer.byteLength(newCheckpoint)).toBe(Buffer.byteLength(oldCheckpoint));
    const watching = runWorkflowWatch([runDir], {
      installProcessSignals: false,
      pollIntervalMs: 1,
      checkpointRecheckMs: 1,
      quiescenceMs: 1,
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
    });
    setTimeout(() => {
      writeFileSync(checkpointPath, newCheckpoint);
      utimesSync(checkpointPath, tiedMtime, tiedMtime);
    }, 5);

    expect(await watching).toBe(0);
  });

  it.each(['failed', 'aborted'] as const)(
    'lets delayed %s checkpoint authority override a generic done transition',
    async (phase) => {
      const runDir = temporaryRun();
      writeFileSync(
        resolve(runDir, 'messages.jsonl'),
        `${record('state_transition', '2026-08-21T12:00:00.000Z', { from: 'work', event: 'done' })}\n`,
      );
      setTimeout(() => {
        writeFileSync(
          resolve(runDir, 'checkpoint.json'),
          JSON.stringify({
            timestamp: '2026-08-21T12:00:01.000Z',
            machineState: 'work',
            finalStatus: { phase },
          }),
        );
      }, 5);

      expect(
        await runWorkflowWatch([runDir], {
          installProcessSignals: false,
          pollIntervalMs: 1,
          quiescenceMs: 15,
          drainTimeoutMs: 100,
          writeStdout: vi.fn(),
          writeStderr: vi.fn(),
        }),
      ).toBe(3);
    },
  );

  it.each([
    ['completed', 0],
    ['failed', 3],
    ['aborted', 3],
  ] as const)('waits for a delayed %s barrier from a marker-capable producer', async (phase, expectedCode) => {
    const runDir = temporaryRun();
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('run_started', '2026-08-21T12:00:00.000Z')}\n` +
        `${record('state_transition', '2026-08-21T12:00:01.000Z', { from: 'work', event: 'done' })}\n`,
    );
    const watching = runWorkflowWatch([runDir], {
      installProcessSignals: false,
      pollIntervalMs: 1,
      quiescenceMs: 2,
      drainTimeoutMs: 5,
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
    });
    let barrierAppended = false;

    // This is deliberately well beyond both legacy settling bounds. A
    // marker-capable attempt must not infer "completed" from `done`.
    setTimeout(() => {
      barrierAppended = true;
      appendFileSync(
        resolve(runDir, 'messages.jsonl'),
        `${record('run_terminal', '2026-08-21T12:00:02.000Z', { phase })}\n`,
      );
    }, 25);

    expect(await watching).toBe(expectedCode);
    expect(barrierAppended).toBe(true);
  });

  it('keeps waiting when a marker-capable producer crashes before its terminal barrier', async () => {
    const runDir = temporaryRun();
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('run_started', '2026-08-21T12:00:00.000Z')}\n` +
        `${record('state_transition', '2026-08-21T12:00:01.000Z', { from: 'work', event: 'done' })}\n`,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    expect(
      await runWorkflowWatch([runDir], {
        signal: controller.signal,
        installProcessSignals: false,
        pollIntervalMs: 1,
        quiescenceMs: 2,
        drainTimeoutMs: 5,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      }),
    ).toBe(130);
  });

  it('accepts a fresh final checkpoint if a marker-capable producer cannot append its terminal barrier', async () => {
    const runDir = temporaryRun();
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('run_started', '2026-08-21T12:00:00.000Z')}\n` +
        `${record('state_transition', '2026-08-21T12:00:01.000Z', { from: 'work', event: 'done' })}\n`,
    );
    writeFileSync(
      resolve(runDir, 'checkpoint.json'),
      JSON.stringify({
        timestamp: '2026-08-21T12:00:02.000Z',
        machineState: 'work',
        finalStatus: { phase: 'failed' },
      }),
    );

    expect(
      await runWorkflowWatch([runDir], {
        installProcessSignals: false,
        pollIntervalMs: 1,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      }),
    ).toBe(3);
  });

  it('treats the private terminal phase marker as authoritative over a generic terminal name', async () => {
    const runDir = temporaryRun();
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('state_transition', '2026-08-21T12:00:00.000Z', { from: 'work', event: 'done' })}\n` +
        `${record('run_terminal', '2026-08-21T12:00:00.001Z', { phase: 'failed' })}\n`,
    );

    expect(
      await runWorkflowWatch([runDir], {
        installProcessSignals: false,
        pollIntervalMs: 1,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      }),
    ).toBe(3);
  });

  it('clears legacy terminal evidence on a later non-terminal transition', async () => {
    const runDir = temporaryRun();
    writeFileSync(
      resolve(runDir, 'checkpoint.json'),
      JSON.stringify({
        timestamp: '2026-08-21T12:00:00.000Z',
        machineState: 'work',
        finalStatus: { phase: 'completed' },
      }),
    );
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('state_transition', '2026-08-21T12:00:00.000Z', { from: 'work', event: 'done' })}\n` +
        `${record('run_terminal', '2026-08-21T12:00:00.001Z', { phase: 'completed' })}\n` +
        `${record('state_transition', '2026-08-21T12:00:01.000Z', { from: 'done', event: 'work' })}\n`,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    expect(
      await runWorkflowWatch([runDir], {
        signal: controller.signal,
        installProcessSignals: false,
        pollIntervalMs: 1,
        quiescenceMs: 1,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      }),
    ).toBe(130);
  });

  it('ignores mixed-workflow records for output and terminal evidence', async () => {
    const runDir = temporaryRun();
    const foreign = record('state_transition', '2026-08-21T12:00:00.000Z', {
      workflowId: 'wf-foreign',
      from: 'work',
      event: 'done',
    });
    writeFileSync(resolve(runDir, 'messages.jsonl'), `${foreign}\n`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const output: string[] = [];

    expect(
      await runWorkflowWatch([runDir], {
        signal: controller.signal,
        installProcessSignals: false,
        pollIntervalMs: 1,
        quiescenceMs: 1,
        writeStdout: (text) => output.push(text),
        writeStderr: vi.fn(),
      }),
    ).toBe(130);
    expect(output).toEqual([]);
  });

  it('sanitizes every human-rendered field into one inert line', async () => {
    const runDir = temporaryRun();
    const hostile = record('agent_received', '2026-08-21T12:00:00.000Z\nFORGED', {
      role: '\u001b[31mreviewer\u001b[0m\nrole',
      verdict: 'approved\r\nFORGED',
      message: '\u001b]0;owned\u0007safe\nFORGED',
    });
    const terminal = record('run_terminal', '2026-08-21T12:00:01.000Z', { phase: 'completed' });
    writeFileSync(resolve(runDir, 'messages.jsonl'), `${hostile}\n${terminal}\n`);
    const output: string[] = [];

    expect(
      await runWorkflowWatch([runDir], {
        installProcessSignals: false,
        pollIntervalMs: 1,
        quiescenceMs: 1,
        writeStdout: (text) => output.push(text),
        writeStderr: vi.fn(),
      }),
    ).toBe(0);
    const rendered = output.join('');
    expect(rendered.split('\n')).toHaveLength(2);
    expect(rendered).not.toContain('\u001b');
    expect(rendered).toContain('reviewer role approved FORGED safe FORGED');
  });

  it('maps case-insensitive fail terminal names to exit 3', async () => {
    const runDir = temporaryRun();
    writeFileSync(
      resolve(runDir, 'messages.jsonl'),
      `${record('state_transition', '2026-08-21T12:00:00.000Z', { from: 'work', event: 'FAILED_REVIEW' })}\n`,
    );
    expect(
      await runWorkflowWatch([runDir, '--events', 'transition'], {
        installProcessSignals: false,
        pollIntervalMs: 1,
        quiescenceMs: 1,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      }),
    ).toBe(3);
  });

  it('uses only existing workflows.get support when watching by ID against an old daemon', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-watch-home-'));
    temporaryDirectories.push(home);
    const originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    try {
      const runDir = resolve(home, 'workflow-runs', 'wf-old-daemon');
      // temporaryRun created a sibling fixture; this target lives under the
      // default ID root to exercise ID resolution.
      const sourceRun = temporaryRun();
      mkdirSync(resolve(home, 'workflow-runs'), { recursive: true });
      cpSync(sourceRun, runDir, { recursive: true });
      writeFileSync(
        resolve(runDir, 'messages.jsonl'),
        `${record('state_transition', '2026-08-21T12:00:00.000Z', {
          workflowId: 'wf-old-daemon',
          from: 'work',
          event: 'done',
        })}\n`,
      );

      const calls: string[] = [];
      let query = 0;
      const fake = {
        connect: vi.fn().mockResolvedValue(undefined),
        call: vi.fn(async (method: string) => {
          calls.push(method);
          query += 1;
          return {
            ok: true,
            payload: { workflowId: 'wf-old-daemon', phase: query === 1 ? 'running' : 'completed' },
          };
        }),
        onEvent: vi.fn(() => () => {}),
        onClose: vi.fn(() => () => {}),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as DaemonClient;

      const code = await runWorkflowWatch(['wf-old-daemon'], {
        createClient: () => fake,
        installProcessSignals: false,
        pollIntervalMs: 1,
        reconcileIntervalMs: 1,
        quiescenceMs: 1,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
      });
      expect(code).toBe(0);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(calls)).toEqual(new Set(['workflows.get']));
    } finally {
      if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = originalHome;
    }
  });

  it('continues through a human gate until the daemon reports a terminal phase', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-watch-home-'));
    temporaryDirectories.push(home);
    const originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    try {
      const sourceRun = temporaryRun();
      const runDir = resolve(home, 'workflow-runs', 'wf-gate');
      mkdirSync(resolve(home, 'workflow-runs'), { recursive: true });
      cpSync(sourceRun, runDir, { recursive: true });
      const phases = ['waiting_human', 'completed'] as const;
      let query = 0;
      const fake = {
        connect: vi.fn().mockResolvedValue(undefined),
        call: vi.fn(async () => ({
          ok: true,
          payload: { workflowId: 'wf-gate', phase: phases[Math.min(query++, phases.length - 1)] },
        })),
        onEvent: vi.fn(() => () => {}),
        onClose: vi.fn(() => () => {}),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as DaemonClient;

      expect(
        await runWorkflowWatch(['wf-gate'], {
          createClient: () => fake,
          installProcessSignals: false,
          pollIntervalMs: 1,
          reconcileIntervalMs: 1,
          quiescenceMs: 1,
          writeStdout: vi.fn(),
          writeStderr: vi.fn(),
        }),
      ).toBe(0);
      expect(fake.call).toHaveBeenCalledTimes(2);
    } finally {
      if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = originalHome;
    }
  });

  it('reconnects and re-queries after an involuntary daemon disconnect', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-watch-home-'));
    temporaryDirectories.push(home);
    const originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    try {
      const sourceRun = temporaryRun();
      const runDir = resolve(home, 'workflow-runs', 'wf-reconnect');
      mkdirSync(resolve(home, 'workflow-runs'), { recursive: true });
      cpSync(sourceRun, runDir, { recursive: true });

      const first = {
        connect: vi.fn().mockResolvedValue(undefined),
        call: vi.fn(async () => ({
          ok: true,
          payload: { workflowId: 'wf-reconnect', phase: 'running' },
        })),
        onEvent: vi.fn(() => () => {}),
        onClose: vi.fn((listener: (info: { reason: string }) => void) => {
          setTimeout(() => listener({ reason: 'old daemon stopped' }), 5);
          return () => {};
        }),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as DaemonClient;
      const second = {
        connect: vi.fn().mockResolvedValue(undefined),
        call: vi.fn(async () => ({
          ok: true,
          payload: { workflowId: 'wf-reconnect', phase: 'completed' },
        })),
        onEvent: vi.fn(() => () => {}),
        onClose: vi.fn(() => () => {}),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as DaemonClient;
      let connection = 0;

      expect(
        await runWorkflowWatch(['wf-reconnect'], {
          createClient: () => (connection++ === 0 ? first : second),
          installProcessSignals: false,
          pollIntervalMs: 1,
          reconcileIntervalMs: 50,
          reconnectPollMs: 1,
          reconnectWindowMs: 100,
          quiescenceMs: 1,
          writeStdout: vi.fn(),
          writeStderr: vi.fn(),
        }),
      ).toBe(0);
      expect(first.call).toHaveBeenCalledTimes(1);
      expect(second.call).toHaveBeenCalledTimes(1);
    } finally {
      if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = originalHome;
    }
  });
});
