# Wave C EVD-300 / EVD-310 software validation

Recorded: `2026-08-23T12:32:51Z`

Result: **software evidence and bounded backup/restore tooling ready; approved off-host media, witnessed site restore, and real power-loss qualification not established**.

## Implemented contract

- Manifest-v2 sessions have an authoritative `Active → Finalizing → Complete | Incomplete | Corrupt` lifecycle. The legacy `recording`/`closed` field remains a visibly non-authoritative compatibility alias.
- A session cannot become `Complete` until evidence data is synced, `session-final.json`, `manifest.json`, and `SHA256SUMS.txt` are written, and a self-hashed `finalization.json` descriptor is atomically renamed and its directory synced.
- The finalizer has one worker and a hard eight-item queue. Queue saturation and hash/write/rename/fsync failures leave an explicit `Incomplete` or `Corrupt` disposition and bounded finalizer health; failures are not detached or suppressed.
- Startup recovery resumes an uncommitted `Finalizing` session and reconciles a committed descriptor. Historical startup checks hash only bounded manifest/checksum metadata and inspect the final descriptor; they never re-hash archived payloads. Full verification remains a separately timestamped `not-run`, `pass`, `incomplete`, or `fail` result.
- The standalone verifier deterministically returns `PASS`, `INCOMPLETE`, or `FAIL` for manifest v1, manifest v2, and extracted multipart sets. Full verification runs before export; detected payload corruption is persisted as `Corrupt` and refused thereafter.
- Incident exports contain the incident time slice, retain cross-session lineage and named gaps, use ZIP store mode and `.partial` publication, and split without truncation. Manifest-v2 multipart metadata commits every file's streamed size/hash plus one reconstruction hash. Missing parts are `INCOMPLETE`; duplicates or changed parts are `FAIL`.
- `Corrupt` and `Finalizing` sources have stable export refusal codes. An `Incomplete` incident remains exportable only with its source/recovery gaps in the manifest and completeness record.
- `/api/health.evidence.archive` exposes finalizer queue/counters, archive issue counts, and full-verification status. Historical `Incomplete`/`Corrupt` data creates one Recording action at Attention; it does not turn a healthy active recording into Stopped/Error.
- The production verifier is bundled at `dist/server-node/evidence-verifier.js`. `npm run verify:evidence` and `rf-monitor verify-evidence` use the system Node runtime and do not require `tsx`, TypeScript, or other development dependencies. The administration command accepts only explicit existing absolute non-symlink directories.
- Protected **Delete recordings** requires an unlocked Settings session, CSRF header, exact configuration revision, exact `DELETE RECORDINGS` confirmation, and the explicit active `field` or `test` domain. It deletes finalized sessions only. Active, finalizing, export-leased sessions, exported ZIPs, settings, baselines, and the other domain remain.
- Recording deletion uses a bounded prepared/committed/audited journal and same-filesystem quarantine renames. A pre-commit failure rolls back; a committed interrupted cleanup finishes on startup. Results report exact deleted sessions/bytes and every retained class. The protected Settings audit and bounded domain deletion audit remain durable.
- The standalone backup workflow accepts only explicit absolute, non-symlink source/destination paths. It requires both Field and Test domain markers and an offline source lease state, copies only regular files, rechecks source hashes after copying, verifies embedded manifest-v1/v2 evidence, and refuses corrupt or unfinalized sessions.
- Backup publication is a same-destination `.partial` directory followed by file/directory sync and atomic rename. Owned partial descriptors ensure `--recover` never removes an unrecognised path. No-follow file opens reject symlink substitution. A manifest and `SHA256SUMS.txt` commit every file, byte count, SHA-256, evidence result, domain, and exclusion. `INCOMPLETE` evidence remains explicitly incomplete. Published IDs are immutable and identical repeats are idempotent.
- Settings credentials, environment files, password/secret/private-key names, and non-allowlisted configuration files are excluded and counted separately. The package includes both data domains plus allowed operational profile, revisions, baseline, qualification, catalog, and configuration-audit files. Secrets require a separate encrypted custody system.
- Restore first verifies the entire package, capacity, and both domain markers; then reconstructs only an absent, explicit staging root through a sibling `.partial` and atomic rename. It never merges with or overwrites an active installation/evidence tree. The durable restore descriptor records the exact result and source commitments.
- `create`, `verify`, `restore`, and backup-ID `status` are bundled in `dist/server-node/evidence-backup.js` and exposed by `deploy/rf-monitor-backup.sh` under system Node. Dry-run checks source integrity and capacity without deleting an owned partial; `--recover` reports pending versus actually recovered partials separately. The default free-space reserve is 5 GiB. The audit is bounded at 2 MiB.

