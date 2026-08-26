# V2 Packaged Process And Storage Qualification

> Scope update: the current development ladder is V0–V7 only, and no required run may exceed 24 elapsed hours. Later-gate references below are historical context, not blockers.

Status: **Passed for candidate `1.0.0+c47dca84f3d3` only**.

This is V2 packaged-software evidence. `productionQualified` is explicitly
`false`. Any source change after this candidate, including this result-record
update, requires a new build and a complete V2 rerun before promoting a later
candidate.

## Scope

The bounded harness in
`scripts/run-v2-process-storage-qualification.mjs` runs the built
`dist/server-node/index.js` with `/usr/bin/node`, a loopback fake SDRconnect,
real HTTP/WebSocket clients, and separate temporary field/test roots. It arms
one crash only after the packaged service reaches the intended boundary.

Covered `SIGKILL` points:

1. raw spectrum bytes appended, index not appended;
2. spectrum index appended, session checkpoint not refreshed;
3. rotation Finalizing checkpoint persisted, replacement not created;
4. replacement session created, old-session finalizer not scheduled;
5. finalization commit before atomic rename; and
6. finalization commit renamed, parent directory not yet fsynced.

After each crash the harness first verifies that every on-disk session already
labelled Complete passes the offline verifier. It then restarts the same built
package, receives a real live WebSocket frame, stops cleanly, and invokes the
built verifier twice for every recovered session. It rejects a false Complete
label, any post-recovery verifier `FAIL`, nondeterministic verification,
field/test cross-mutation, stale-frequency marker attribution, or a resource-
bound breach.

## Focused implementation checks

```text
/usr/bin/node --check scripts/run-v2-process-storage-qualification.mjs
npx vitest run tests/evidenceLifecycle.test.ts tests/evidenceStore.test.ts
npx vitest run tests/v2ProcessFaultGuard.test.ts
```

Observed results:

```text
evidence lifecycle/store: 2 files passed, 52 tests passed
V2 process-fault guard:    1 file passed, 3 tests passed
```

The first packaged run used build `1.0.0+56bb646cf489`. The release validator
then proved that source changed while that build was being exercised, so that
run was superseded and is not the V2 result.

## Candidate-bound packaged result

```text
npm run build
npm run validate:release
npm run validate:v2
npm run validate:release
```

Candidate identity:

```text
releaseVersion:        1.0.0
buildId:               1.0.0+c47dca84f3d3
sourceDigest:          c47dca84f3d37f8bc367788d41521eba45fed0b57015f671e7e9f452c260cef8
packageDigest:         43203593beb292d32209443f94b3dc5017bab420b3979633be84b81f4fee7fa5
dependencyLockDigest:  b795064f67bdf0b4985f05d6933e145b606ca22eee8ee907357555de655ef6a4
Node:                  /usr/bin/node v24.19.0
OS:                    Linux x64 7.0.0-30-generic
```

Observed packaged matrix:

```text
V2 frame-after-raw-append ................ PASS
V2 frame-after-index-append .............. PASS
V2 rotation-after-finalizing-checkpoint .. PASS
V2 rotation-after-next-session ........... PASS
V2 finalization-rename ................... PASS
V2 finalization-fsync .................... PASS
```

Across the six runs:

- every injected process exit was `SIGKILL`;
- every Complete crash-state session already passed the built verifier;
- all 15 recovered sessions returned `PASS` or explicit `INCOMPLETE`, never
  `FAIL`, on two identical verifier runs;
- 11 persisted frames matched target, requested center, confirmed center, and
  raw frequency marker; attribution mismatches were zero after 35 deliberately
  stale frames;
- every test-domain tree hash remained byte-identical before crash, after
  crash, and after recovery;
- false Complete labels were zero;
- maximum RSS was 113,659,904 bytes and the one-receiver packed ring maximum
  was 2,560 bytes; observed writer and client queues remained empty at sampled
  boundaries; and
- the health response, writer, dashboard, client-queue, ring, and hard-memory
  checks stayed within their declared limits.

Authoritative artifact:

```text
artifacts/validation/v2/20260823T132122615Z-1.0.0+c47dca84f3d3/qualification.json
```

For a later frozen candidate, rerun:

```bash
npm run build
npm run validate:release
npm run validate:v2
```

Physical power-loss, installed-chain, V5-V9, and production qualification
remain unpassed.
