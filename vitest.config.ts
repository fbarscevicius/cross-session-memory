import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The three openclaw/plugin-sdk subpaths are aliased to local stubs so the integration test can
  // drive the real src/index.ts wiring with no built OpenClaw clone. The unit suite under
  // test/*.test.ts imports only the pure core and is unaffected by these aliases.
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": stub("./test/_stubs/plugin-entry.ts"),
      "openclaw/plugin-sdk/routing": stub("./test/_stubs/routing.ts"),
      "openclaw/plugin-sdk/state-paths": stub("./test/_stubs/state-paths.ts"),
    },
  },
  test: {
    pool: "forks",
    include: ["test/**/*.test.ts"],
  },
});
