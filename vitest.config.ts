import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Filesystem fault and atomicity tests contend when the full qualification
    // suite runs in parallel. Keep a finite bound without treating host I/O
    // scheduling as a product failure.
    maxWorkers: 2,
    // Contract fixtures perform bounded atomic-file and signature checks. Give
    // individual cases headroom on slower disks without creating a long-run
    // development gate.
    testTimeout: 60_000,
  },
});
