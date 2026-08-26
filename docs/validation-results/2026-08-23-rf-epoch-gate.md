# RF-100 RF Epoch Gate Qualification

**Date:** 2026-08-23  
**Milestone:** RF-100 software evidence ready  
**Scope:** Requested/confirmed RF state and configuration/tune/visit attribution

## Result

**PASS — zero stale software-epoch attribution in 100,000 deterministic adversarial cases.**

The active capture identity is fixed before the tune command and contains the configuration epoch, tune epoch, visit epoch, visit ID, target ID, requested center, and required sample rate. SDRconnect spectrum can reach receiver health, graphs, detection, or evidence only when every field matches the monitor's still-active immutable identity.

Any conflicting center, sample-rate, or device readback resets settle time and the two-frame discard count. A superseding tune closes the frame gate immediately. Missing, invalid, late, or mismatched transport provenance is dropped and counted as invalid/stale input.

## Adversarial model

Seed: `0x5eed1234`

The bounded 100,000-case test mixes:

- delayed and reordered center, sample-rate, and active-device readbacks;
- duplicate readbacks;
- stale or mismatched readbacks;
- stale configuration, tune, and visit epochs;
- wrong visit and target IDs;
- requested/confirmed center mismatch;
- 9-versus-10 MS/s mismatch;
- frames received before their monotonic confirmation time;
- invalid confirmation timestamps.

Observed result: current, fully matched identities were admitted; stale/mismatched identities admitted: **0**.

## Commands and results

```text
/usr/bin/npm exec tsc -- --noEmit
PASS

/usr/bin/npm exec vitest -- run tests/sdrconnectClient.test.ts --reporter=verbose
PASS — 1 file, 16 tests; 100,000-case stress completed in 67 ms

/usr/bin/npm exec vitest -- run tests/monitorService.test.ts tests/liveSyntheticExercise.test.ts tests/syntheticQualificationRunner.test.ts tests/detection.test.ts --reporter=dot
PASS — 4 files, 39 tests

/usr/bin/npm exec vitest -- run tests/detection.test.ts tests/evidenceStore.test.ts tests/dataDomains.test.ts --reporter=dot
PASS — 3 files, 53 tests

/usr/bin/npm run check
PASS — TypeScript and the complete suite; 40 files, 299 tests
```

## Provenance carried forward

New spectrum evidence includes `configurationEpoch`, `tuneEpoch`, `visitEpoch`, `visitId`, requested center, confirmed center, confirmed sample rate, and tune-confirmation time. Existing early manifest-v2 evidence without `visitEpoch` remains readable; all new writes require a positive visit epoch.

## Scientific boundary

SDRconnect FFT binary messages do not carry a device-generated center-frequency or epoch field. Therefore this result proves the application's attribution and rejection logic, not that opaque FFT contents can independently reveal the hardware frequency that produced them. The hardware transition defense remains the confirmed readback, at least 250 ms settling, and two discarded raw frames. Real RSPdx V1/V2 qualification must still measure command-to-confirm, confirm-to-third-frame, visit, revisit, and fault distributions and must preserve any failure. This software result alone does not pass installed-hardware qualification.
