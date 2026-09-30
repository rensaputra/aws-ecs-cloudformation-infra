import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Property-based tests can run many iterations; give them room.
    testTimeout: 30_000,
  },
});
