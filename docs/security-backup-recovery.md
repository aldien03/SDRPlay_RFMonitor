# Security, Backup, And Recovery

RF Monitor produces engineering evidence on a local operational network. It is designed to be tamper-evident and recoverable, but it is not an externally certified legal chain-of-custody system.

## Security Boundaries

### Operator Network

RF Monitor 1.0 intentionally has no LAN access token. Any browser admitted by the Nginx operator-network allowlist can view dashboard data and use evidence/operator actions. Therefore:

- use a dedicated, trusted operations network or approved VPN;
- choose the smallest practical CIDR in `sudo rf-monitor configure-web`;
- do not expose the dashboard to public Wi-Fi or the public internet;
- control physical and account access to operator computers;
- retain Nginx/system logs according to policy.

HTTPS protects traffic in transit. It does not identify individual v1 operators.

### Settings Administration

Configuration writes require a separate Settings password. The server stores:

- a random per-password salt;
- a Node `scrypt` result;
- a random session-signing secret;
- algorithm/schema metadata.

The plaintext password is not stored. Reset it at the Ubuntu console with:

```bash
sudo rf-monitor reset-admin-password
```

Settings sessions are short-lived, address-bound, signed, `HttpOnly`, `SameSite=Strict`, and HTTPS-only in production. Writes also require matching Origin and CSRF values. Repeated unlock failures are rate-limited.

Lock Settings immediately after a change.

### Node And SDRconnect

- RF Monitor binds only to `127.0.0.1`.
- Local SDRconnect binds to loopback.
- Nginx is the sole LAN endpoint.
- Nginx separates `/live`, ordinary API/static, and export handling.
- UFW blocks direct receiver/backend ports.
- The service runs as the unprivileged `rfmonitor` account.
- `/usr/bin/node` is used, not a private user NVM runtime.
- systemd limits writable paths to required runtime locations.

Verify listeners:

```bash
sudo ss -lntp
sudo ufw status verbose
```

Expected: SDRconnect is `127.0.0.1:5454`, RF Monitor is `127.0.0.1:8080`, and neither port is reachable from the LAN. The application—not Nginx alone—is authoritative for eight live clients and global live/export bandwidth limits.

### File Permissions

Check:

```bash
sudo stat -c '%a %U:%G %n' \
  /etc/rf-monitor.env \
  /etc/rf-monitor/catalog.json \
  /etc/rf-monitor/admin.json \
  /var/lib/rf-monitor/config/operational.json
```

Expected defaults:

- infrastructure environment: `600 root:root`;
- catalog and admin credential: `640 root:rfmonitor`;
- operational profile: `640 rfmonitor:rfmonitor`;
- evidence/config directories: not writable by ordinary users.

`sudo rf-monitor doctor` checks these controls.

## Evidence Integrity

### Session Manifest

At session finalization, RF Monitor creates SHA-256 records for evidence files. Manifest-v2 evidence records tune/configuration/visit epochs, requested and confirmed RF state, gaps/drops, affected logical signals, baseline/rule IDs, and calibration state. Incident-slice exports include manifests and streamed hashes; large incidents split into numbered parts without truncation. Relative POSIX paths make manifests portable.

New sessions use an authoritative evidence lifecycle: **Active**, **Finalizing**, **Complete**, **Incomplete**, or **Corrupt**. The older `recording`/`closed` value is a compatibility label and is not proof of completeness. **Complete** is committed only after evidence files are durability-checkpointed, the manifest and checksum file are written, and the final commit is synced. A restart can resume a durable **Finalizing** session. A torn active session becomes **Incomplete** with an explicit gap. Hash or structure mismatches become **Corrupt**.

Evidence History displays these lifecycle names directly. A **Complete** session is ready to download. An **Incomplete** session can also be downloaded, but the UI and manifest state that it contains recorded gaps. **Active**, **Finalizing**, and **Corrupt** full-session downloads remain disabled. A legacy `closed` alias without lifecycle proof is shown fail-closed as **Incomplete**, never **Complete**.

Lifecycle and full verification are separate. **Complete** means the transactional metadata was durably committed. Diagnostics report full verification as `Not run`, `Pass`, `Incomplete`, or `Fail`, with the last completed verification time. Startup checks only bounded commit/manifest metadata; it does not re-hash every historical payload. Run the verifier before relying on a transferred or restored copy.

Use the offline verifier on an extracted session or export root:

```bash
sudo rf-monitor verify-evidence /absolute/path/to/extracted/session-root
```

Expected: `PASS`, `INCOMPLETE`, or `FAIL`. `PASS` means the stored hashes and lifecycle commit agree. `INCOMPLETE` preserves readable evidence but names a gap or unfinished lifecycle. `FAIL` means the files, hashes, paths, domain, or lifecycle disagree; stop using that copy as intact evidence and preserve it for investigation. The verifier continues to read manifest-v1 packages.

