/** Minimal detached-process entrypoint for the resource watchdog supervisor. */

import { runResourceWatchdogSupervisor } from './resource-watchdog-supervisor.js';

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv.at(index);
  const value = process.argv.at(index + 1);
  if (name === undefined || value === undefined || !name.startsWith('--') || values.has(name)) {
    throw new Error('invalid resource-watchdog-supervisor arguments');
  }
  values.set(name, value);
}
const expected = ['--lease', '--policy', '--status', '--stop-request'];
if (values.size !== expected.length || expected.some((name) => !values.has(name))) {
  throw new Error('resource-watchdog-supervisor requires lease, policy, status, and stop-request paths');
}

await runResourceWatchdogSupervisor({
  leasePath: required('--lease'),
  policyPath: required('--policy'),
  statusPath: required('--status'),
  stopRequestPath: required('--stop-request'),
});

function required(name: string): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`missing resource-watchdog-supervisor argument: ${name}`);
  return value;
}
