# Ubuntu 24.04 Deployment Checklist

Use this as a compact checklist after reading [Installation And Configuration](installation-and-configuration.md).

## Install

- [ ] Sign in as a normal sudo-enabled Ubuntu user.
- [ ] Confirm Ubuntu `24.04` with `cat /etc/os-release`.
- [ ] Connect the SDRplay and correct antenna chain.
- [ ] Enter the RF Monitor source folder.
- [ ] Run `bash deploy/install-ubuntu.sh` without `sudo`.
- [ ] Confirm the installer reports a staged immutable build and health-gated activation.
- [ ] Accept system Node installation when `/usr/bin/node` is missing/old.
- [ ] Install SDRconnect when `/opt/sdrconnect/SDRconnect_headless` is missing.
- [ ] Create and securely record the Settings password.
- [ ] Select evidence storage and local SDRconnect endpoint.
- [ ] Configure HTTPS and the smallest operator CIDR.
- [ ] Configure an approved mounted off-host `RFMON_OPS_BACKUP_ROOT`; until it is verified, keep production qualification blocked.
- [ ] Trust the generated CA on managed operator computers, or use the organization certificate.

## One-Time Legacy Migration Preflight

Use this only when `/opt/rf-monitor` contains the running application directly and `/opt/rf-monitor/active` does not exist. This step reads the running package and live receiver state. It does not stop the service or tune the receiver.

From the new RF Monitor source folder:

```bash
sudo /usr/bin/node deploy/legacy-install-snapshot.mjs capture \
  --source /opt/rf-monitor \
  --unit /etc/systemd/system/rf-monitor.service \
  --config /etc/rf-monitor.env \
  --health-url http://127.0.0.1:8080/api/health \
  --candidate-root "$PWD" \
  --output /var/backups/rf-monitor/legacy-before-immutable-migration
```

Expected result: `valid: true`, `migrationCutoverReady: true`, `liveReceiver: RSPdx` or `RSPdx R2`, and the candidate build ID. Then verify the finished bundle independently:

```bash
sudo /usr/bin/node deploy/legacy-install-snapshot.mjs verify \
  --bundle /var/backups/rf-monitor/legacy-before-immutable-migration
```

Stop before migration if capture or verification fails, `migrationCutoverReady` is false, the receiver is not live at 10 MS/s, the source changes during capture, or the output path already exists. Do not rename or delete `/opt/rf-monitor` to bypass the installer. Copy the verified snapshot to approved off-host storage before cutover. The snapshot is rollback evidence only; it is never a production-qualification result.

Immediately before cutover, prove that the running package, service unit,
protected configuration, candidate, and physical receiver still match:

```bash
sudo /usr/bin/node deploy/legacy-install-snapshot.mjs verify-current \
  --bundle /var/backups/rf-monitor/legacy-before-immutable-migration \
  --source /opt/rf-monitor \
  --unit /etc/systemd/system/rf-monitor.service \
  --config /etc/rf-monitor.env \
  --candidate-root "$PWD" \
  --health-url http://127.0.0.1:8080/api/health
```

Expected result: `currentMatchesSnapshot: true` and
`qualificationUse: migration-cutover-preflight-only`. Then run the installer as
the normal sudo-enabled user:

```bash
RFMON_LEGACY_SNAPSHOT=/var/backups/rf-monitor/legacy-before-immutable-migration \
bash deploy/install-ubuntu.sh
```

The migration keeps the old package in place, does not rewrite the existing
protected configuration, captures the current main and auxiliary systemd units
before switching, and verifies the exact new build and live health. If activation
fails, it removes the new active link, restores the captured units and timer
states, restarts the legacy service, and verifies the same live RSPdx identity.
Stop if the installer reports that legacy restoration failed.

Until the first candidate is accepted, retain the snapshot and the generated
`legacy-rollback-*.json` file under `/opt/rf-monitor/deployment-records`. If the
candidate initially starts but must be returned to the legacy service, run:

```bash
sudo /usr/bin/node /opt/rf-monitor/active/deploy/release-cli.mjs \
  restore-legacy \
  --legacy-snapshot /var/backups/rf-monitor/legacy-before-immutable-migration
```

