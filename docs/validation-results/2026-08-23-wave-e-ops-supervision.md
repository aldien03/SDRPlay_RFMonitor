# Wave E OPS-700 / OPS-710 software validation — 2026-08-23

## Result

The external operations-supervision implementation is software-test complete.
It is not yet evidence that the production host has loaded these units, that an
off-host backup medium is connected, or that the bounded installed-host
backup/restore acceptance has passed.

> **Contract supersession:** The software-test result in this record remains
> historical evidence. Any former implication that V8 or a 72-hour observation
> was required for OPS-700, OPS-710, development completion, or production
> readiness is superseded. The required development contract ends at V7 and no
> required run exceeds 24 hours.

Implemented:

- read-only external collection for uptime, clock, public-certificate expiry,
  disk reserve/health, systemd restart count, recovery failure/lockout, backup
  age/outcome, and scheduled-task age;
- bounded stable issue epochs which clear only after a clean evaluation;
- daily, weekly, and monthly SHA-256-bound records with atomic publication and
  400/104/36 record ceilings;
- a one-minute latest-only uptime/readiness probe, separate from the daily
  archive so fault visibility does not create unbounded records;
- persistent systemd daily/weekly/monthly timers with randomized delay and
  unprivileged, resource-bounded, hardened oneshot services;
- weekly finalized-evidence and latest-backup verification;
- monthly non-disruptive recovery-supervisor and backup-restore dry run;
- changed release/configuration detection requiring current recommissioning;
- bounded redacted support bundles which exclude evidence, secrets, private
  keys, full command lines, and unlimited logs.

## Tests run

```text
npm test -- --run tests/opsSupervisor.test.ts

Test Files  1 passed (1)
Tests      15 passed (15)
```

The fixture test used temporary evidence, backup, recovery-status, command, and
archive roots. It ran all three jobs and confirmed byte-for-byte that evidence
and backup audit inputs were unchanged. Other cases covered:

- simultaneous critical/attention classification and deduplication;
- initial schedule grace and overdue-task findings;
- stable issue first-seen/occurrence state and clean clearing;
- record hash verification and tamper rejection;
- whole-record timestamp/kind hash binding, not only a payload digest;
- 64 KiB record bound and retention pruning;
- symlinked archive refusal;
- unsafe numeric configuration refusal;
- shipped service/timer hardening and persistent calendars;
- support-bundle size/redaction policy.

The support-bundle case ran the real shell entry point as UID 0 inside an
isolated user namespace with fixture commands and secret/IP/MAC canaries. The
published archive stayed within its configured size limit and contained none of
the canary values.

The broader evidence/recovery compatibility run also passed:

```text
Test Files  5 passed (5)
Tests      55 passed (55)
```

Syntax and unit validation:

```text
/usr/bin/node --check deploy/ops-supervisor.mjs    PASS
bash -n deploy/support-bundle.sh                   PASS
systemd-analyze verify (substituted fixture units) PASS
```

`systemd-analyze` emitted only the fixture's use of the special `nobody` user
and an unrelated pre-existing AnyDesk PID-file warning; it reported no RF
Monitor unit error.

## Bounds

| Item | Bound |
|---|---:|
| Readiness record | 64 KiB |
| Collector state | 64 KiB |
| Health response input | 64 KiB |
| Command output | 256 KiB |
| Diagnostic issues | 32 |
| Evidence targets per weekly scan | 1,024 |
| Daily / weekly / monthly records | 400 / 104 / 36 |
| Support entry / input / archive | 256 KiB / 8 MiB / 12 MiB |
| Probe memory / task ceiling | 128 MiB / 24 tasks |
| Other oneshot memory / task ceiling | 256 MiB / 32 tasks |

## Remaining production evidence

OPS-700 and OPS-710 must remain unqualified until the immutable DEP-600 release
installs and loads the exact units, the site configures real off-host storage
and its TLS certificate, all three timers produce fresh records across reboot,
and the following are witnessed:

1. an actual off-host backup and independent verification;
2. a real empty-host restore with evidence/configuration hash comparison;
3. clock loss, certificate-expiry, disk-reserve, restart-count, and recovery-
   lockout fixtures on the production-like host;
4. a deliberately missed weekly/monthly task becoming Attention; and
5. bounded installed-host recovery and resource fault checks tied to the same
   frozen V0-V7 candidate, with no required run longer than 24 hours.

The monthly automatic task is intentionally non-disruptive. It does not restart
RF Monitor/SDRconnect and does not create a restored tree; it cannot replace the
witnessed installed-host recovery and empty-root restore drills required by
Wave E.