For numbered exports, extract every ZIP into a separate directory and verify the set:

```bash
sudo rf-monitor verify-evidence --multipart \
  /absolute/path/part-001-root /absolute/path/part-002-root
```

Expected: `PASS` only when every numbered part is present exactly once and the reconstructed file inventory matches the common streamed SHA-256 commitment. Missing parts return `INCOMPLETE`; duplicate, changed, or inconsistent parts return `FAIL`.

IQ is disabled in v1. No package should contain an IQ clip. Sessions rotate at 2 GiB or 24 hours even during an incident; raw chunks rotate hourly/at 128 MiB, and incident identity continues across parts. Readers must continue verifying manifest-v1 evidence after an upgrade or rollback.

Hashes can reveal later modification. They cannot prove who originally controlled the host, receiver, antenna, or system clock. Protect the host and document custody.

### Configuration Audit Chain

Every configuration attempt records UTC time, revision, changed fields, outcome, client address, old/new configuration hashes, previous audit hash, and current hash. Evidence manifests include relevant audit entries.

Changing or deleting an earlier record breaks chain verification, but a privileged attacker who controls the host can still replace all local evidence. Copy important incident packages promptly to an independently controlled repository.

### Time

Evidence is always UTC. Display time zone is presentation only.

Check synchronization:

```bash
timedatectl status
```

If the clock is unsynchronized or changes unexpectedly, document the interval and do not make precise timing claims until correlation is complete.

## Backup Policy

The verified backup package contains both Field and Test data roots, finalized manifest-v1/v2 evidence, the operational profile and revisions, baselines, qualification state, the configuration audit, and the non-secret catalog. Field and Test remain separate directories inside the package.

The tool always excludes the Settings credential, environment files, passwords, private keys, and other secret-named files. It also excludes files outside the configuration allowlist and reports both exclusion counts. Back up secrets only through a separately approved encrypted credential system; do not place a plaintext secret beside RF evidence.

Keep the application release package separately. A data backup is not an installer.

### Recommended Schedule

- copy critical incident ZIPs immediately;
- target hourly incremental off-host evidence backup when the approved site backup system supports it;
- configuration/audit backup after every approved change;
- full recovery backup before upgrades or catalog changes;
- periodic restore test on an isolated host.

RF Monitor provides the bounded copy, verification, and empty-root restore tool. It does not configure, monitor, or approve the remote repository. Site IT must select and secure the mounted destination and approve recovery-point and recovery-time objectives. A local fixture or verifier result is not evidence that a real off-host transfer or witnessed bare-host restore occurred.

## Create A Verified Backup

The source is read-only. Publication uses a same-destination `.partial` directory, streamed SHA-256 checks, directory sync, and one atomic rename. A pre-existing final backup ID is never overwritten. Repeating an identical completed operation is idempotent.

Choose an approved mounted destination. The example uses `/mnt/secure-backup/rf-monitor`; replace it with the site path.

1. Confirm the mount and create a directory writable only by the service account:

   ```bash
   mountpoint /mnt/secure-backup
   df -h /mnt/secure-backup
   sudo install -d -m 0700 -o rfmonitor -g rfmonitor /mnt/secure-backup/rf-monitor
   ```

   Expected: `mountpoint` says **is a mountpoint** and `df` shows enough free space. Stop if it is the local root filesystem, unexpectedly empty, read-only, or nearly full.

2. Stop RF Monitor for a consistent offline source and confirm the data-domain lease is gone:

   ```bash
   sudo rf-monitor stop
   sudo find /var/lib/rf-monitor/evidence -name .rf-monitor-active.json -print
   ```

   Expected: the `find` command prints nothing. If it prints a path, do not delete it; check service status and stop.

3. Set one immutable backup ID and run a dry-run:

   ```bash
   BACKUP_ID="rf-monitor-$(date -u +%Y%m%dT%H%M%SZ)"
   sudo rf-monitor backup create \
     --data-root /var/lib/rf-monitor/evidence \
     --config runtime=/var/lib/rf-monitor/config \
     --config system=/etc/rf-monitor \
     --destination /mnt/secure-backup/rf-monitor \
     --backup-id "$BACKUP_ID" \
     --minimum-free-bytes 5368709120 \
     --dry-run
   ```

   Expected: `State: planned`, `Outcome: PASS`, exact file/byte/capacity values, and nonzero exclusion counts when secret files exist. The default free-space reserve is 5 GiB even when the option is omitted. `INCOMPLETE` means a readable source session contains named gaps; it will never be relabelled complete. `FAIL` means stop and preserve the source.

