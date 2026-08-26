# V9 controlled-pilot infrastructure record — 2026-08-23

> Superseded scope: V9 is outside the development goal and command surface. V0–V7 are the complete required ladder, and no required run may exceed 24 elapsed hours. The pilot mechanics below are retained only as historical provenance.

Result: **tooling and contract tests passed; V9 itself is Not run**

Implemented software infrastructure:

- exact candidate, configuration, catalog, detector/rule, site, receiver, installed-chain, commissioning-epoch, runtime, and mechanically checked V0–V8 witnessed prerequisite-envelope/source bindings;
- required out-of-band pin-record, binding, approval-witness SPKI, and prerequisite-witness SPKI SHA-256 comparisons at initialization, full status, evaluation, finalization, and final verification;
- 30 complete real UTC days plus monotonic-time enforcement, with no acceleration or missing-day merge;
- exclusive atomic daily files, serialized mutations, two independent SHA-256 chains, bounded retained crash tails, restart recovery, immutable chained evaluation attempts, and a last-written final commit;
- signed daily custody summaries backed by six distinct verified source artifacts, completed-incident evidence, and verified operational proof artifacts;
- explicit unknown/outage accounting, a 12-hour maintenance exclusion cap, service/RF availability, Tier-1 coverage, incident/evidence continuity, fixed five-minute resource sampling, full/seven-day/final-48-hour RSS slope checks, heap/external slope and pressure limits, and queue limits;
- five-operator task-specific acceptance, keyboard tasks, no-developer scoring, weekly backup checks, restore proof, and isolated restart-recovery proof;
- a separate Ed25519 external-witness approval with four approval roles, independent identities, exact latest-evaluation and pin-receipt binding, and no-shortening attestation;
- one aggregate 4 GiB evidence-verification budget and sequential bounded checksum hashing;
- a read-only `verify-final` path that requires fresh anchors and verifies exact files, every deterministic evaluation, the signed approval, report, checksum manifest, and final commit. It is the only pass-consumption path.

Focused automated tests (22/22 passing) cover signed restart recovery, stale/mismatched bindings, late initialization/future prerequisites, future/shortened days, symlink and digest attacks, raw-source mutation, post-collection evidence corruption, blocking retained atomic tails, missing days, strict restart/evidence/developer failures, unknown and disjoint-maintenance accounting, day-31 incident closure, first-window dilution resistance, exact final-48-hour RSS slope, day-32 queue failure, repeated-operator masking, operator/proof/resource criteria, independent approval, pre/post-init attacker-key substitution, rehashed PASS-stub rejection, exact-schema evaluation rejection, final-bundle missing/extra/symlink/tamper/self-rewrite/substituted-anchor attacks, repeat finalization, and journal tampering. TypeScript compilation and the focused V9 contract pass.

Signatures attest possession of the pinned keys and custody of exact bytes. They do not establish a signer’s real-world identity, independence, or physical-source truth by themselves. The external authority receipt and witnessed out-of-band comparison remain required operational evidence.

No 30-day pilot data, daily external custody signature, representative-operator record, site backup/restore/restart proof, independent witness approval, or V9 final report exists in this repository. This record must never be cited as a V9 pass. Simulation and compressed clocks cannot satisfy the gate. `productionReady` remains false even in the final V9 report until the separate site qualification approval is installed.
