import { createDockerManager } from '../../src/docker/docker-manager.js';
import { createIronCurtainInternalNetwork } from '../../src/docker/docker-resource-lifecycle.js';

const [networkName, bundleId] = process.argv.slice(2);
if (!networkName || !bundleId) throw new Error('usage: docker-network-owner <network-name> <bundle-id>');

const allocated = await createIronCurtainInternalNetwork(createDockerManager(), networkName, bundleId);
process.stdout.write(`${JSON.stringify(allocated)}\n`);
setInterval(() => {}, 60_000);
