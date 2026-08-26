# V0 claims and traceability infrastructure — 2026-08-23

> Scope update: this historical record predates the bounded qualification contract. The current development ladder is V0–V7 only, and no required run may exceed 24 elapsed hours.

## Result

**Infrastructure evidence ready; final-candidate V0 not passed.**

The mechanically validated matrix is `config/qualification-traceability.json`. It is an unbound source registry: it never embeds its own source/package digest. The built checker binds that unchanged registry to externally generated `dist/release.json` metadata and recomputes the source, package, dependency-lock, and packaged-client identities.

Current gate state is deliberately fail-closed:

- V0: Evidence ready. A later immutable final-candidate record must bind and pass it.
- V1–V4: Not run for the final candidate.
- V5–V9: Not run and externally blocked. No held-out corpus, witnessed conducted-RF result, installed 24/72-hour record, managed-switch record, restore drill, or 30-day pilot result exists.
- Production ready: No.

## Mechanical coverage

| Category | Rows |
|---|---:|
| Roadmap deliverables | 31 |
| Product/truth/runtime invariants | 15 |
| Hardware invariants | 8 |
| Service objectives | 24 |
| Resource bounds | 20 |
| Prohibited RF claims | 7 |
| Qualification gates | 10 |
| Risks | 10 |
| Evidence/test/document references | 56 |
| Total requirements | 115 |

Coverage is checked against an independent ID registry. Roadmap deliverable and V0–V9 IDs are also extracted from the roadmap, so deleting a row from the matrix cannot redefine the expected count.

## Fail-closed controls

- Passed or Evidence-ready source rows require a current evidence record and at least one bounded `assertionRefs` entry. That entry must name an automated test already listed by the row, and its source must contain the row's exact `[trace:REQUIREMENT-ID]` marker in a direct literal Vitest `it(...)` or `test(...)` title.
- Marker extraction fails closed for comments, regex literals, member calls, dynamic titles, `.skip`, `.only`, `.todo`, and `.each`; an unrelated test filename cannot satisfy a completed row.
- Every immutable artifact declares build, source, and package digests; the CLI verifies those values against the artifact contents.
- Immutable artifacts referenced by the source registry are always historical. Candidate pass state belongs only in an outer immutable qualification bundle.
- Candidate-bound validation verifies `dist/release.json` against freshly recomputed source/package/lock digests and the single embedded browser build ID. This avoids an impossible in-matrix digest fixed point.
- V5–V9 cannot move out of Not-run/Blocked without changing the external-evidence contract and supplying real evidence.
- Concrete references must be bounded regular files inside the repository; symlinks and path escapes are rejected.
- SLO and resource rows require machine-readable comparator, value, unit, and optional window fields.
- Release source identity now includes the tests and TypeScript/Vite/Vitest build inputs used to make claims.
- The future V1 command sequence builds first, validates V0 through the bundled CLI under `/usr/bin/node`, and records the validation output with the final source/package identity.

## Verification

The focused checks cover valid real-tree evaluation, exact category/ID parity, executable product-contract parity, exact requirement-to-test markers, unrelated-test rejection, parser fail-closed cases, external release binding, release/V1 integration, matrix truncation, malformed limits, stale artifact identity, source/package tampering, unsupported completion, external-gate promotion, symlinks, risk deletion, and historical-only evidence.

Runtime: `/usr/bin/node` v24.19.0.

```text
/usr/bin/node node_modules/typescript/bin/tsc --noEmit
```

Result: exit 0.

```text
/usr/bin/npm exec -- vitest run \
  tests/traceability.test.ts tests/productContract.test.ts \
  tests/releaseIdentity.test.ts tests/releasePackage.test.ts \
  tests/dataDomains.test.ts tests/baselineStore.test.ts \
  tests/sdrconnectClient.test.ts tests/deadlineScheduler.test.ts \
  tests/detection.test.ts tests/detectorPresentation.test.ts \
  tests/detectorQualificationPlan.test.ts tests/operatorSummary.test.ts \
  tests/liveProtocol.test.ts tests/resourceBudget.test.ts \
  tests/liveSubscription.test.ts
```

Result after schema-v2 assertion mapping: 15 files, 180 tests passed, 0 failed, 0 skipped. TypeScript exited 0. The V0 file includes exact-marker, unrelated-reference, member-call, skipped/focused/todo/parameterized, comment, regex, dynamic-title, external-gate, release-binding, and tamper rejection cases.

```text
/usr/bin/node scripts/build-server.mjs
/usr/bin/npm run validate:v0
```

The commands above describe the final-candidate packaged gate. They were not rerun for the moving schema-v2 tree in this focused source check. V0 remains Evidence ready, not passed, until the frozen candidate build regenerates release metadata and this packaged command succeeds under `/usr/bin/node`.

## Candidate hashes

Source/package hashes are deliberately not restated while the release tree is moving. The frozen V0/V1 run must generate them from the final candidate and bind them in its immutable outer record.

## Qualification limits

This record verifies the V0 mapping infrastructure only. It does not execute the V4 campaign, replay real receiver data, exercise installed hardware, qualify the antenna/RF chain, measure real revisit performance, run the 72-hour resource soak, validate managed-switch counters, prove backup/restore, or complete the controlled pilot.
