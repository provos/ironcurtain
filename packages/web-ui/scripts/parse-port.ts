export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}
