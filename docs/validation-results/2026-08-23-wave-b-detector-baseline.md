# Wave B detector/baseline validation — 2026-08-23

> Scope update: the current development ladder is V0–V7 only, and no required run may exceed 24 elapsed hours. Earlier long-soak/pilot references below no longer define completion.

Scope: `DET-200` and `DET-201` software gates. This record is not hardware qualification and does not make the installation Production ready.

## Implemented invariants

- The persistent baseline fingerprint and learning generation are authoritative for the production detector. A generation or lifecycle change clears transient votes, drift exposure, adaptive rows, and readiness.
- The exact fingerprint includes receiver/device identity and a canonical SHA-256 of every detector-rule value. Field SDR observations remain unknown until SDRconnect supplies a device serial and the fixed RF/display fields.
- A production detector observation is eligible only when its data domain, target, rule hash, analysis grid, confirmed center/sample rate, timestamps, health, and minimum three-frame visit agree. Ineligible or stale-reference input returns Unknown and cannot train or vote.
- Cold-start rows are stored in the active persistent generation. After eight rows establish a robust seed, anomalous rows are quarantined; a Learning candidate remains Checking and cannot emit an alert or red detector regions.
- Only a Protected exact baseline can enable slow-drift classification. Drift requires accumulated observed exposure; an unapproved operational reference cannot produce that claim.
- Representative UTC hours require, by default, at least two valid observations, a 30-minute first-to-last visit spread, 10 seconds of accumulated accepted-frame exposure, at least 80% valid scheduled opportunities, and no invalidating tune/health/overload/candidate/data gap.
- Unknown visits use the exact active fingerprint when one exists, reduce coverage, invalidate their hour, and never mutate the reservoir. Only one active fingerprint is retained in runtime lookup state for each physical target.
- Restart signal learning selects the persistent generation before resetting runtime state; recovery resumes the same generation and old votes/readiness do not survive.

## Automated evidence

Type check:

```text
/usr/bin/npx tsc --noEmit --pretty false
PASS
```

Detector, baseline, runtime, domain, operator-summary, and synthetic cross-track suite:

```text
/usr/bin/npx vitest run \
  tests/detection.test.ts \
  tests/baselineStore.test.ts \
  tests/monitorService.test.ts \
  tests/operatorSummary.test.ts \
  tests/dataDomains.test.ts \
  tests/liveSyntheticExercise.test.ts \
  tests/syntheticQualificationRunner.test.ts \
  tests/syntheticValidation.test.ts

Test Files  8 passed (8)
Tests       114 passed (114)
```

Qualification-plan contract:

```text
/usr/bin/npx vitest run tests/detectorQualificationPlan.test.ts

Test Files  1 passed (1)
Tests       4 passed (4)
```

## Scientific and operational limits

- The first eight cold-start rows are an explicitly unapproved robust seed, not proof of a clean site. A persistent interferer present from the first row can become part of that seed. Commissioning must begin under reviewed site conditions, collect representative coverage, pass the soak, and protect the baseline explicitly.
- Median/MAD values are normalized `uint8` spectrum values. They do not provide calibrated dBm, navigation integrity, spoofing classification, or jammer intent.
- Representative exposure is derived from accepted-frame timing and scheduler opportunities. It is not continuous tuner coverage. A process outage cannot be reconstructed from RF rows alone; the scheduler/qualification fault ledger must preserve the outage and its missed opportunities (`SCH-110`).
- Requiring receiver serial identity is fail-closed. If the installed SDRconnect chain does not expose `device_serial`, monitoring remains Checking/Unknown until an approved stable identity source is implemented and recommissioned.
- These tests use virtual/synthetic input. Installed RSPdx timing, RF-chain behavior, 24-hour baseline coverage, 72-hour resource soak, and 30-day field acceptance remain separate physical gates.
