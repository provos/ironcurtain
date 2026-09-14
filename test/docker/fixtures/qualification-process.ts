/** Standalone coordinator used to send real signals without interrupting Vitest. */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { waitForQualificationProcess } from '../../../src/docker-workload/qualification-process.js';

const childSource = `
  const { spawn } = require('node:child_process');
  const descendant = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const terminate = signal => {
    descendant.once('exit', () => process.exit(0));
    descendant.kill(signal);
  };
  process.on('SIGINT', () => terminate('SIGINT'));
  process.on('SIGTERM', () => terminate('SIGTERM'));
  descendant.once('message', () => process.send({ descendantPid: descendant.pid }));
`;
const child = spawn(process.execPath, ['-e', childSource], {
  detached: true,
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const waiting = waitForQualificationProcess(child, process.argv[2] === 'timeout' ? 1_000 : 30_000, {
  termGraceMs: 1_000,
  killGraceMs: 1_000,
});
child.once('message', (message: { descendantPid: number }) => {
  // This identity record must reach the observer before it sends a signal.
  writeSync(1, `${JSON.stringify({ childPid: child.pid, descendantPid: message.descendantPid })}\n`);
});
try {
  await waiting;
} catch (error) {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
