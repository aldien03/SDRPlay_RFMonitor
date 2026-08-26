# DEP-600 immutable deployment — 2026-08-23

## Result

**Software fixture evidence complete; DEP-600 remains In progress.**

The implementation provides a fail-closed deployment path for one built
candidate, but no installed-host acceptance is claimed.

> **Contract supersession:** This fixture result remains historical evidence.
> Any former implication that V8 or a 72-hour observation blocked DEP-600,
> development completion, or production readiness is superseded. Required
> qualification ends at V7 and no required run exceeds 24 hours.

## Implemented contract

- Production dependencies use only `/usr/bin/npm ci --omit=dev
  --ignore-scripts --no-audit --fund=false`. Source, package, and lock digests
  must match `dist/release.json` before staging.
- SPDX SBOM and production `npm audit` JSON are bounded and hash-bound to the
  installed release. The immutable manifest also binds the production
  `node_modules` tree, the recovery/operations templates, backup/verifier
  entry points, and their exact hashes.
- Releases are published read-only under `releases/BUILD_ID`; configuration,
  operational revisions, Field/Test evidence, and deployment records remain
  outside the release root.
- A temporary relative symlink is atomically renamed over `active`. A stage
  failure after that release-directory rename removes the newly published
  release before returning failure, so a failed stage cannot remain available
  for later activation.
- The application unit and all 12 auxiliary units (two recovery service/timer
  pairs and four operations service/timer pairs) are one activation/rollback
  bundle. Activation verifies exact unit hashes, fragment paths, loaded state,
  no pending daemon reload, no drop-ins, and every timer's enabled/active/future
  trigger state.
- Before changing the link or any unit, deployment records and disables the
  exact auxiliary timer set and stops the associated one-shot services. They
  remain quiescent through loaded-unit and build-health verification. Failure
  quiesces them again before rollback and restores the prior enabled/active
  state exactly; success enables the new verified timer set.
- The application must report the exact packaged server/client build identity.
  `Normal`, `Attention`, or `Simulation` may establish startup health, but do
  not establish commissioning. Every deployment record says
  `productionQualified: false`.
- A failed first activation removes the active link and complete unit bundle. A
  failed upgrade restores, reloads, health-checks, and re-enables the complete
  prior bundle. Explicit rollback uses the same gates.
- Preflight requires system Node/npm, disk reserve, synchronized clock, valid
  TLS/key match, Nginx syntax/service state, UFW state, direct denial of the
  backend and SDRconnect ports, a bounded non-secret operations file, and an
  existing restore-staging directory outside evidence.
- `/etc/rf-monitor/ops.conf` must exactly match the active local health URL,
  storage/evidence roots, TLS certificate, and restore-staging path. A stale
  site file cannot silently supervise another installation. No backup path is
  invented: absent backup configuration is recorded
  `attention-unqualified`; a configured path remains `configured-not-verified`
  until operations evidence exists.
- Deployment subprocesses have a 60-second default wall-clock kill bound;
  dependency installation is capped at 30 minutes and SBOM/audit commands at
  10 minutes each.
- The protected `rf-monitor backup` command verifies its immutable entry point
  and uses absolute `/usr/sbin/runuser` to execute as the service account. It
  supplies no default destination and does not weaken offline/off-host backup
  checks.
- Remote LAN reachability is always `not-run-external`; localhost health never
  proves the LAN firewall boundary.

## Existing-install stop condition

An existing package without `dist/release.json` cannot be assigned trustworthy
rollback identity. The installer now detects that condition before `sudo -v`,
APT, directory creation, or unit changes and stops with a preservation/migration
instruction. It does not fabricate release metadata. The actual deployed legacy
host reported by the deployment audit has this condition, so its one-time
migration remains an explicit installed-host blocker.

## Isolated fixture coverage

`tests/deploymentRelease.test.ts` uses `mkdtemp` roots and abstract activation
hooks. It does not invoke `/opt`, `/etc/systemd/system`, or active services.
Its 18 cases cover:

1. exact health/build identity semantics separate from commissioning;
2. bounded operations-file parsing, exact path binding, stale-path rejection,
   disallowed keys, and missing-versus-configured backup state;
3. fresh read-only staging with lock-only dependencies and SBOM/audit/runtime
   integration hashes;
4. idempotent reinstall;
5. A-to-B activation and explicit B-to-A rollback with unchanged external data;
6. automatic restoration after health/build failure;
7. timer/service quiescence across every activation boundary and exact prior
   timer-state restoration after rollback;
8. failed first activation with no active link or residual unit bundle;
9. application loaded-unit mismatch rollback;
10. auxiliary loaded-unit and timer-runtime mismatch rollback;
11. TLS/firewall/Nginx/clock/disk/operations/staging preflight refusal before
    switching;
12. lock mutation and failed audit without published output;
13. cleanup after failure following the final release-directory rename;
14. bounded forced termination of a hung subprocess;
15. allowed internal npm executable links and refused external links;
16. rejection of release-internal configuration/evidence paths;
17. non-mutating refusal of an unidentifiable legacy installation; and
18. system-Node/shell/static wiring plus real unit-template rendering.

Recovery, operations-supervisor, release-package, traceability, configuration,
and evidence-backup fixtures exercise the integrated adjacent contracts.

## Verification

Runtime: `/usr/bin/node` v24.19.0.

```text
/usr/bin/node node_modules/vitest/vitest.mjs run \
  tests/deploymentRelease.test.ts \
  tests/recoverySupervisor.test.ts \
  tests/opsSupervisor.test.ts \
  tests/evidenceBackup.test.ts \
  tests/releasePackage.test.ts \
  tests/releaseIdentity.test.ts \
  tests/traceability.test.ts \
  tests/config.test.ts --reporter=dot
```

Result: **8 files, 86 tests passed, zero failed/skipped**.

```text
/usr/bin/node node_modules/typescript/bin/tsc --noEmit
/usr/bin/bash -n deploy/install-ubuntu.sh deploy/configure-ubuntu.sh \
  deploy/configure-web.sh deploy/rf-monitorctl.sh deploy/rf-monitor-backup.sh
/usr/bin/node --check deploy/release-manager.mjs
/usr/bin/node --check deploy/release-cli.mjs
/usr/bin/node --check deploy/ops-supervisor.mjs
```

Result: all checks exited 0.

The repository is still changing across Waves C–E. A final `npm run build`,
release validation, audit/SBOM generation, and V1 record must be executed only
after the candidate freezes; this note is not a substitute for that record.

## Not proven here

No command in this work changed `/opt/rf-monitor`, `/etc`, or an active service.
The following remain unproven and block DEP-600 completion:

- approved migration of the current unidentifiable legacy installation;
- fresh install, reinstall, immutable upgrade, failed upgrade, and rollback on
  the deployed Ubuntu host;
- actual loaded systemd properties, timer execution, service restart, power-loss
  recovery, and SDRconnect compatibility;
- installed TLS chain/private-key permissions, Nginx include, UFW rules,
  synchronized clock source, disk/mount behavior, and evidence filesystem;
- a configured and independently verified off-host backup plus restore drill;
- TCP 5454/8080 denial and HTTPS/browser success from a separate LAN computer;
- bounded installed-host fault, pressure, recovery, and rollback checks tied to
  the same frozen V0-V7 candidate.

DEP-600 stays **In progress** until those installed-chain and external checks are
recorded against the final frozen release candidate.
