/**
 * ESM resolve hook for worker threads that load TypeScript sources directly.
 *
 * Node's native type stripping loads `.ts` modules but does not apply the
 * TypeScript convention of resolving a `./x.js` specifier to `x.ts`, and tsx
 * loader hooks do not take effect inside worker threads on Node 22. This hook
 * performs exactly that remap; every other specifier passes through unchanged.
 *
 * Requires the SYNCHRONOUS hooks API (`module.registerHooks`, Node >= 22.15):
 * the retry below relies on `nextResolve` throwing synchronously. Under the
 * async `module.register()` API `nextResolve` returns a promise, the catch
 * never runs, and the remap silently does nothing.
 */

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}
