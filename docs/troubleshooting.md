# Troubleshooting

Use this guide from top to bottom. Do not change several things at once; one verified change makes the cause clear.

## First Three Commands

Run:

```bash
sudo rf-monitor doctor
sudo rf-monitor status
sudo rf-monitor logs 200
```

`doctor` is the primary diagnosis. It checks operating system, system Node, files, permissions, clock, services, listeners, SDRconnect API, operational profile, storage, HTTPS, firewall, and dashboard API.

The dashboard equivalent is **Settings > System health**. It is read-only and available without Admin mode. Start with the first **Needs attention** item, use its one safe action, and open **What to do** for the success check and stop condition. Exact counters and support tools stay under **Engineer details**. Download diagnostics only when support needs a point-in-time JSON record; the download is redacted and excludes addresses, command lines, credentials, logs, and evidence contents.

The packaged **Help** page works at `/help` without an Internet connection. Use it for routine operator actions. The commands below are for an Ubuntu administrator when the in-app actions do not restore service.

Do not treat **Simulation** as healthy physical hardware. In simulation, USB and SDRconnect show **Not tested** even when virtual RF frames are flowing. Managed-switch counters are also not inferred from the host: they remain **External — not connected** and must be checked on the switch.

Use these first actions once; do not create a retry loop:

| Status | First action | Fixed when | Stop when |
|---|---|---|---|
| Receiver offline | Check power/USB, then **Retry receiver** once | Receiver and RF data show Live | Hardware stays absent, recovery fails, cools down, or locks |
| Data late | Check this browser's network, then reload the dashboard | RF data is Live and its time advances | Other dashboards are late or System health cannot refresh |
| Recording error | Open **Recording** and check disk/current state | Recording is On with no new evidence loss | Disk is below reserve/read-only/missing or loss continues |
| Scan coverage late | End single-frequency focus or optional radio survey | Scan coverage is On time | Primary GNSS scans remain late |
| Receiver overloaded | Keep recording and check the approved antenna/gain setup | Valid observations resume without overload | Overload persists or RF settings must change |
| Signal learning paused | Resolve the named receiver/configuration issue | Representative hours advance again | Fingerprint changed; use the protected per-signal restart |
| Software restart needed | Unlock **Advanced > Software recovery** and confirm once | A new service boot is verified, RF data is Live, and Recording is On | Cooldown, lockout, helper unavailable, or recording fault |

If you need to send diagnostics:

```bash
sudo rf-monitor support-bundle
```

Read the bundle before transferring it. Never send `/etc/rf-monitor/admin.json` or TLS private keys.

## Installer Will Not Start

### Message: Do Not Run The Complete Installer With Sudo

Cause: the command was started as root or with `sudo bash`.

Fix:

```bash
exit
cd /path/to/rf-monitor
bash deploy/install-ubuntu.sh
```

Use the normal Ubuntu account. The installer asks for the sudo password when required.

### `deploy/install-ubuntu.sh: No such file or directory`

Cause: wrong folder.

Find likely copies:

```bash
find "$HOME" -maxdepth 4 -type f -path '*/deploy/install-ubuntu.sh' -print
```

Change to the parent folder printed by that command and retry.

### `sudo: command not found` Or User Is Not Allowed

The deployment account needs approved sudo access during installation. Ask the Ubuntu administrator to install using a normal sudo-enabled account. Do not work around this by changing system-file ownership.

### Ubuntu Version Rejected

Check:

```bash
cat /etc/os-release
```

RF Monitor 1.0 installation is validated on Ubuntu 24.04. Use the supported release rather than editing the version check.

## Node.js Permission Denied

### Example

```text
/home/USER/.nvm/versions/node/.../bin/node: Permission denied
```

Cause: a service or root helper was configured to use one user's private NVM runtime.

Current releases force the system runtime. Check:

```bash
command -v node
/usr/bin/node --version
/usr/bin/npm --version
sudo -u rfmonitor /usr/bin/node --version
```

The first command may show NVM in an interactive shell; that is acceptable. The last three must work.

Re-run the current installer as a normal user. If the installed service is from an older release:

```bash
bash deploy/install-ubuntu.sh
sudo systemctl cat rf-monitor.service | grep ExecStart
```

