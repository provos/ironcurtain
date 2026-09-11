const TARGET = '/var/lib/docker';
const OPTIONS = 'ro,nosuid,nodev,noexec,size=1m';

/** Prevent an agent image's declared Docker-state volume from becoming an anonymous writable mount. */
export const DOCKER_AGENT_VOLUME_SHADOW = Object.freeze({
  target: TARGET,
  options: OPTIONS,
  specification: `${TARGET}:${OPTIONS}`,
});
