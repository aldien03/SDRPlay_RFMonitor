# V5 held-out replay framework — infrastructure only

> Scope update: the current development ladder is V0–V7 only, and no required run may exceed 24 elapsed hours. Later-gate references below are historical context, not blockers.

Date: 2026-08-23

Status: **framework verified; V5 not run**.

No independently acquired and sealed real normalized-uint8 FFT corpus was available. This record is not a replay result, does not satisfy V5, and is not evidence that the detector performs at any field sensitivity or false-alert rate.

## Implemented controls

- Exact frozen release, configuration, catalog, detector version, full threshold object, rule hash, four Tier-1 targets, and ten held-out family bindings.
- Exact receiver model and serial hash, SDRconnect version, 10 MS/s read-back, native FFT grid, central analysis mask, display reference/base, antenna/gain, protected-baseline fingerprint/generation, and catalog/rule provenance.
- Three distinct hashed corpus-custody roles plus a separately pinned external Ed25519 witness key; the witness authenticates the exact precommitment digest and not-before-unblinding statement. This does not let software prove the physical truth of the attestations.
- Predeclared criteria and session IDs, at least 30 independent sessions per target/family, independently committed truth disclosures, tested-envelope metadata, and no holdout threshold mutation.
- Real normalized uint8 field acquisitions only. Synthetic, simulation, replay, IQ, raw-serial, test-domain, and mixed-source session metadata is rejected.
- Bounded file/session/observation/bin/byte counts, safe relative paths, `O_NOFOLLOW` regular-file reads, exact file/tree hashes, per-use descriptor/truth/index/baseline/FFT hash checks, before/after corpus verification, and protected-field-tree isolation.
- Fresh isolated `DetectionEngine` state per independent session, exact immutable protected reference arrays, training frozen, and deterministic scoring.
- Per-session and per-target/family results; detection and alert-free one-sided 95% Wilson limits; at least 30 evaluable independent sessions required for Alert/No alert criteria; Unknown and Unobserved kept separate; observed and unobserved alert latency separated.
- Bounded, exclusive result bundles published from a unique hidden partial directory by fsync and rename; existing final names are never overwritten. Every bundle remains `productionReady: false`; V6–V9 stay separate.
- Result review has two levels: hash/schema integrity and a stronger independent replay against the sealed corpus. A self-consistent edited result cannot pass the stronger check.

## Verification run

The automated tests use clearly labelled, temporary framework fixtures. They do not represent real RF acquisitions and are never written to the validation-artifact tree.

```bash
/usr/bin/node node_modules/vitest/vitest.mjs run tests/v5HeldOutReplay.test.ts --reporter=verbose
```

Verified cases:

- complete 1,200-session target/family matrix and deterministic rerun;
- detected, alert-free, expected-Unknown, and Unobserved accounting;
- one-sided Wilson criterion calculation;
- changed detector thresholds fail before replay;
- missing/wrong external witness keys fail before replay;
- Unknown/Unobserved sessions cannot satisfy the minimum evaluable count;
- protected field paths through symlinked parent components are rejected;
- existing result bundles are not overwritten and failed publication leaves no final-named partial bundle;
- a fully resealed session that claims simulated/test input is rejected;
- byte tampering and symbolic-link substitution are rejected;
- a self-consistent forged result is rejected when the sealed corpus is independently replayed;
- protected field bytes remain unchanged;
- output says production is not ready.

## External blockers

V5 remains `not-run` until an independent custodian supplies a complete sealed corpus and precommitment bound to the final frozen release candidate. V6 remains `not-run` until the unchanged candidate is exercised through the final installed RF chain with calibrated, witnessed conducted-RF evidence.

Do not change V5 traceability status from `not-run` because this infrastructure test passes.