Expected `ExecStart` begins with `/usr/bin/node`. Do not chmod another user's home directory and do not copy NVM executables into system paths.

### Node Is Older Than 20

Re-run the installer and accept its Node.js 22 installation, or have the administrator install a supported system Node at `/usr/bin/node`.

## npm Build Or Test Failure

From the release source:

```bash
rm -rf node_modules
/usr/bin/npm ci
/usr/bin/npm run check
/usr/bin/npm run build
```

Removing `node_modules` in the current source folder is safe only after confirming `pwd` points to the RF Monitor source. Do not delete `/opt/rf-monitor` or `/var/lib/rf-monitor`.

If `npm ci` reports network/certificate errors, correct the host's HTTPS proxy or CA trust. Do not disable TLS verification.

## Release Deployment Stopped

First confirm the candidate and retained releases:

```bash
cd /absolute/path/to/rf-monitor-candidate
/usr/bin/npm run validate:release
sudo rf-monitor releases
sudo rf-monitor doctor
```

- **Release metadata does not match**: rebuild the unchanged candidate with `/usr/bin/npm run build`; do not edit `dist/release.json`.
- **Production dependency audit did not pass**: preserve the audit output and use a reviewed dependency update. Do not bypass the audit gate.
- **Existing files have no verifiable release identity**: the installer stopped before system changes. Preserve `/opt/rf-monitor` and the running unit. Use an approved migration package built from the exact deployed source, or a clean replacement host; do not delete or rename the old package to bypass the check.
- **Deployment preflight failed**: the error names disk reserve, clock, TLS certificate/key, Nginx, firewall, private backend/SDRconnect port rules, operations configuration, or restore staging. Correct that one check and retry. If `operationsConfig` failed, compare the non-secret path values in `/etc/rf-monitor/ops.conf` with the current install state; do not copy an old site's file.
- **Activated release failed health/build identity**: the manager attempts the previous release automatically. `sudo rf-monitor releases` must still show the prior build `ACTIVE`. Stop if it does not.
- **Loaded systemd unit verification failed**: do not hand-edit the unit or add a drop-in. Preserve a support bundle, then retry the same approved release after removing the unapproved override through the site change procedure.
- **Auxiliary timer activation verification failed**: check the application/recovery/operations timers for `enabled`, `active (waiting)`, and a future `NEXT`. The manager restores the prior complete unit bundle. An enabled timer alone is not proof that backup, recovery, or qualification passed.
- **INVALID release**: do not activate it. Preserve `/opt/rf-monitor/releases/BUILD_ID` and its deployment record for investigation.

After automatic restoration, verify:

```bash
sudo rf-monitor doctor
sudo rf-monitor verify-release BUILD_ID
```

The second command verifies the named retained build; it does not activate it. Remote browser reachability must still be checked from an approved operator computer after deployment.

## SDRconnect Is Missing

Check:

```bash
ls -l /opt/sdrconnect/SDRconnect_headless
```

If missing, obtain the approved versioned SDRconnect release through the site's software process. Verify the vendor signature or independently published checksum, install it under the authorized licence, then rerun `sudo rf-monitor doctor`. Do not pipe or execute a mutable web installer from the RF Monitor setup.

## SDRconnect Service Will Not Start

```bash
sudo systemctl status sdrconnect-headless.service --no-pager -l
sudo journalctl -u sdrconnect-headless.service -n 200 --no-pager
/opt/sdrconnect/SDRconnect_headless --help
```

Common causes:

- another SDRconnect instance already owns port 5454;
- invalid command-line option after a version change;
- service account cannot write its state directory;
- USB device or vendor API unavailable;
- graphical and headless SDRconnect are competing for one RSP.

Check port ownership:

```bash
sudo ss -lntp | grep ':5454'
```

Run only one intended SDRconnect server on that port.

## SDRconnect Reports Internal Error Or Core Dump

First distinguish a vendor-process abort from an RF Monitor warning:

