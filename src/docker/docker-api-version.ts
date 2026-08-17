/** Compare validated `major.minor` Docker API versions numerically. */
export function compareDockerApiVersions(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0] = right.split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor;
}
