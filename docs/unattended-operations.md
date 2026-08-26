# Unattended operations supervision

This page covers the external checks that run beside RF Monitor. They do not
change RF settings, restart services, delete evidence, or write into a backup.
They create small, hashed readiness records in `/var/lib/rf-monitor-ops`.

A one-minute probe updates the bounded current status. A separate daily task
archives one durable readiness record, so fast fault detection does not create
an unbounded archive.

## What is checked

The daily check records:

- whether the local schema-v2 health endpoint answers;
- clock synchronization;
- TLS certificate expiry;
- evidence-disk health, free bytes, and configured reserve;
- RF Monitor active state and systemd restart count;
- receiver and application recovery state, including lockout;
- age and outcome of the latest durable off-host backup;
- age of the last weekly verification and monthly drill;
- whether a release/configuration change requires recommissioning.

`Normal` means every collected fact passed. `Attention` means a task is due or
degraded. `Critical` means current monitoring, timestamps, recording, recovery,
or backup integrity cannot be trusted. Missing collector data never becomes
Normal.

The weekly task verifies every finalized evidence session discovered under the
configured field and test evidence roots, then verifies the latest backup. It
skips Active and Finalizing sessions. It refuses symlinked roots and stops with
an explicit failed record if its bounded 1,024-target scan would be exceeded.
Verifier output is accepted only when its schema, outcome, process exit status,
and exact evidence or backup path agree. Backup results must also match the
requested operation, lifecycle state, and backup ID. A plausible result for a
different package or path is recorded as failed.
The backup audit is opened once with no-follow semantics and read through that
descriptor, so a symlink or concurrent pathname replacement cannot substitute
a different audit after the size check.

The monthly task checks both recovery timers and their latest structured
results, verifies the newest backup, and runs the backup restore command with
`--dry-run`. The dry run hashes and validates the backup and restore plan but
does not create a restored tree or restart live software. A witnessed live
failure/recovery and a real bare-host restore are bounded pre-V7 acceptance tasks.
The recorded dry-run destination must exactly match the planned restore staging
path; a result for another destination cannot satisfy the drill.

## Schedule

| Task | Default time | Retained records | Late after |
|---|---:|---:|---:|
| Uptime/readiness probe | every minute | latest only | next probe |
| Daily readiness | 00:20 UTC | 400 | next daily run |
| Evidence and backup verification | Sunday 01:20 UTC | 104 | 9 days |
| Recovery and restore dry run | first day, 02:20 UTC | 36 | 40 days |

Each timer uses `Persistent=true`. If the computer was off at the scheduled
time, systemd runs the task after boot. The daily record also checks record age,
so a disabled, failed, or missed weekly/monthly job becomes Attention instead
of silently disappearing. A new installation receives one full schedule window
before a missing weekly or monthly record is reported.

## Configuration

The installer creates `/etc/rf-monitor/ops.conf` root-owned, service-group
readable, and mode `0640`. It writes the current health, evidence, TLS, and
restore-staging paths, but deliberately leaves the off-host backup destination
unset. On upgrade it preserves an existing file; activation fails if any
layout-derived path is stale. The file contains paths and numeric limits only;
never place a password, token, private key, or credential in it.

Required site values are:

- `RFMON_OPS_BACKUP_ROOT`: the mounted off-host backup directory;
- `RFMON_OPS_EVIDENCE_ROOTS`: comma-separated absolute field/test evidence roots;
- `RFMON_OPS_TLS_CERTIFICATE`: the public server certificate, not its key;
- `RFMON_OPS_RESTORE_STAGING_ROOT`: an existing empty-parent directory used only
  to validate the dry-run destination;
- `RFMON_OPS_DISK_RESERVE_BYTES`: the approved evidence-disk reserve.

Stop deployment if a configured path is relative, missing, or symlinked. Do not
point the restore staging root inside a backup or evidence tree.

A fresh installation remains Attention/unqualified until the site owner adds
the approved mounted `RFMON_OPS_BACKUP_ROOT`, creates a protected backup, and
verifies it. An active timer proves only that the job is scheduled; it is not a
backup or production-readiness result.

## Check the timers

Run:

```bash
sudo systemctl status \
  rf-monitor-ops-probe.timer \
  rf-monitor-ops-daily.timer \
  rf-monitor-ops-weekly.timer \
  rf-monitor-ops-monthly.timer
```

Expected: all four show `active (waiting)` and a future trigger.

Then run:

```bash
sudo systemctl list-timers 'rf-monitor-ops-*'
```

Expected: one row for the probe and each daily, weekly, and monthly timer. Stop if a timer has
no `NEXT` value, is disabled, or points to a different loaded unit than the
active RF Monitor release.

## Read the latest result

Run:

```bash
sudo -u rfmonitor /usr/bin/node \
  /opt/rf-monitor/deploy/ops-supervisor.mjs status
```

Expected: JSON with `schemaVersion: 1`, normally `kind: probe`, SHA-256 payload
and whole-record hashes, and `payload.summary.state`. A daily run may briefly be the latest result
until the next one-minute probe. Use the installed service-account name if it is
not `rfmonitor`.

To confirm the record is current without printing host details:

```bash
sudo jq '{generatedAt, state: .payload.summary.state, issues: .payload.issues}' \
  /var/lib/rf-monitor-ops/status.json
```

Stop qualification for `Critical`. For `Attention`, follow the single action in
each issue, then run the relevant one-shot service once and wait for the next
daily record. Do not edit the JSON or remove a failed record to make status look
clean.

## Safe manual verification

These commands run the same read-only jobs immediately:

```bash
sudo systemctl start rf-monitor-ops-daily.service
sudo systemctl start rf-monitor-ops-weekly.service
sudo systemctl start rf-monitor-ops-monthly.service
```

Expected: each command returns without output. Inspect the result:

```bash
sudo systemctl --no-pager --full status rf-monitor-ops-daily.service
sudo jq '.payload.summary' /var/lib/rf-monitor-ops/daily-latest.json
sudo jq '.payload.summary' /var/lib/rf-monitor-ops/weekly-latest.json
sudo jq '.payload.summary' /var/lib/rf-monitor-ops/monthly-latest.json
```

A collector execution failure is different from a recorded Attention/Critical
finding. If systemd reports `failed`, preserve a support bundle and correct the
path, permission, mount, or missing verifier. Do not grant the application sudo
or add a shell command inside RF Monitor.

## Support bundle

`sudo rf-monitor support-bundle` now limits each captured item to 256 KiB,
uncompressed bundle input to 8 MiB, and the final archive to 12 MiB. It excludes
evidence contents, credential files, private keys, full process command lines,
and unlimited logs. Password-, secret-, token-, credential-, serial-, IP-, and
MAC-labelled values are redacted. It includes only the bounded latest operations
records. The archive is built in a root-private staging directory and published
with exclusive, no-symlink creation at mode `0600`; it refuses to replace an
existing output name.

Automated redaction is not approval to share the archive. Review it before it
leaves the vessel or site.