```bash
sudo journalctl -u sdrconnect-headless.service --since "1 hour ago" --no-pager \
  | grep -Ei 'core-dump|status=6/ABRT|ERROR:'
sudo systemctl show sdrconnect-headless.service \
  -p NRestarts -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec
curl -fsS http://127.0.0.1:8080/api/health \
  | jq '{receivers, scheduler, baselines, processing, memory, network, streaming, writer, disk, exports}'
```

Expected healthy behavior:

- `receivers[0].streamState` is `live`;
- `processing.spectrumFramesDropped` increases when SDRconnect produces FFTs faster than the configured processing rate; this is intentional coalescing, not data loss from the receiver;
- evidence writes in flight remain below the configured cap;
- RF Monitor resident memory stabilizes instead of growing continuously.

The fast-GNSS acceptance build also exposes rolling 10/60-second bandwidth, per-client queues/drops, RSS/heap/external buffers, event-loop percentiles, writer latency, disk rate/free space, export state, and scheduler/baseline/ring allocation. If these sections are absent, do not claim that release passed the resource soak.

In `ps`, `50%` CPU normally means about half of one logical CPU, not half of the whole host. SDRconnect still performs hardware streaming and FFT generation internally; RF Monitor cannot configure an undocumented producer frame rate. Judge the value with host load, temperature, frame continuity, and growth over time.

`status=6/ABRT` or `Failed with result 'core-dump'` is a real SDRconnect failure. The managed service waits before restarting and limits crash bursts. The recovery timer waits for four consecutive stale checks, allows at most three helper-initiated restarts per hour, and never restarts RF Monitor merely because SDRconnect was replaced. **Retry receiver** bypasses the four-check observation delay, but it does not bypass the cooldown or attempt limit.

`sudo rf-monitor doctor` verifies that the installed recovery timer and service exactly match the running release, systemd has no pending reload or unapproved drop-in, and the timer is enabled, active, and has a future run. It also checks the helper's fresh structured result: `requested`, `recovering`, `live`, `failed`, or `lockout`. If systemd rejects a restart because of its start limit, the operator request remains recorded and the result reports `systemd-restart-failed`; it is not silently discarded.

If another abort occurs:

1. Do not keep pressing **Retry**. Repeated device release/selection can make USB-driver recovery less reliable.
2. Run `sudo rf-monitor support-bundle` and preserve `/var/crash` metadata according to site policy.
3. Check the direct USB cable, power, host temperature, and kernel USB reset messages.
4. Confirm the installed SDRconnect release is supported on the deployed Ubuntu LTS version using SDRplay's official release page.
5. Escalate the crash signature and support bundle to SDRplay when the vendor process continues to abort.

Stop here if the service records another core dump after one controlled restart. That is a driver/vendor/hardware investigation, not a reason to weaken memory limits or create an unlimited restart loop.

## RF Monitor Says SDRconnect Disconnected

1. Check the local port:

   ```bash
   nc -vz 127.0.0.1 5454
   ```

2. Verify the JSON API:

   ```bash
   sudo rf-monitor verify-sdr
   ```

3. Check configured endpoint:

   ```bash
   sudo grep '^SDRCONNECT_URL' /etc/rf-monitor.env
   ```

4. Reconfigure if wrong:

   ```bash
   sudo rf-monitor configure
   sudo rf-monitor restart
   ```

For a same-host deployment, the expected endpoint is normally `ws://127.0.0.1:5454/`.

There is no RF Monitor LAN token to obtain, and SDRconnect's supplied WebSocket API does not document a local bearer-token field. Do not invent an Authorization header. Keep the endpoint local.

## SDRconnect API Works But Dashboard Says Offline Or Data Late

The JSON connection can work without a live physical spectrum stream.

Run:

```bash
sudo rf-monitor verify-spectrum
```

If it lists only `IQ File`, SDRconnect is running but a physical RSP is not available/selected. Check:

```bash
lsusb
sudo dmesg --ctime | tail -n 80
groups rfmonitor
```

The `rfmonitor` account should be in `plugdev`. Reconnect USB, avoid competing SDR applications, restart services, and retry.

If the device is listed but no frame arrives, verify the device index and compare SDRconnect's confirmed sample rate with the configured 10 MS/s requirement. RF Monitor requests the configured rate when needed, but it keeps the frame gate closed until SDRconnect reads back the exact rate.

