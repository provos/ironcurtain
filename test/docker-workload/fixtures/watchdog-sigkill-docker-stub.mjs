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
 * - container list/inspect/stop/rm for the leased agent and proxy
 * - network list/inspect/rm for the leased transport network
 * - `inspect <id>` existence probes for either container
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

const containers = [
  { id: config.containerId, name: config.containerName, removedMarkerPath: config.removedMarkerPath },
  {
    id: config.proxyContainerId,
    name: config.proxyContainerName,
    removedMarkerPath: config.proxyRemovedMarkerPath,
  },
];
const activeContainers = () => containers.filter(({ removedMarkerPath }) => !existsSync(removedMarkerPath));
const containerPayload = (resources) =>
  JSON.stringify(
    resources.map(({ id, name }) => ({
      Id: id,
      Name: `/${name}`,
      Created: '2026-07-21T00:00:00.000000000Z',
      Config: { Labels: { [config.labelKey]: config.labelValue } },
      State: { Running: true },
    })),
  );
const networkRemoved = () => existsSync(config.networkRemovedMarkerPath);
const networkPayload = () =>
  JSON.stringify([
    {
      Id: config.networkId,
      Name: config.networkName,
      Created: '2026-07-21T00:00:00.000000000Z',
      Labels: { [config.labelKey]: config.labelValue },
      IPAM: { Config: [{ Subnet: '172.31.250.0/24' }] },
      Containers: {},
    },
  ]);

if (args[0] === 'container' && args[1] === 'ls') {
  const ids = activeContainers().map(({ id }) => id);
  if (ids.length > 0) process.stdout.write(`${ids.join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'container' && args[1] === 'inspect') {
  const requested = args.slice(2);
  const matching = activeContainers().filter(({ id }) => requested.includes(id));
  if (matching.length !== requested.length) {
    process.stderr.write(`Error: No such container: ${args.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${containerPayload(matching)}\n`);
  process.exit(0);
}
const targetContainer = containers.find(({ id }) => id === args.at(-1));
if (args[0] === 'stop' && targetContainer !== undefined && !existsSync(targetContainer.removedMarkerPath)) {
  process.stdout.write(`${targetContainer.id}\n`);
  process.exit(0);
}
const removedContainer = containers.find(({ id }) => id === args[2]);
if (args[0] === 'rm' && args[1] === '-f' && removedContainer !== undefined) {
  writeFileSync(removedContainer.removedMarkerPath, 'removed\n', { mode: 0o600 });
  process.stdout.write(`${removedContainer.id}\n`);
  process.exit(0);
}
const inspectedContainer = containers.find(({ id }) => id === args[1]);
if (args[0] === 'inspect' && inspectedContainer !== undefined) {
  if (existsSync(inspectedContainer.removedMarkerPath)) {
    process.stderr.write(`Error: No such object: ${inspectedContainer.id}\n`);
    process.exit(1);
  }
  process.stdout.write(`${containerPayload([inspectedContainer])}\n`);
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'ls') {
  if (!networkRemoved()) process.stdout.write(`${config.networkId}\n`);
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'inspect') {
  if (networkRemoved() || !args.slice(2).includes(config.networkId)) {
    process.stderr.write(`Error: No such network: ${args.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${networkPayload()}\n`);
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'rm' && args[2] === config.networkId) {
  writeFileSync(config.networkRemovedMarkerPath, 'removed\n', { mode: 0o600 });
  process.stdout.write(`${config.networkId}\n`);
  process.exit(0);
}
process.stderr.write(`docker-stub: unsupported invocation: ${JSON.stringify(args)}\n`);
process.exit(1);