## Verification evidence

Commands run from the repository root:

```text
npx tsc --noEmit
npx vitest run tests/evidenceLifecycle.test.ts tests/evidenceStore.test.ts tests/exportJobQueue.test.ts tests/recordingsDeleteApi.test.ts tests/healthApi.test.ts tests/diagnosticsCollector.test.ts tests/evidenceArchivePresentation.test.ts --reporter=verbose
npx vitest run tests/evidenceBackup.test.ts tests/evidenceLifecycle.test.ts tests/evidenceStore.test.ts tests/exportJobQueue.test.ts tests/recordingsDeleteApi.test.ts tests/healthApi.test.ts tests/diagnosticsCollector.test.ts tests/evidenceArchivePresentation.test.ts --reporter=dot
npm run build:server
bash -n deploy/rf-monitor-backup.sh
```

Production-runtime verifier and backup check:

1. Copied `package.json`, `package-lock.json`, and the bundled verifier into an isolated directory.
2. Ran `/usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund`.
3. Confirmed `tsx`, TypeScript, and esbuild were absent.
4. Ran `/usr/bin/npm run --silent verify:evidence -- /absolute/fixture`; result: `PASS`.
5. Copied the bundled backup CLI and standalone wrapper into a separate omit-dev runtime; its `status` command returned the stable missing-backup result without dev tools.
6. In that isolated runtime, created an empty-domain fixture, ran `create --dry-run`, `create`, `verify`, and `restore`, and confirmed both domain markers plus operational configuration were reconstructed under a new bare root.
7. Ran `rf-monitor verify-evidence` through `deploy/rf-monitorctl.sh`; an absolute fixture passed and a relative path was rejected with exit status 2.

Results:

```text
TypeScript: PASS
Evidence/export/API/backup test files: 8 passed
Evidence/export/API/backup tests: 84 passed, 0 failed, 0 skipped
Built verifier in omit-dev runtime: PASS
Built backup create/verify/restore in omit-dev runtime: PASS
Standalone backup wrapper syntax/runtime: PASS
rf-monitorctl verifier routing/path validation: PASS
```

Deployment handoff: the standalone `/opt/rf-monitor/active/deploy/rf-monitor-backup.sh` interface is complete and documented. The concurrently edited `rf-monitorctl` has not been changed by this EVD work. After DEP integration settles, its optional `backup` case should require root and delegate least-privilege execution as:

```bash
exec runuser -u "${SERVICE_USER}" -- env \
  RFMON_INSTALL_DIR="${INSTALL_DIR}" \
  "${INSTALL_DIR}/deploy/rf-monitor-backup.sh" "$@"
```

The standalone command remains the validated interface even if that convenience route is deferred.

The automated matrix covers finalizer hash/write/rename/fsync faults, restart from `Finalizing`, queue saturation, stale payload detection, legacy-v1 outcomes, immutable export IDs, interrupted `.partial` cleanup, recovered incomplete incident gaps, cross-session incident slicing, multipart extraction/reconstruction and missing-part behavior, writer/export leases, retention holds, explicit disk reserve, protected deletion session/revision/domain checks, cross-domain preservation, deletion rollback, committed deletion recovery, backup manifest-v1/v2 verification, explicit incomplete/corrupt outcomes, source preservation and secret exclusion, torn backup/restore publication, symlink/path escape, insufficient capacity, idempotency, live-lease refusal, and empty-root reconstruction.