Do not accept an `IQ File` source as production RF commissioning.

## Receiver Repeatedly Disconnects

Check:

- direct USB cable and power stability;
- kernel USB reset messages;
- only one process owning the receiver;
- temperature and host load;
- SDRconnect logs;
- network stability only when SDRconnect is genuinely remote.

Commands:

```bash
sudo dmesg --ctime | grep -Ei 'usb|reset|disconnect' | tail -n 100
systemd-cgtop
sudo rf-monitor logs 300
```

After hardware correction:

```bash
sudo rf-monitor restart
sudo rf-monitor verify-spectrum
```

## Dashboard Does Not Open

### On The Ubuntu Host

```bash
curl -fsS http://127.0.0.1:8080/api/health | jq
sudo systemctl status rf-monitor.service --no-pager -l
```

If local health fails, inspect RF Monitor logs.

### Through HTTPS

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager -l
sudo ss -lntp | grep ':443'
sudo ufw status numbered
sudo rf-monitor access
```

Confirm the operator computer is inside the configured CIDR. Re-run:

```bash
sudo rf-monitor configure-web
```

when hostname, IP address, certificate, or network range changed.

Interpret the browser result before changing configuration:

- **Timed out**: check that the operator computer's IP is inside the network
  printed by `sudo rf-monitor access`, then check routing and TCP 443.
- **Connection refused**: Nginx is not listening; run `sudo rf-monitor doctor`.
- **Connection is not private**: install the local CA from the operator kit,
  restart the browser, and use the exact printed URL.
- **Name or address does not match**: the Ubuntu address or chosen URL changed;
  rerun `sudo rf-monitor configure-web` to issue a new multi-name certificate.

Create or refresh the beginner operator kit with:

```bash
sudo rf-monitor access --export /home/USER/Downloads
```

### Blank Page Or Browser Error

Try a forced reload, then check the exact URL from `sudo rf-monitor access`. Do not browse directly to `http://HOST:8080`; production access is through the HTTPS address.

Capture the browser console only if requested by support. The server log remains the first diagnostic.

## Certificate Warning

Possible causes:

- operator computer does not trust the generated local CA;
- URL uses an IP while certificate was issued to a DNS name, or vice versa;
- certificate expired;
- Ubuntu or operator clock is wrong;
- a different proxy/device is intercepting HTTPS.

Inspect the served certificate:

```bash
openssl s_client -connect DASHBOARD_HOST:443 -servername DASHBOARD_HOST </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256
```

Replace `DASHBOARD_HOST`. Compare the CA fingerprint through an approved channel. Do not train operators to bypass warnings.

## Settings Password Rejected

1. Confirm Caps Lock and keyboard layout.
2. Wait after repeated failed attempts; entering Admin mode is rate-limited.
3. Confirm the browser uses the official HTTPS URL, not a second hostname.
4. Ask the Ubuntu administrator to reset it:

   ```bash
   sudo rf-monitor reset-admin-password
   ```

The password is never retrievable. Resetting it does not erase the profile or evidence.

## Admin Mode Ends Immediately

Check:

- Ubuntu clock synchronization;
- browser cookies permitted for this site;
- reverse proxy preserving client address consistently;
- one stable dashboard hostname;
- service restart, which invalidates sessions.

Run:

```bash
timedatectl status
sudo rf-monitor logs 200
```

Use `sudo rf-monitor configure` to increase the session duration only if the current value is operationally impractical. Short sessions are intentional.

## Apply Returns Stale Revision

Another browser applied a newer configuration. The Settings page reloads the latest revision. Re-read every field, make the intended change again, and apply. Do not try to overwrite by editing JSON.

## Apply Shows Field Errors

The running profile has not changed. Typical causes:

- every service disabled;
- StarTrack deployed-frequency mode with no values;
- StarTrack value outside range or off the catalog grid;
- 4DX end before start;
- 4DX deployed range containing fewer than 51 channels;
- GNSS enabled with no GNSS system/logical signal selected;
- logical signals linked to missing or different-center physical targets;
- a fast Tier-1 profile that fails feasibility;
- retention maximum smaller than one session;
- invalid display time zone;
- dwell/detector value outside allowed range.

