/** Numeric identity shared by the agent, private daemon, and trust staging. */
export interface ContainerIdentity {
  readonly uid: number;
  readonly gid: number;
}

/** Linux bind mounts use the host identity; VM file sharing keeps the image identity. */
export function resolveContainerIdentity(useHostIdentity: boolean): ContainerIdentity {
  return useHostIdentity
    ? { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }
    : { uid: 1000, gid: 1000 };
}
