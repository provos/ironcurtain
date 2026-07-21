import { writeFileSync } from 'node:fs';
import { launchDetachedResourceWatchdogSupervisor } from '../../../dist/docker-workload/resource-watchdog-supervisor.js';

const [leasePath, policyPath, statusPath, stopRequestPath, entrypointPath, resultPath] = process.argv.slice(2);
if ([leasePath, policyPath, statusPath, stopRequestPath, entrypointPath, resultPath].some((value) => value === undefined)) {
  throw new Error('watchdog coordinator fixture requires six paths');
}
const launched = await launchDetachedResourceWatchdogSupervisor({
  leasePath,
  policyPath,
  statusPath,
  stopRequestPath,
  entrypointPath,
  startupTimeoutMs: 5000,
});
writeFileSync(resultPath, `${JSON.stringify(launched)}\n`, { mode: 0o600, flag: 'wx' });
