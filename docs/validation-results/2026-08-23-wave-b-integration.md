# Wave B Integration Gate

**Date:** 2026-08-23  
**Scope:** `SCH-110`, `DET-200`, `DET-201`, `DET-202`, and `DET-210` software integration  
**Result:** PASS — software evidence only

> **Contract supersession:** This Wave B result remains historical evidence.
> The former statement that a 72-hour soak or 30-day pilot was a separate
> production requirement is superseded. Required qualification ends at V7 and
> no required run exceeds 24 hours.

The combined Wave B gate passed after the scheduler, persistent baseline, detector, browser presentation, and qualification-scenario changes were present in the same working tree.

```text
/usr/bin/npm exec -- tsc --noEmit
/usr/bin/npm exec -- vitest run \
  tests/deadlineScheduler.test.ts \
  tests/detection.test.ts \
  tests/baselineStore.test.ts \
  tests/monitorService.test.ts \
  tests/operatorSummary.test.ts \
  tests/dataDomains.test.ts \
  tests/detectorPresentation.test.ts \
  tests/detectorQualificationPlan.test.ts \
  tests/liveSyntheticExercise.test.ts \
  tests/syntheticQualificationRunner.test.ts \
  tests/syntheticValidation.test.ts \
  tests/syntheticValidationApi.test.ts

TypeScript: PASS
Test Files: 12 passed (12)
Tests: 151 passed (151)
Duration: 42.10 seconds
```

The qualification target list is derived from the active validated catalog and exactly matches its four default Tier-1 physical capture targets. Unknown or ineligible visits cannot train, vote clean, clear, or advance valid-completion revisit timing. Detector anomaly ranges and analyzed frequency bounds are authoritative server output; the client does not infer them.

This result does not pass `V2`, `V4`, `V5`, `V6`, `V7`, or any installed-site gate. The randomized campaign, held-out replay, real RSPdx timing, installed RF-chain characterization, protected baseline, and bounded 24-hour V7 timing run remain separate requirements. Optional V8/V9 site records do not block development or production readiness.

Related evidence:

- `docs/validation-results/2026-08-23-sch-110.md`
- `docs/validation-results/2026-08-23-wave-b-detector-baseline.md`
- `docs/validation-results/2026-08-23-wave-b-detector-scenarios.md`