Expected result: `action: restore-legacy`, `state: complete`, and
`restoredLegacy.state: legacy-restored`. The command verifies the snapshot,
unchanged legacy package/configuration, active candidate, rollback-artifact hash,
and live receiver identity before switching. If legacy health does not recover,
it rolls forward to the immutable candidate and reports failure.

## Confirm System Runtime

```bash
/usr/bin/node --version
sudo -u rfmonitor /usr/bin/node --version
sudo systemctl cat rf-monitor.service | grep ExecStart
sudo systemctl list-timers 'rf-monitor-*-recovery.timer' 'rf-monitor-ops-*'
```

- [ ] Node is version 20 or newer.
- [ ] The service uses `/usr/bin/node`, not `/home/.../.nvm/...`.
- [ ] Recovery and all four operations timers are active with a future run; this confirms scheduling, not backup success.

## Confirm Security

```bash
sudo ss -lntp
sudo ufw status verbose
sudo nginx -t
sudo rf-monitor access
```

- [ ] SDRconnect is local on `127.0.0.1`.
- [ ] RF Monitor Node is local on `127.0.0.1`.
- [ ] Only HTTPS is available to the operator network.
- [ ] TCP 5454 and 8080 are blocked from the LAN.
- [ ] The browser certificate is trusted.
- [ ] No LAN token is expected in v1.

## Configure Dashboard

- [ ] Open **Settings** and enter **Admin mode**.
- [ ] Enter real site name, deployment ID, and display time zone.
- [ ] Explicitly select the separate fast Tier-1 profile for a new GNSS-first installation.
- [ ] Confirm combined L1/E1/B1C/SBAS L1, GPS L2C, combined L5/E5a/B2a, and GLONASS G1 physical targets.
- [ ] Confirm optional GNSS, StarTrack, and 4DX work is disabled or **Paused — protecting GNSS** until separately qualified.
- [ ] Review feasibility, actual gaps, and 2/6-second revisit objectives; do not call them guarantees.
- [ ] Set evidence limits appropriate to disk capacity.
- [ ] Apply and confirm a new revision/evidence session.
- [ ] Lock Settings.

## Verify

```bash
sudo rf-monitor doctor
sudo rf-monitor verify-sdr
sudo rf-monitor verify-spectrum
timedatectl status
```

- [ ] Doctor has no blocking production failure.
- [ ] SDRconnect JSON API responds.
- [ ] A physical RSP produces a binary spectrum frame.
- [ ] Source is not merely `IQ File`.
- [ ] Clock is synchronized.
- [ ] Dashboard says Monitoring and Recording evidence.
- [ ] Real unobserved gaps are understood/documented for the one RSPdx tuner.

## Commission

- [ ] At least 30 minutes of valid baseline learning recorded for every physical target.
- [ ] The bounded 24-hour timing and signal-learning gate completed before protected-baseline approval.
- [ ] Known signal visible at expected frequency.
- [ ] Wideband, narrowband, drift, and overload behavior tested safely.
- [ ] Exclusive Engineer Focus two-step warning, Paused states, audit, countdown, and automatic resume verified.
- [ ] Reconfiguration rolls to a new evidence session.
- [ ] Receiver disconnect/reconnect verified.
- [ ] Service restart and host reboot verified.
- [ ] Incident note, acknowledgement, screenshot, and ZIP export verified.
- [ ] ZIP and manifest hashes independently checked.
- [ ] Evidence and journald recycling verified under test limits.
- [ ] Backup and restore sample completed.
- [ ] Eight dashboards plus one 5 MiB/s export stay within network/memory/event-loop bounds.
- [ ] Managed-switch egress drops, discards, and pause-event counters do not increase.
- [ ] SDRconnect port 5454 is localhost-only and a ninth live dashboard is rejected.

## Routine Commands

```bash
sudo rf-monitor access
sudo rf-monitor doctor
sudo rf-monitor status
sudo rf-monitor logs 200
sudo rf-monitor restart
sudo rf-monitor releases
sudo rf-monitor configure
sudo rf-monitor configure-web
sudo rf-monitor reset-admin-password
sudo rf-monitor support-bundle
```

Do not commission from WSL. WSL is a software test lab and cannot substitute for physical Ubuntu receiver validation.