4. Create the package with the same arguments, without `--dry-run`:

   ```bash
   sudo rf-monitor backup create \
     --data-root /var/lib/rf-monitor/evidence \
     --config runtime=/var/lib/rf-monitor/config \
     --config system=/etc/rf-monitor \
     --destination /mnt/secure-backup/rf-monitor \
     --backup-id "$BACKUP_ID" \
     --minimum-free-bytes 5368709120
   ```

   Exit `0` is `PASS`; exit `2` is a published but explicitly `INCOMPLETE` package; exit `1` is refused/failed; exit `3` requires interrupted-operation recovery. The destination also receives a bounded `rf-monitor-backup-audit.jsonl` result record.

5. Verify the final package independently, then restart monitoring:

   ```bash
   sudo rf-monitor backup verify \
     --backup "/mnt/secure-backup/rf-monitor/$BACKUP_ID"
   sudo rf-monitor start
   sudo rf-monitor doctor
   ```

   Expected: verification repeats the payload, manifest, checksum, data-domain, and evidence-package checks and returns the same `PASS` or `INCOMPLETE` outcome. Doctor must show live recording again.

If continuous monitoring cannot stop, use an approved filesystem snapshot or backup system that guarantees a consistent point-in-time source. This tool refuses a live data-domain lease; it does not pretend a changing tree is a consistent backup.

## Interrupted Backup

Check the immutable backup ID:

```bash
sudo rf-monitor backup status \
  --destination /mnt/secure-backup/rf-monitor \
  --backup-id "$BACKUP_ID"
```

`recovery-required` means a bounded `.partial` directory exists. Inspect the mount first. You may repeat the original command with both `--dry-run --recover`; this validates and counts the owned partial without changing it. Then repeat without `--dry-run`. The tool removes only partials carrying its owned descriptor for that exact backup ID and source commitment, then starts a fresh verified copy. An unowned look-alike is refused and preserved. It never replaces a published backup.

## Recovery To The Same Host

Never point restore at `/opt/rf-monitor`, `/var/lib/rf-monitor`, the active evidence tree, or another existing directory. Restore reconstructs only a new, absent staging root.

1. Record the reason, stop RF Monitor, preserve the current host through the approved incident procedure, and verify the backup.
2. Choose an absent staging path on a filesystem with enough free space:

   ```bash
   RESTORE_ROOT="/var/tmp/rf-monitor-restore-$BACKUP_ID"
   test ! -e "$RESTORE_ROOT" && echo "Restore target is absent"
   df -h /var/tmp
   ```

3. Dry-run, then restore:

   ```bash
   sudo rf-monitor backup restore \
     --backup "/mnt/secure-backup/rf-monitor/$BACKUP_ID" \
     --destination "$RESTORE_ROOT" \
     --minimum-free-bytes 5368709120 \
     --dry-run

   sudo rf-monitor backup restore \
     --backup "/mnt/secure-backup/rf-monitor/$BACKUP_ID" \
     --destination "$RESTORE_ROOT" \
     --minimum-free-bytes 5368709120
   ```

   Publication uses a sibling `.partial` root and atomic rename. Repeating the same command verifies the restored files and returns `Idempotent: yes`. An interrupted restore remains separate; repeat with `--recover` only after checking the named staging parent.

4. Review `$RESTORE_ROOT/.rf-monitor-restore.json`, the exact result, exclusions, Field/Test markers, and these reconstructed paths:

   ```text
   data/field/
   data/test/
   config/runtime/
   config/system/
   ```

5. Reinstall the same approved RF Monitor release. Restore reviewed data/configuration through the witnessed site recovery procedure; do not merge directories or overwrite a live tree. Restore encrypted credentials separately, issue new TLS material when appropriate, set ownership, and run doctor/receiver/evidence checks before service return.

This software test proves empty-root reconstruction. It does not prove that moving the staged files into a rebuilt production host is safe at this site.

## Recovery To A Replacement Host

1. Install the same Ubuntu and approved RF Monitor release on an isolated replacement.
2. Keep its services stopped and preserve any newly created data separately.
3. Run the empty-root restore procedure above on the replacement host.
4. Compare the restored manifest SHA-256 and exact counts with the backup audit.
5. Restore reviewed Field/Test and non-secret configuration into newly prepared, empty production roots according to site policy.
6. Restore the Settings credential only from separately encrypted custody, or deliberately reset it. Issue new TLS material when hostname or network identity changes.
7. Run `sudo rf-monitor configure`, `configure-web`, doctor, real receiver/frame, sample manifest-v1/v2 verification, and evidence export checks.
8. Document the backup ID, hashes, exclusions, elapsed recovery time, people present, and every deviation.

Only a witnessed, bounded drill on approved remote media can close the pre-V7 bare-host recovery requirement.

