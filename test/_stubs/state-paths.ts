import { tmpdir } from "node:os";

// Test stub for openclaw/plugin-sdk/state-paths. Returns a disposable dir the integration test
// sets per-case via CSM_TEST_STATE_DIR, so each register() opens an isolated facts.sqlite.
export function resolveStateDir(): string {
  return process.env.CSM_TEST_STATE_DIR ?? tmpdir();
}
