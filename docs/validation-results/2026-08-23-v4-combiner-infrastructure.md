# V4 overall combiner and verifier infrastructure — 2026-08-23

## Result

**Implementation and adversarial software tests passed. Overall V4 was not run.**

The new `validate:v4` command can publish overall V4 `PASS` only from two
already-complete immutable sub-gate bundles:

1. the packaged scheduler/detector/recovery/evidence/live-control result; and
2. the complete 16,040-case conditional detector result.

The command does not run either sub-gate. No V4 pass artifact was created by
this infrastructure check.

## Fail-closed binding

- Both nested bundle verifiers run independently before copying, after copying,
  while verifying the staged overall bundle, and after publication.
- Both sub-gates must bind the same release, source, package, dependency lock,
  client build, four Tier-1 targets, catalog, and detector rule.
- Packaged V4 now preflights the exact validated operational configuration and
  records its configuration hash, catalog hash/version, detector rule hash/ID,
  client build, and 10 MS/s expectation before any scenario executes. The same
  runtime identity must remain loaded after all cases.
- Legacy packaged V4 bundles without that explicit loaded-configuration binding
  fail as `packaged-config-binding-missing`; the combiner never infers or
  retroactively supplies the missing hash.
- The current candidate/configuration and both source bundles are re-read before
  publication. Any drift produces `V4 NOT RUN` and no overall result.
- The overall bundle contains exact copies of both sub-gate trees. One outer
  `SHA256SUMS` covers every nested and top-level file. Nested checksum and
  semantic verification remain mandatory.
- Publication uses a serialized hidden partial directory, synced files and
  directories, a no-overwrite result ID, atomic directory rename, and read-only
  final permissions.

## Verification

```text
/usr/bin/node node_modules/vitest/vitest.mjs run \
  tests/syntheticQualificationCampaign.test.ts \
  tests/syntheticQualificationRunner.test.ts \
  tests/v4PackagedQualification.test.ts \
  tests/v4QualificationCombiner.test.ts \
  tests/v6ConductedRfQualification.test.ts \
  tests/releasePackage.test.ts --reporter=dot

Test files  6 passed (6)
Tests       40 passed (40)
```

The combiner-specific suite includes help and unknown-argument handling,
complete publication and verification, immutable no-overwrite behavior,
missing configuration binding, candidate/client/configuration/catalog/detector
mismatches, source drift immediately before publication, nested-file tampering,
unexpected files, linked artifacts, and a self-consistently rehashed false
production-ready result.

Additional checks:

```text
/usr/bin/node node_modules/typescript/bin/tsc --noEmit                   PASS
/usr/bin/node --check scripts/run-v4-packaged-qualification.mjs        PASS
/usr/bin/node scripts/build-server.mjs                                  PASS
/usr/bin/node dist/server-node/v4-combine-qualification.js --help       PASS
/usr/bin/node dist/server-node/v4-combine-qualification.js verify \
  --unknown value                                                       FAIL CLOSED
```

The packaged command is:

```text
npm run validate:v4 -- combine \
  --packaged-bundle /path/to/exact-packaged-v4-bundle \
  --detector-bundle /path/to/exact-16040-case-v4-bundle \
  --catalog /path/to/exact-catalog.json \
  --operational /path/to/exact-operational.json
```

An existing overall bundle is checked with:

```text
npm run validate:v4 -- verify --bundle /path/to/combined-v4-bundle
```

## Scope limit

V4 remains generated normalized-FFT test-domain software evidence. It cannot
qualify live RSPdx/RSPdx R2 data, SDRconnect, an antenna or installed RF chain,
field baselines, or a production site. Simulation cannot satisfy live
field-domain V5, V6, or the bounded 24-hour V7 gate, and V4 alone can never make
the software production-ready.
