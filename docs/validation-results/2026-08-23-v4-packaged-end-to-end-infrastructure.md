# V4 packaged end-to-end qualification infrastructure — 2026-08-23

> Scope update: the current development ladder is V0–V7 only, and no required run may exceed 24 elapsed hours. Later-gate references below are historical context, not blockers.

> Binding update: future packaged V4 results must precommit and retain the exact
> operational-configuration, catalog, detector-rule, client-build, and sample-rate
> identity actually loaded by the packaged server. Legacy bundles without this
> binding cannot be combined and fail as `packaged-config-binding-missing`. See
> [the V4 combiner infrastructure record](./2026-08-23-v4-combiner-infrastructure.md).

## Result

**Infrastructure accepted; exact packaged run pending; overall V4 not passed.**

The V4 packaged sub-gate is separate from the 16,040-case conditional detector campaign. It starts `dist/server-node/index.js` with `/usr/bin/node`, uses the normal one-tuner `DeadlineScheduler`, immutable configuration/tune/visit epochs, server-authoritative synthetic playback, `DetectionEngine`, alert recovery, test-domain evidence finalization, the evidence verifier, and protocol-v2 live control.

No installed RSPdx, SDRconnect, antenna, RF chain, calibrated source, or navigation receiver is used by this gate. It cannot establish sensitivity, absolute power, spoofing detection, navigation integrity, or deliberate intent.

## Precommitted bounded matrix

The harness writes and syncs its manifest before the first scenario starts:

| Case | Physical target | Expected result |
|---|---|---|
| Wideband rise | L1 / E1 / B1C / SBAS | Alert, then ten-clean recovery |
| Wideband rise | GPS L2C | Alert, then ten-clean recovery |
| Wideband rise | L5 / E5a / B2a | Alert, then ten-clean recovery |
| Wideband rise | GLONASS G1 | Alert, then ten-clean recovery |
| Matched-power control | L1 / E1 / B1C / SBAS | No alert |
| Configuration change | L1 / E1 / B1C / SBAS | Unknown / Test inconclusive |
| Data gap | L1 / E1 / B1C / SBAS | Unknown / Test inconclusive |

The generated truth window is schedule-aware. Six-second targets retain the production 3-of-5 and two-second accumulated-exposure rules; only the synthetic event duration is stretched so at least the required number of real scheduled observations can occur. Detector thresholds, target deadlines, tuner scheduling, and recovery counts are not shortened.

## Fail-closed assertions

- Every positive target must appear in the main UI-facing spectrum stream, canonical Alert state, synthetic incident, affected-target list, Recovering state, and Complete result.
- A missed positive event, wrong target, wrong center, stale center, missing epoch, missing recovery phase, or missing canonical incident fails the sub-gate.
- Matched-power, configuration-change, and data-gap controls fail if any alert, recovering state, or synthetic incident appears.
- Configuration change and data gap must finish as `Test inconclusive`; matched-power must remain `No RF change detected`.
- Every UI-facing frame must carry the exact test-domain marker, run identity, physical target, requested/confirmed center, 10 MS/s read-back, visit ID, and immutable epoch triple.
- Synthetic frames, event lifecycle updates, completed visits, and Unknown gaps may persist only when the evidence store, payload, and marker independently identify the isolated test/synthetic domain. Every case run ID and scenario ID must be present under test evidence and absent from field evidence.
- Persisted scheduled evidence must cover all four Tier-1 targets with zero requested/confirmed-center mismatch. Synthetic UI events retain their visible test identity; stored event copies bind to the real test evidence session.
- The protected field tree is content-hashed before startup and after shutdown. It must remain byte-for-byte unchanged while the isolated test tree must change.
- The server must stop cleanly, finalize every session as `Complete`, and receive `PASS` from the offline evidence verifier. Evidence loss, writer-bound breaches, live-queue breaches, and the maximum RSS breach fail the sub-gate.
- Source, package, and dependency-lock digests must match `dist/release.json` before startup and remain unchanged after the run.

## Focused software checks

Command:

```text
/usr/bin/npm exec vitest run tests/evidenceStore.test.ts tests/liveSyntheticExercise.test.ts tests/syntheticValidationApi.test.ts tests/v4PackagedQualification.test.ts
```

Result:

- 4 files passed
- 60 tests passed
- 0 failed

The tests include all non-L1 targets through the real scheduler with virtual time, explicit target selection at the packaged HTTP boundary, missed-event failure, false-alert failure, old-frequency failure, target/center mismatch failure, absolute field-store rejection, mixed-domain/non-simulation/malformed-marker rejection, isolated test frame/event/gap persistence, and deterministic repeated offline verification. The bundle verifier accepts only complete per-run test provenance and rejects any reported field-domain marker or run ID.

`/usr/bin/node --check scripts/run-v4-packaged-qualification.mjs` and `/usr/bin/npm exec tsc -- --noEmit` passed.

## Qualification command and remaining gate

The stable-tree command is:

```text
npm run build
npm run validate:v4:packaged
```

The final bundle contains `manifest.json`, `report.json`, and exact `SHA256SUMS` coverage. A successful result may pass only `packagedEndToEndSubGate`; it always records `overallV4: not-passed` and `productionReady: false` until the same exact packaged candidate also passes the separate precommitted 16,040-case detector campaign. V5–V9 remain separate gates.