Key artifact SHA-256 values at validation time:

```text
8f457971d8fbe692436756346b341946e5dac69f596b642609f332db0af64a7f  src/server/evidenceStore.ts
e3de03c7e3aae3194e9f19a685815fe0369fa3cd35cfb4d18913ad42f73c62b1  src/server/evidenceVerifier.ts
077b469ab5f339975d76fbeb68f7afa50102f8fecb36a3637078c98a4f451805  src/server/evidenceVerifierCli.ts
db65564e31841a00f77751c5be82536b6aa767a377423fdeadd69f5836f4cc6e  src/server/evidenceBackup.ts
149dc3383e05067be9df6f9021dd14772db34cc004d26cf3215c7d6131037125  src/server/evidenceBackupCli.ts
4a1e51c3395f2dd0e03f7e33e178af92825f7b3ea0a4e534ab93c9b2d97ed853  src/server/index.ts
594d59e65483dc25bfa97f0ea80ed9f3131e00c06c3b8ad8fe53729e957146ff  src/shared/types.ts
140dca725761e8787dfe6ca01d7a845d5caec382c8dc8e987cd27968a4c97e8d  deploy/rf-monitorctl.sh
3feb542e42706b15bf70cffc3527d72515bb730328587445ecff362c88c338ab  deploy/rf-monitor-backup.sh
02e532127d6aef180b7e2a35afd83269ac40db69fea00aafc65079ebf94d9545  tests/evidenceBackup.test.ts
63cf43e9ab26257bc121ed0da92b955d9a031e497f0d70a893b08ab74504ce92  package.json
843830f185201a4aa1130a1d0dda26eced7873f9aecd44fae1f9ba6811e24e73  scripts/build-server.mjs
```

## Unproven EVD-310 and operational requirements

> **Contract supersession:** This evidence result remains historical evidence.
> References that made V8 or a 72-hour observation a prerequisite for EVD-310,
> development completion, or production readiness are superseded. Required
> qualification ends at V7 and no required run exceeds 24 hours.

- No real power cut, kernel crash, filesystem error, disk removal, or storage-controller cache-loss test was performed. Fault injection validates software state transitions, not physical durability under every filesystem/hardware failure.
- No approved encrypted off-host repository was connected. The bounded copy/verify tool passed isolated local filesystems, but backup age, remote transfer monitoring, custody, media removal, and independent repository failure were not exercised or proven.
- No witnessed bare-host restore was performed. The tool reconstructed both domain roots and allowed configuration under an empty local fixture root, but that is not evidence of reinstalling a host, restoring separately encrypted secrets, reconnecting the RSPdx, meeting a four-hour recovery target, or satisfying an approved recovery-point objective.
- No production-size 2 GiB/24-hour long-incident reconstruction, real 256 MiB multipart transfer, concurrent 5 MiB/s download, or final installed V7 alert/export load interval was run here. Automated tests use bounded smaller fixtures.
- No evidence priority, disk latency, RSS slope, NIC/switch counter, or recovery timing claim is made from these tests. Those remain bounded Wave E and V7 work on one frozen release and the real storage/network stack.
- A successful local verifier result proves internal hash/lifecycle consistency of that copy. It does not prove external custody, original host trust, absolute RF calibration, navigation integrity, or deliberate jamming intent.

Accordingly, `EVD-300` and the local software/export/backup portion of `EVD-310` have evidence. `EVD-310` is not Passed until an approved remote destination, scheduled transfer monitoring, and measured witnessed bare-host restore drills succeed on the deployed site within the bounded Wave E/V0-V7 acceptance scope.