## Fast-Profile Or Package Rollback

Rollback must preserve evidence written under the newer schema.

1. Record the reason and UTC time, then stop new operator/export work.
2. Preserve a support bundle and the current operational/catalog revisions.
3. Through protected Settings, restore the saved pre-fast operational revision when the application is healthy enough. Do not hand-edit JSON.
4. If the package must be reverted, list and verify the retained immutable releases, then activate the exact approved build:

   ```bash
   sudo rf-monitor releases
   sudo rf-monitor verify-release BUILD_ID
   sudo rf-monitor rollback-release BUILD_ID
   ```

   Stop if the target is `INVALID`, preflight fails, or automatic restoration of the current release fails. Rollback switches only `/opt/rf-monitor/active`; it preserves `/var/lib/rf-monitor/evidence`, Field/Test separation, configuration, audit, and revisions.
5. Verify:

   ```bash
   sudo rf-monitor doctor
   sudo rf-monitor verify-sdr
   sudo rf-monitor verify-spectrum
   ```

6. Verify a sample of both manifest-v1 and manifest-v2 evidence, and record every incident/session part spanning rollback.

Never delete newer evidence to make an older package fit. If the old reader cannot display manifest v2, preserve the data unchanged and use a compatible offline reader.

### Legacy package before the first immutable release

An installation without `/opt/rf-monitor/active` has no versioned rollback slot. Before its one-time migration, run the legacy snapshot command in [Ubuntu 24.04 Deployment Checklist](ubuntu-24.04.md#one-time-legacy-migration-preflight). The bundle contains the exact package tree and service unit plus a hash of the protected environment file; it does not copy credentials or field evidence. Keep the evidence tree in place and preserve the snapshot off-host.

Do not treat a legacy snapshot as an approved release or as V5–V7 evidence. A witnessed cutover must run `verify-current` with root access, stage the exact bound candidate, capture the current auxiliary units and timer states, and use `RFMON_LEGACY_SNAPSHOT` with the installer. Candidate activation restores the untouched legacy package path, exact captured unit set, timer states, and live receiver flow if its loaded-unit or health/build gate fails.

The first cutover writes a hash-addressed `legacy-rollback-*.json` artifact before
changing the active link. Keep it with the sealed snapshot. A later manual
`restore-legacy --legacy-snapshot ...` verifies both artifacts and the active
candidate, restores the old units and timer states, and checks the same physical
receiver. If that check fails, the command reactivates the immutable candidate;
it never reports a successful rollback merely because systemd restarted.

## Corrupted Operational Profile

RF Monitor writes profiles atomically and keeps valid revisions. On startup it validates the active file and attempts recovery from the newest valid revision.

If the service still fails:

```bash
sudo rf-monitor logs 200
sudo ls -la /var/lib/rf-monitor/config
sudo rf-monitor support-bundle
```

Do not edit JSON in place. Preserve the directory, stop the service, and restore a known valid backup or escalate to the software maintainer.

## Lost Settings Password

There is no plaintext recovery:

```bash
sudo rf-monitor reset-admin-password
sudo rf-monitor doctor
```

This does not alter the operational profile or evidence. Record the administrative reset according to site policy.

## Disk-Full Recovery

1. Do not delete the active session manually.
2. Check which filesystem is full:

   ```bash
   df -h
   sudo du -xhd1 /var/lib/rf-monitor /var/log 2>/dev/null
   journalctl --disk-usage
   ```

3. Export/preserve required incident packages.
4. Run retention maintenance by restarting after restoring a small safe amount of space, or use the dashboard/API if responsive.
5. Reduce future archive/session limits in Settings.
6. Reduce journald limits with `sudo rf-monitor configure` if system logs are the cause.
7. Move to a larger approved evidence filesystem through a controlled maintenance procedure.
8. Document any deleted or incomplete evidence.

Never run a recursive delete command copied from a support conversation without confirming the exact absolute target and custody approval.

## Support Bundle

Create:

```bash
sudo rf-monitor support-bundle
```

The bundle includes service/config diagnostics, catalog/profile metadata, audit information, and redacted logs. It excludes the Settings credential file, TLS private keys, and evidence payload. Review it before external transfer because site names, paths, addresses, and operational selections may still be sensitive.

## Security Incident Response

If compromise is suspected:

1. isolate the host from untrusted networks without powering it off if evidence preservation requires memory/state;
2. record UTC time and who took action;
3. preserve incident ZIPs, config/audit files, journald, Nginx logs, and filesystem metadata;
4. capture independent hashes on protected media;
5. rotate the Settings password and TLS material only after evidence preservation;
6. rebuild from trusted media rather than assuming an in-place cleanup is sufficient;
7. re-commission receiver, network, and evidence export before return to service.
