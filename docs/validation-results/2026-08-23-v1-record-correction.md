# V1 record correction

The immutable Wave A record at `artifacts/validation/v1/20260823T102701448Z-1.0.0+ff352d02db7d` passed every command and its `SHA256SUMS` verifies. Its Vitest result contains 378 passed tests, zero failed tests, and zero skipped tests.

The record is not the final release-candidate V1 evidence because its `testFiles` fields were derived from Vitest's `num*TestSuites` counters. Those counters describe nested suites, not files. The source reporter contains 46 file results and 109 nested suites; the record mislabeled 109 suites as 109 files.

`scripts/generate-v1-validation-record.mjs` now derives file counts from the bounded `testResults` list, reports nested suites separately, and fails closed when per-file results are absent or malformed. A new immutable V1 record is required after the development waves freeze. The historical record is retained unchanged.
