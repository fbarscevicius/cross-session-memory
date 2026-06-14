// Test stub for openclaw/plugin-sdk/plugin-entry. The real definePluginEntry validates and returns
// the entry; for the integration test we only need it to return the entry so register() is callable.
// Aliased in vitest.config.ts so test/integration.test.ts can drive the real src/index.ts wiring
// without a built OpenClaw clone.
export function definePluginEntry<T>(entry: T): T {
  return entry;
}
