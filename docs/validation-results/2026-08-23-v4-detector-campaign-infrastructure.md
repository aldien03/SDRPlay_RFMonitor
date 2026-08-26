# V4 conditional detector campaign infrastructure — 2026-08-23

## Result

**Infrastructure accepted; overall V4 not passed.**

The bounded, resumable campaign runner is implemented for the frozen Wave B detector rules. It can precommit and execute 40 deterministic cases plus 16,000 blinded randomized cases across every combination of four default Tier-1 physical targets and ten scenario families.

No qualifying 16,040-case campaign was executed or published in this record. Waves C–E were still changing the source/package tree, so a run would not have a stable release-candidate identity. The qualifying campaign must run after the final release rebuild and V1 freeze.

This infrastructure covers only the conditional detector statistical path:

`generated normalized FFT → visit median → DetectionEngine → isolated scorer`

Even if that sub-gate passes, overall V4 remains `not-passed` until mandatory packaged scenarios also traverse scheduler, recovery/evidence, server-authoritative operator state, and the main UI with field-tree isolation verified.

## Implemented controls

- Catalog-derived execution at each target's actual center, analysis span, logical-band attribution, and baseline fingerprint.
- Durable pre-run `commitments.jsonl` written and synced before detector execution.
- Stable case/run identities, scenario seeds and hashes, truth commitments, and artifact hashes.
- Atomic bounded result chunks with interruption/resume verification.
- Per-run detection, miss, false-alert, overload-separation, observed exposure, wall-clock latency, observed-exposure latency, and unobserved latency fields.
- Per-target/family outcomes and one-sided 95% Wilson limits against the predeclared `≥0.99` criterion.
- Fail-closed result states: the conditional detector sub-gate may pass or fail; overall V4 is always `not-passed` in this artifact type; V5/V6 remain `not-run`.
- System runtime enforcement at `/usr/bin/node` for a 400-run-per-combination campaign.
- Production-package execution through the bundled `dist/server-node/synthetic-qualification-campaign.js`; no runtime dependency on TypeScript source or the development-only `tsx` package.
- Release identity verification before and after execution using the same source/package digest policy as release metadata generation.
- Protected field-tree content snapshot before/after; missing, changed, or over-bound snapshots fail isolation.
- Immutable final bundle with exact `SHA256SUMS` coverage.
- Verifier rejection of symlinks, non-regular entries, duplicate/reserved/path-escape hashes, missing or unexpected files, partial/extra/noncontiguous chunks, malformed counts/coverage, and rehashed but semantically altered reports.

## Mechanical checks

Runtime:

- Executable: `/usr/bin/node`
- Node: `v24.19.0`

Focused acceptance command:

```text
/usr/bin/node node_modules/vitest/vitest.mjs run tests/syntheticQualificationCampaign.test.ts tests/syntheticQualificationRunner.test.ts tests/detectorQualificationPlan.test.ts
```

Result:

- 3 files passed
- 14 tests passed
- 0 failed

The campaign test covers every target/family at reduced randomized count, an intentional interruption and resume, valid bundle verification, truncated `SHA256SUMS`, unexpected files, a self-consistently rehashed malformed report, and a result symlink. The reduced rehearsal remains failed for the statistical sub-gate because it is below 400 independent runs per target/family.

Type check:

```text
/usr/bin/node node_modules/typescript/bin/tsc --noEmit
```

Result: exit 0.

Expanded focused regression:

```text
/usr/bin/node node_modules/vitest/vitest.mjs run tests/syntheticQualificationCampaign.test.ts tests/syntheticQualificationRunner.test.ts tests/detectorQualificationPlan.test.ts tests/syntheticValidation.test.ts tests/detection.test.ts tests/detectorPresentation.test.ts
```

Result: 6 files, 50 tests passed, 0 failed.

Production-like built entry:

```text
/usr/bin/node scripts/build-server.mjs
/usr/bin/node dist/server-node/synthetic-qualification-campaign.js --help
```

Result: the build emitted `dist/server-node/synthetic-qualification-campaign.js` and the bundled CLI exited 0 under `/usr/bin/node`. The command is wired as:

```text
npm run validate:v4:detector
→ /usr/bin/node dist/server-node/synthetic-qualification-campaign.js
```

The source and release generator now import one side-effect-free `scripts/release-digest-policy.mjs`. This prevents digest-policy drift and prevents a bundled library import from accidentally executing release generation.

Post-build focused result: 4 files, 17 tests passed, 0 failed (`syntheticQualificationCampaign`, runner, plan, and release-package tests); typecheck exited 0.

## Full manifest-only rehearsal

This rehearsal generated commitments in memory only. It executed zero detector cases and produced no qualification artifact.

| Measure | Result |
|---|---:|
| Label | `NON-QUALIFYING MANIFEST REHEARSAL` |
| Total cases | 16,040 |
| Deterministic cases | 40 |
| Randomized cases | 16,000 |
| Unique case IDs | 16,040 |
| Unique truth commitments | 16,040 |
| Commitments JSONL size | 23,409,631 bytes |
| Bound | 67,108,864 bytes |
| Generation time | 1.768 seconds |

The qualifying run count is therefore exactly:

`4 targets × 10 families × (1 deterministic + 400 randomized) = 16,040 independent runs`

At 400/400 successes, the one-sided Wilson 95% lower limit is approximately 0.9933. Under the frozen `≥0.99` rule, one failure is expected to fail the statistical criterion; results must not be tuned after inspection.

## Source hashes at verification

| File | SHA-256 |
|---|---|
| `src/server/syntheticQualificationCampaign.ts` | `be860f634f9deedccff3441769f24c0ecd0506c31148e676dff664631f1106cb` |
| `src/server/syntheticQualificationCampaignCli.ts` | `fbb759a2188aaedb6b9da4b483f8c3af53743a974522fcef55d11f9770a82576` |
| `src/server/syntheticQualificationRunner.ts` | `876406677df97b0c229c624c2e2a4ecd3a3a586a51e9a38a3220885f1b62ba71` |
| `src/server/syntheticValidation.ts` | `e9b6e73f11cf365e8544e3ccf0c9f277fe4c99d50bb672fd367da8c51429f948` |
| `src/shared/detectorQualification.ts` | `c8be174560e10f5772f734a55b243e57b370300a88833c76c4cd4e7a270524a9` |
| `src/shared/syntheticValidation.ts` | `d89eecb3b99cd6267fe012ae7aef27c49e96407360c0e68b2672fce7bdcd2246` |
| `tests/syntheticQualificationCampaign.test.ts` | `e6b55d3168a033a64701a301ec234c680836a5dcff1c86ab2923fef6b35c7a5a` |
| `scripts/build-server.mjs` | `166172f3b89dc747b7eddaac36249c2f034e9f452a7c3edbef3974bd20a8c456` |
| `scripts/generate-release-metadata.mjs` | `eb5d33f6b509bddc3d968bbb0dc011c9ce410e63f9c7c089f1f3609ddd9208ac` |
| `scripts/release-digest-policy.mjs` | `79933a45aa0edf3cd7d0354e7d66a0f76fd7ad51bea7ec0fc57c70fd38859fb6` |
| `package.json` | `aae847eb0bbb67008132b71db3404a51ada7992ecde74f4ce5b78543a2c531df` |

These hashes describe the infrastructure check only. The later qualifying campaign must record the final rebuilt candidate's source, package, dependency lock, catalog, configuration, detector, baseline, plan, scenario, and commitment hashes.