Correct the highlighted field. The backend is authoritative even if a browser-side control appears permissive.

## Apply Fails With Server Error

Do not retry repeatedly. Check:

```bash
sudo rf-monitor logs 300
sudo ls -la /var/lib/rf-monitor/config
df -h /var/lib/rf-monitor/config /var/lib/rf-monitor/evidence
sudo rf-monitor doctor
```

The runtime attempts rollback to the previous profile. Confirm the dashboard revision and monitoring status. Preserve the support bundle before repair.

## Active Profile Is Corrupted

Startup validates the active profile and attempts to recover the newest valid revision.

If recovery fails:

```bash
sudo rf-monitor stop
sudo cp -a /var/lib/rf-monitor/config "/var/backups/rf-monitor-config-$(date -u +%Y%m%dT%H%M%SZ)"
sudo rf-monitor support-bundle
```

Do not hand-edit the active file. Restore a known valid backup following [Security, Backup, And Recovery](security-backup-recovery.md), then restart and commission.

## Exclusive Engineer Focus Will Not Start

Check that:

- the target exists in the installed catalog;
- a channel value is inside range and grid-aligned;
- duration is within the configured maximum;
- the browser uses the same approved origin;
- RF Monitor is running.

Exclusive Engineer Focus is temporary and does not require Admin mode. Its failure does not change the saved profile. Selecting, pinning, or expanding a normal feed never starts focus.

## Exclusive Engineer Focus Did Not Resume

Refresh the dashboard and check `sudo rf-monitor logs 200`. A server restart clears temporary focus and resumes the deployment schedule. If needed:

```bash
sudo rf-monitor restart
sudo rf-monitor doctor
```

Verify that the focus action and interruption are present in evidence/audit records.

## Tier-1 Revisit Objectives Are Missed

Do not interpret a 2/6-second objective as a guarantee. Open health diagnostics and preserve the scheduler distribution/miss causes:

```bash
curl -fsS http://127.0.0.1:8080/api/health \
  | jq '{scheduler, receivers, processing, writer, disk, memory}'
sudo rf-monitor logs 300
```

Check for tune-confirm timeout, settling/discarded-frame delay, slow third frame, USB recovery, writer pressure, disk reserve, Exclusive Engineer Focus, or incorrectly admitted optional work. Under the default saturated fast profile, Tier 2, G3/E6/B3I, StarTrack, and 4DX should be disabled or **Paused — protecting GNSS**.

Stop qualification if optional work causes even one Tier-1 miss, old-frequency attribution occurs, or the health response lacks per-target revisit/miss causes. Save a support bundle. Return to the last feasible protected profile through Settings; do not shorten settle/discard gates merely to improve the displayed statistic.

## Target Remains Checking Or Baseline Is Stale

Checking is correct until the target has at least 30 minutes of valid coverage. Reviewable requires at least 24 representative UTC hours with the exact same receiver serial, antenna, gain/LNA state, target center/span, confirmed sample rate, FFT grid, analysis mask, SDRconnect version/display reference, catalog, detector version, and detector-rule hash. Isolated samples after an outage do not count as representative hours.

Check:

```bash
curl -fsS http://127.0.0.1:8080/api/settings | jq '{revision, feasibility, baselines}'
curl -fsS http://127.0.0.1:8080/api/health | jq '{receivers, scheduler, baselines}'
```

Expected: valid-visit/hourly coverage grows, fingerprint fields remain stable, and missing/mistuned visits are unknown rather than clean. Do not approve a baseline while an incident, overload, tune fault, data gap, receiver recovery, configuration change, or exclusive focus is active.

Baseline approval/restart requires Admin mode and the expected configuration revision. If a fingerprint changed unexpectedly, correct the RF/SDRconnect configuration and restart Learning deliberately. Protected baselines are immutable; do not delete/edit baseline files to force Normal.

## Live Traffic Or Switch Counters Are Too High

The production bounds are eight live dashboards, 1 MiB/s aggregate live payload (2 MiB burst), and 16/64/128 KiB/s for hidden/normal/Engineer clients. A ninth live dashboard must be rejected. The application drops obsolete frames at 64 KiB of client pressure and closes at 256 KiB or after 10 seconds.

