#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outputDirectory = path.resolve("dist/server-node");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: {
    index: "src/server/index.ts",
    "validate-config": "src/server/validateConfig.ts",
    "admin-credential": "src/server/adminCredentialCli.ts",
    "profile-seed": "src/server/profileSeedCli.ts",
    "evidence-verifier": "src/server/evidenceVerifierCli.ts",
    "evidence-backup": "src/server/evidenceBackupCli.ts",
    "synthetic-qualification-campaign": "src/server/syntheticQualificationCampaignCli.ts",
    "v4-combine-qualification": "src/server/v4QualificationCombinerCli.ts",
    "held-out-replay-qualification": "src/server/heldOutReplayQualificationCli.ts",
    "conducted-rf-qualification": "src/server/conductedRfQualificationCli.ts",
    traceability: "src/server/traceabilityCli.ts",
    "dgnss-report-worker": "src/server/positioning/worker.ts",
  },
  outdir: outputDirectory,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
});
