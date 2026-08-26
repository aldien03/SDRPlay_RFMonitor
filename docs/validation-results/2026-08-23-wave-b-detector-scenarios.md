# Wave B Detector and Scenario Evidence

**Date:** 2026-08-23  
**Deliverables:** `DET-202`, `DET-210`  
**State:** Evidence ready for software integration; physical qualification not run

## Result

- TypeScript static check passed.
- Ten focused test files passed: 121 tests, zero failures and zero skipped tests.
- Detector output now owns the analyzed frequency bounds, display-bin analysis mask, baseline availability, and anomaly ranges for each completed observation.
- Guard-only activity is excluded before detector analysis and cannot create an anomaly range inside the central mask.
- Receiver overload is a separate acquisition condition and carries no RF-anomaly ranges.
- The browser paints red spectrum/waterfall regions only from validated server detector ranges. It does not derive red regions from amplitude or fabricate a usual level while detector baseline data is unavailable.
- Evidence writer and reader reject detector annotations that escape the stored analysis grid or combine overload with RF-anomaly ranges.
- The qualification scorer records per-target detections, misses, false alerts, false-alert duration, wall-clock latency, observed exposure, unobserved latency, scenario seeds, hashes, and pre-run truth commitments.
- Independent-run summaries report one-sided 95% Wilson lower limits per physical target and scenario family.
- The versioned qualification plan defines deterministic, randomized, held-out replay, and installed-chain levels. Plan targets are derived from the active validated catalog, not a second target list.

Catalog-aligned Tier-1 target IDs tested:

1. `gnss-l1-e1-b1c-sbas`
2. `gnss-gps-l2c`
3. `gnss-l5-e5a-b2a`
4. `gnss-glonass-g1`

## Commands

```bash
/usr/bin/npx tsc --noEmit
/usr/bin/npx vitest run tests/detection.test.ts tests/detectorPresentation.test.ts tests/liveProtocol.test.ts tests/evidenceStore.test.ts tests/syntheticValidation.test.ts tests/detectorQualificationPlan.test.ts tests/syntheticQualificationRunner.test.ts tests/syntheticValidationApi.test.ts tests/liveSyntheticExercise.test.ts tests/syntheticValidationPanel.test.ts
```

Observed result:

```text
Test Files  10 passed (10)
Tests       121 passed (121)
Duration    32.88s
```

## Source hashes at this evidence point

| File | SHA-256 |
|---|---|
| `src/shared/types.ts` | `f1035c832bffb881ec6a9e5d8d0e959238d50a3a916135a9109a812a610ff91e` |
| `src/shared/detection.ts` | `bead704bf3bb53e1fb54714e9731947340293e40e0674868c1f64abed11b020a` |
| `src/shared/detectorQualification.ts` | `c8be174560e10f5772f734a55b243e57b370300a88833c76c4cd4e7a270524a9` |
| `src/shared/syntheticValidation.ts` | `d89eecb3b99cd6267fe012ae7aef27c49e96407360c0e68b2672fce7bdcd2246` |
| `src/server/syntheticValidation.ts` | `e9b6e73f11cf365e8544e3ccf0c9f277fe4c99d50bb672fd367da8c51429f948` |
| `src/server/syntheticQualificationRunner.ts` | `4bbe1297ed331712fec6a87dc9ce86c33b1e643cd1fad35731344c9025a3b7f7` |
| `src/client/detectorPresentation.ts` | `e09ac2c8aa4bcf2ba2bdc52c527464fea0ce2c12c5d157f06c286c37e47d2dbe` |
| `src/client/SpectrumViews.tsx` | `cdd419e1e778736abb8e2b610d0ea9ee81cc36aaa15b162990092f9390ee3705` |
| `docs/detector-validation-protocol.md` | `d68a56f910f6fabbb9d2d960d12490efa5fe4ccf1d88421d85e68cb34f6c20e3` |

## Remaining gates

This evidence is software-only. It does not pass `V4`, `V5`, or `V6` and does not qualify either RSPdx model or an installed antenna chain.

- The mandatory 400-seed-per-target/family randomized campaign is defined but not yet run as an immutable candidate artifact.
- A held-out receiver FFT corpus with independent truth, provenance, and hashes is still required.
- Conducted installed-chain testing with calibrated equipment, the final receiver/filter/cable/LNA/gain configuration, a witness, raw acquisitions, and equipment calibration records is still required.
- Guard rejection, overload separation, sensitivity/detection envelope, and sham behavior must pass on the real installed chain. Synthetic success cannot substitute for these tests.