Capture application and host state:

```bash
curl -fsS http://127.0.0.1:8080/api/health \
  | jq '{network, streaming, memory, processing}'
ip -s link
sudo ss -ntp | grep ':443'
```

On the managed switch, record before/after byte, output-queue drop/discard, error, pause/PFC, and port-reset counters for the host/dashboard paths. Do not clear counters without network-operations approval.

Expected: repeated identical subscriptions create no recurring acknowledgement/snapshot/replay, an empty target subscription is status-only, queues remain bounded, and switch egress drops/discards/pause counters do not increase.

Stop the soak if live traffic remains above 1 MiB/s, a queue grows, or a switch counter increases. Close surplus dashboards, preserve the health/log/support bundle and counter evidence, and confirm the installed Nginx configuration has separate `/live`, API/static, and export locations:

```bash
sudo nginx -t
sudo nginx -T 2>/dev/null | less
```

Do not raise the bandwidth/queue limits to hide the fault.

## Memory Pressure Or Status-Only Mode

At pressure (RSS at least 448 MiB, heap at least 80%, external buffers at least 128 MiB, or sustained queue/event-loop pressure), RF Monitor rejects new clients/exports and caps dashboards at 2 Hz. At critical pressure (RSS at least 576 MiB, evidence queue age at least two seconds, or disk below reserve), dashboards intentionally become status-only so scheduling, detection, and evidence retain priority.

Run:

```bash
systemctl show rf-monitor.service \
  -p ExecStart -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax -p NRestarts
curl -fsS http://127.0.0.1:8080/api/health \
  | jq '{memory, network, streaming, writer, disk, exports}'
```

Expected installed limits are `/usr/bin/node --max-old-space-size=384`, `MemoryHigh=512M`, and `MemoryMax=768M`. Status-only is a protection state, not a reason to restart repeatedly. Close unnecessary dashboards/export work, restore disk reserve, and let queues drain. If RSS/external buffers or queue age keep growing, save a support bundle and stop qualification. Do not weaken systemd limits or create a restart loop.

## Evidence Storage Unhealthy

Check:

```bash
df -h
df -i
sudo ls -ld /var/lib/rf-monitor/evidence
sudo -u rfmonitor test -w /var/lib/rf-monitor/evidence && echo writable
sudo rf-monitor logs 300
```

Possible causes:

- filesystem full or inode exhaustion;
- external disk unmounted;
- permission/ownership changed;
- read-only filesystem after an error;
- configured minimum free-space reserve reached;
- storage path changed without mounting the new disk.
- evidence finalization remained **Incomplete** after a hash, write, rename, or sync failure;
- a finalized session failed offline verification and is now **Corrupt**.

Do not delete the active session. Preserve required evidence, correct the mount/permissions, and use retention settings for future prevention.

For a named session or extracted export, run:

```bash
sudo rf-monitor verify-evidence /absolute/path/to/session-or-extracted-package-root
```

`INCOMPLETE` is readable but must retain its listed gaps. `FAIL` is not repaired by restarting or regenerating a manifest; preserve that copy, check the mount/filesystem, and restore a separately verified backup if site policy permits. A **Finalizing** source is temporarily refused for export; retry only after it becomes **Complete** or **Incomplete**.

If verified backup creation is refused:

- `active-domain-refused`: RF Monitor still owns Field or Test data. Stop it cleanly and confirm the lease disappears; never delete the lease file.
- `source-evidence-failed`: preserve the named source. A manifest, hash, path, or lifecycle is corrupt; restarting does not repair it.
- `source-evidence-incomplete`: the package can be published only as `INCOMPLETE`; retain its gap labels.
- `insufficient-destination-capacity` or `insufficient-restore-capacity`: choose a larger approved filesystem. Do not reduce the reserve below site policy merely to force the operation.
- `symlink-*-refused`, `path-must-be-absolute`, or `backup-path-*`: use the exact real absolute path. Do not bypass path checks.
- `interrupted-partial-present-use-recover`: run `status` for the exact backup ID, check the mount, then repeat the same create or restore command with `--recover`. Recovery removes only that operation's unpublished partial.
- `backup-id-exists-with-different-or-invalid-content`: choose a new backup ID and preserve the existing directory for investigation. A published ID is immutable.
- `restore-destination-not-empty-or-owned`: choose a new absent staging root. Restore never merges with an installation or existing evidence.

