/**
 * Node strips types from a directly imported .ts file, and does not follow a
 * .js specifier to the .ts file beside it. The harness imports the sources.
 * This hook resolves that specifier to the .ts file when it is there.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch {
      // No .ts sibling. Keep the .js specifier.
    }
  }
  return nextResolve(specifier, context);
}
