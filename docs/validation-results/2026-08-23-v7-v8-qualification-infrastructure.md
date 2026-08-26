# V7/V8 Qualification Infrastructure — 2026-08-23

> Superseded scope: V8 is retired from the development goal and command surface. V7 is the final gate and is capped at 24 elapsed hours. The V8 fixture notes below are retained only as historical provenance and cannot block readiness.

## Decision

Qualification infrastructure: **PASS (software fixtures only)**  
Physical V7 24-hour gate: **NOT RUN**  
Physical V8 fault phase and 72-hour clean soak: **NOT RUN**

No production-readiness or physical RF-performance claim is supported by this record.

## Candidate Infrastructure Exercised

- fixed 24-hour V7 and 72-hour V8 clocks with no duration override;
- exact release/configuration/catalog/detector/site/receiver/installed-chain and four-baseline binding;
- exact cumulative commissioning-epoch valid-revisit accounting, attempt-breach and unknown cause ledgers, and cumulative fixed-bucket revisit/gap histograms;
- rejection of target/identity/baseline/epoch/clock/counter discontinuity and both RF Monitor and collector restart;
- continuous hashed operations-supervisor clock/service status;
- separately pinned Ed25519 witness signatures and copied evidence custody;
- V7 prerequisite binding to exact V0–V6 artifacts and physical V6 chain fingerprint;
- V8 binding to the raw V7 result hash and its complete artifact-set hash;
- mandatory pre-soak fault/backup phase, bracketing switch record, and in-soak 8-dashboard/4 Hz/5 MiB/s load proof;
- bounded, fsynced JSONL chunks, atomic/no-replace manifests, partial/torn-chunk failure, and immutable `PASS`/`FAIL` output;
- offline analysis capped at 100,000 samples and 512 MiB, with qualification-harness memory reported.

## Commands

```bash
npx vitest run tests/longQualification.test.ts tests/qualificationWitnessCli.test.ts
npx vitest run tests/deadlineScheduler.test.ts tests/monitorService.test.ts tests/diagnosticsCollector.test.ts
npm run validate:v7 -- --help
npm run validate:v8 -- --help
node --check scripts/lib/long-qualification.mjs
node --check scripts/run-long-qualification.mjs
node --check scripts/sign-qualification-record.mjs
```

Expected fixture result: all named tests pass and both help commands state fixed 24/72-hour clocks. These tests use virtual timestamps and temporary files; they do not advance either physical gate.

## Required Physical Evidence Still Missing

- independently witnessed exact-candidate V0–V6 prerequisite bundle;
- final site/receiver/antenna/filter/cable/gain binding and protected baseline set;
- one uninterrupted physical V7 interval with 24 representative healthy UTC hours;
- completed mandatory V8 fault and backup/restore phase;
- one clean uninterrupted physical 72-hour V8 soak under the required dashboard, alert-evidence, and export load;
- witnessed managed-switch before/after counters and underlying files.

Follow [V7 And V8 Site Qualification](../v7-v8-site-qualification.md). Preserve every failed run; never edit or combine its evidence with a replacement run.