Run `verify --backup /absolute/package/path` again after transfer and before restore. The full command sequence is in [Security, Backup, And Recovery](security-backup-recovery.md).

If **Delete recordings** returns `Refused`, leave the retained active/finalizing/export work alone and retry only after the named work finishes. If it returns `Recovery required`, do not delete the quarantine or transaction journal by hand. Restart RF Monitor once; startup rolls back an uncommitted deletion or finishes cleanup after a committed deletion. Then check Recording and download diagnostics. The other data domain and exported ZIP files are outside this action.

Correct default ownership:

```bash
sudo chown -R rfmonitor:rfmonitor /var/lib/rf-monitor/evidence
sudo chmod 0750 /var/lib/rf-monitor/evidence
sudo rf-monitor restart
```

Use those commands only when `/var/lib/rf-monitor/evidence` is the confirmed configured path.

## Disk Usage Keeps Growing

Identify the owner:

```bash
df -h
sudo du -xhd1 /var/lib/rf-monitor /var/log 2>/dev/null
journalctl --disk-usage
```

- If evidence grows, reduce retention/archive/session limits in Settings after preserving required incidents.
- If journald grows, run `sudo rf-monitor configure` and lower service-log limits.
- If unexpected IQ files appear, stop commissioning: spectrum-only v1 must reject nonzero IQ configuration and count/drop unexpected IQ payloads.
- If another directory grows, RF Monitor retention cannot manage it.

## Clock Not Synchronized

```bash
timedatectl status
sudo timedatectl set-ntp true
systemctl status systemd-timesyncd --no-pager -l
timedatectl timesync-status
```

Check DNS, NTP reachability, organization time service, and virtualization clock behavior. Evidence continues to use UTC, but unsynchronized UTC is unreliable. Do not commission until resolved.

WSL may not provide production-quality time/USB behavior. Use it only as documented in [WSL Test Lab](wsl-ubuntu-24.04-test-lab.md).

## Status Is Always Normal During A Known Test Signal

Possible causes:

- wrong antenna or cable path;
- selected frequency is not in the active profile;
- current scan window has not revisited yet;
- signal is below relative threshold;
- SDRconnect gain/filter/sample rate is unsuitable;
- a provisional/operational baseline learned a persistent signal before adaptation froze;
- receiver overload flattened/distorted the spectrum;
- testing an `IQ File` rather than live hardware.

Use Engineer view, verify the physical-target bounds and central analysis mask, perform time-bounded Exclusive Engineer Focus, and correlate with a known signal source. Detector tuning must follow a documented clean baseline and hardware commissioning.

## Too Many Incidents

Do not immediately raise thresholds. First check overload, authorized transmitters, cable/antenna faults, gain, and local electromagnetic sources. Save examples, classify them, and compare clean/active periods. Adjust one detector variable at a time with an approved test record.

## WSL-Specific Problems

WSL is accepted for software stress testing only. Common limitations:

- USB receiver absent unless explicitly attached with Windows USB/IP tooling;
- dynamic WSL network addresses;
- browser reaches Windows localhost differently depending on configuration;
- time synchronization behavior differs from a physical Ubuntu host;
- restart/shutdown semantics differ;
- an `IQ File` may be the only SDRconnect source.

Do not use WSL results as production hardware acceptance. See [WSL Test Lab](wsl-ubuntu-24.04-test-lab.md).

## Escalation Package

When escalation is required, provide:

- exact UTC time and symptom;
- output of `sudo rf-monitor doctor`;
- redacted support bundle;
- RF Monitor and SDRconnect versions;
- whether source is physical RSP or IQ File;
- receiver model, USB topology, antenna/filter/gain notes;
- profile revision and configuration hash shown in Settings;
- incident package/checksum when permitted;
- changes immediately before failure.

Never provide passwords, `/etc/rf-monitor/admin.json`, CA private keys, server private keys, or unrelated evidence.
