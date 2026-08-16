const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build CLI flags that inherit values from the child environment. Values stay
 * out of argv so opaque proxy lease credentials are not exposed in process listings.
 */
export function buildContainerExecEnvironmentArgs(environment?: Readonly<Record<string, string>>): string[] {
  return Object.keys(environment ?? {}).flatMap((key) => {
    if (!ENVIRONMENT_NAME.test(key)) {
      throw new Error(`Invalid container exec environment variable name: ${key}`);
    }
    return ['--env', key];
  });
}
