import { parseArgs } from 'node:util';
import { createDockerManager } from './docker-manager.js';
import { reconcileIronCurtainDockerResources } from './docker-resource-lifecycle.js';

/** Explicit operator surface for inspecting or applying the startup reconciler. */
export async function runDockerGcCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      'Usage: ironcurtain gc [--dry-run | --force]\n\n' +
        'Lists crash-orphaned IronCurtain Docker resources by default.\n' +
        'Use --force to remove resources whose owner process is no longer alive.\n',
    );
    return;
  }
  if (values.force && values['dry-run']) throw new Error('Choose either --dry-run or --force, not both');

  const apply = values.force === true;
  const result = await reconcileIronCurtainDockerResources(createDockerManager(), { dryRun: !apply });
  const verb = apply ? 'Reclaimed' : 'Would reclaim';
  process.stdout.write(
    `${verb} ${result.removedContainers.length} container(s) and ${result.removedNetworks.length} network(s).\n`,
  );
  for (const name of result.removedContainers) process.stdout.write(`  container ${name}\n`);
  for (const name of result.removedNetworks) process.stdout.write(`  network   ${name}\n`);
  if (result.skippedUnsafeNetworks.length > 0) {
    process.stdout.write(
      `Skipped ${result.skippedUnsafeNetworks.length} legacy/attached network(s) with uncertain ownership.\n`,
    );
  }
  if (!apply) process.stdout.write('Re-run with --force to apply this plan.\n');
}
