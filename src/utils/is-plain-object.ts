/** Type guard for non-null, non-array objects. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard that narrows `unknown` to an object known to carry a given key.
 * Useful for safely inspecting properties on caught errors without `as` casts.
 */
export function isObjectWithProp<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}
