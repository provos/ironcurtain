#!/usr/bin/env -S -u NODE_OPTIONS node
/**
 * Stateful `docker` CLI stub for the watchdog SIGKILL cross-process test.
 *
 * This is deliberately plain JavaScript: the test's coordinator and detached
 * supervisor need the tsx loader, but DockerManager launches this short-lived
 * process repeatedly. Keeping the CLI stub loader-free prevents inherited
 * Node instrumentation from delaying or intercepting exact-ID probes.
 *
 * Supported subcommands (everything else fails loudly):
 * - `container ls --all --no-trunc --quiet` -> container id while it "exists"
 * - `container inspect <id>`               -> inventory JSON while it "exists"
 * - `stop -t <seconds> <id>`               -> no-op success
 * - `rm -f <id>`                           -> marks the container removed
 * - `inspect <id>`                         -> existence probe (fails once removed)
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const configPath = process.env.IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG;
if (configPath === undefined || configPath === '') {
  process.stderr.write('docker-stub: IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG is not set\n');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(config.logPath, `${JSON.stringify(args)}\n`, { mode: 0o600 });

const removed = () => existsSync(config.removedMarkerPath);
const inspectPayload = () =>
  JSON.stringify([
    {
      Id: config.containerId,
      Name: `/${config.containerName}`,
      Created: '2026-07-21T00:00:00.000000000Z',
      Config: { Labels: { [config.labelKey]: config.labelValue } },
      State: { Running: true },
    },
  ]);

if (args[0] === 'container' && args[1] === 'ls') {
  if (!removed()) process.stdout.write(`${config.containerId}\n`);
  process.exit(0);
}
if (args[0] === 'container' && args[1] === 'inspect') {
  if (removed() || !args.slice(2).includes(config.containerId)) {
    process.stderr.write(`Error: No such container: ${args.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${inspectPayload()}\n`);
  process.exit(0);
}
if (args[0] === 'stop' && args.at(-1) === config.containerId) {
  process.stdout.write(`${config.containerId}\n`);
  process.exit(0);
}
if (args[0] === 'rm' && args[1] === '-f' && args[2] === config.containerId) {
  writeFileSync(config.removedMarkerPath, 'removed\n', { mode: 0o600 });
  process.stdout.write(`${config.containerId}\n`);
  process.exit(0);
}
if (args[0] === 'inspect' && args[1] === config.containerId) {
  if (removed()) {
    process.stderr.write(`Error: No such object: ${config.containerId}\n`);
    process.exit(1);
  }
  process.stdout.write(`${inspectPayload()}\n`);
  process.exit(0);
}
process.stderr.write(`docker-stub: unsupported invocation: ${JSON.stringify(args)}\n`);
process.exit(1);
