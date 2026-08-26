# V6 Conducted-RF Qualification Framework

Date: 2026-08-23

Gate status: **V6 not run**

No calibrated, independently witnessed conducted-RF campaign for an exact installed RSPdx or RSPdx R2 chain was supplied. No V6 qualification evidence or PASS result was created.

## Implemented infrastructure

- fail-closed exact frozen-candidate and gate-specific V0-V5 PASS wrapper/source binding; generic pass-shaped JSON is rejected;
- separate approved site/receiver/serial/chain/SDRconnect/gain/grid/mask/baseline binding;
- exact four-target, nine-kind, ten-independent-run matrix (360 cases);
- real normalized uint8 acquisition records in an isolated test domain, with IQ/replay/simulation/radiated inputs rejected;
- in-date calibrated equipment certificate binding for generator, reference, and attenuation path;
- independent Ed25519 protocol commitment before first exposure and final whole-tree/result signature after last exposure;
- separately pinned Ed25519 V5 replay-verifier receipt bound to exact V5 bundle/report/configuration/release/original-witness hashes, with verifier identity/key distinct from every V6 role;
- no-symlink, read-only, declared-file-only campaign custody with strict file/count/byte bounds;
- mechanical target/range/frequency, alert, overload-separation, guard, sham, and Unknown scoring;
- atomic hidden-partial, fsynced, no-overwrite result bundles and a bundle verifier;
- tested-envelope and uncertainty reporting without sensitivity, field-dBm, spoofing, intent, or navigation-integrity inference.

## Framework verification

Command:

```bash
npx vitest run tests/v6ConductedRfQualification.test.ts
npx tsc --noEmit
```

Result at implementation handoff: 13 focused tests passed and the whole-tree TypeScript check passed. The root release gate will rerun both after the candidate is frozen.

The tests use clearly named structural framework fixtures. They exercise parser, binding, scoring, signature, custody, and output behavior. They are not physical RF evidence and cannot advance V6.

Attack/failure coverage includes wrong key, stale candidate/configuration/prerequisite/chain, a fully rehashed and re-signed generic PASS stub, a rehashed V5 verification receipt signed by an unpinned key, expired calibration, symlink, post-seal mutation, incomplete matrix, Unknown-as-clean, guard/sham alert, overload mislabelling, radiated/IQ/simulation/replay/field-domain violations, and output overwrite.

## Remaining external work

An authorized RF laboratory must create the exact installed-chain campaign described in [V6 Installed-Chain Conducted Qualification](../v6-installed-chain-qualification.md). The external custodian and witness must review the physical setup and evidence. Only the immutable artifact produced from that campaign can change V6 from not run.
