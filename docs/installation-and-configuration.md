# Installation And Configuration

This is the complete deployment runbook for RF Monitor 1.0 on Ubuntu 24.04. Use [Start Here](START-HERE.md) for the shortest beginner path.

## Supported Architecture

Recommended production layout:

```text
SDRplay RSP -> USB -> Ubuntu 24.04
                       |-- SDRconnect_headless, local TCP 5454
                       |-- RF Monitor Node service, local TCP 8080
                       `-- Nginx HTTPS, TCP 443 from approved operator network
                                      |
                                      `-- operator web browsers
```

The Node service and SDRconnect remain bound to loopback. Nginx is the only LAN-facing service. Its `/live`, ordinary API/static, and export paths use separate proxy behavior. RF Monitor 1.0 does not use a LAN access token; network admission and HTTPS are the outer controls, and a separate Settings password protects configuration writes.

## Requirements

### Computer

- Ubuntu 24.04 LTS on x86-64 or an architecture supported by SDRconnect;
- systemd enabled;
- at least 2 CPU cores and 4 GiB RAM for a basic deployment; the production-like acceptance assumes about 15 GiB RAM;
- a reliable disk with at least 4 GiB free at installation and enough capacity for the chosen evidence policy;
- a stable wired network for production;
- an accurate clock with NTP synchronization;
- direct USB access to the SDRplay receiver.

Storage need depends on scan rate, selected targets, incidents, screenshots, and retention. IQ is disabled. The production-like acceptance assumes about 1.8 TB disk and a 1 GbE managed-switch path; commission with real measurements before choosing a final archive limit.

### Network

Prepare:

- a fixed IP address or DNS name for the Ubuntu host;
- the smallest operator CIDR that needs dashboard access;
- an approved TLS certificate, or permission to deploy the installer's local CA;
- outbound HTTPS and Ubuntu package access during installation.

Do not forward TCP 443 from the public internet. Do not expose TCP 5454 or 8080 to the LAN.

### RF Equipment

- a supported SDRplay RSP;
- antennas covering every enabled band;
- appropriate splitters, bias control, preselection, attenuation, surge/static protection, and low-loss cable designed by an RF engineer;
- a documented antenna/receiver chain for evidence interpretation.

The supported v1 sensor is one original RSPdx with one tuner. It cannot observe multiple physical windows simultaneously, and it cannot monitor frequencies its antenna chain rejects. Overload can resemble interference, so fixed gain and filtering are part of each baseline fingerprint and commissioning.

## Prepare Ubuntu

Sign in as the normal deployment user and confirm the release:

```bash
cat /etc/os-release
```

Expected values include:

```text
ID=ubuntu
VERSION_ID="24.04"
```

Check free space:

```bash
df -h /
```

Check the clock:

```bash
timedatectl status
```

`System clock synchronized` should become `yes`. The installer enables NTP, but unresolved time synchronization is a commissioning blocker.

## Obtain And Enter The Source Folder

Place the release source in a directory owned by the normal Ubuntu user. Then:

```bash
cd /path/to/rf-monitor
test -f package.json
test -f install.sh
```

Both commands should return silently. A `No such file` message means the current folder is wrong.

## Run The Installer

Run as the normal user:

```bash
bash install.sh
```

Never use:

```text
sudo bash install.sh
```

The script now rejects a root shell. It deliberately builds as the normal user and invokes `sudo` only for system changes.

If `/opt/rf-monitor` contains an older package without `dist/release.json`, the
installer stops before `sudo -v`, package installation, or directory changes.
Preserve the running installation. An approved migration package must be built
from the exact deployed source, or the candidate must be installed on a clean
host. Do not delete the old directory to bypass the identity gate.

### System Node.js

RF Monitor services always use:

```text
/usr/bin/node
/usr/bin/npm
```

Node.js 20 or newer is required. If the terminal uses an NVM path such as `/home/USER/.nvm/.../node`, the installer prints a note and still uses `/usr/bin/node`. This avoids service-account permission failures.

Verify after installation:

```bash
/usr/bin/node --version
sudo -u rfmonitor /usr/bin/node --version
```

Both commands must print a supported version. Do not place an NVM path in `/etc/rf-monitor.env` or the systemd unit.

### SDRconnect Installation

Install a versioned SDRconnect release from site-approved media before hardware commissioning. Verify the vendor signature or an independently published checksum first. RF Monitor deliberately does not download or execute SDRplay's mutable web installer.

If SDRconnect is missing, the RF Monitor installer names the expected path and continues in an unqualified state. Install the approved release, then rerun the installer or `sudo rf-monitor doctor`.

Afterward, verify:

```bash
test -x /opt/sdrconnect/SDRconnect_headless && echo "SDRconnect headless found"
/opt/sdrconnect/SDRconnect_headless --help
```

The current headless executable exposes WebSocket options including `--websocket_port`, `--websocket_pfxfile`, `--websocket_pfxpassword`, and `--websocket_configfile`. RF Monitor's local default uses plain `ws://127.0.0.1:5454/` because the traffic never leaves loopback. The dashboard itself still uses HTTPS.

If the graphical SDRconnect application is used for a manual test, open **Preferences** and enable **WebSocket Server**. The **Remote Devices** page is for SDRconnect remote-device hosts and is not where an RF Monitor token is obtained. SDRconnect's supplied WebSocket API does not document a bearer-token workflow for this local connection.

### Settings Password

The installer asks twice for a Settings password. Requirements:

- 12 to 128 characters;
- not reused from the Ubuntu account;
- stored in the approved credential manager;
- never supplied on a command line.

RF Monitor stores only a salted `scrypt` result and random signing secret in `/etc/rf-monitor/admin.json`. The file is root-owned and readable by the service group, not by ordinary users.

Reset later with:

```bash
sudo rf-monitor reset-admin-password
```

Existing Settings sessions are invalidated when the service restarts.

## Guided And Advanced Configuration

The normal installer and `sudo rf-monitor configure` use safe local defaults: `/var/lib/rf-monitor/evidence`, `ws://127.0.0.1:5454/`, device 0, a required 10 MS/s receiver rate, rejected/disabled IQ capture, backend port 8080, a 15-minute Settings session, and bounded system logs. RF Monitor requests the configured rate when necessary and does not accept frames until SDRconnect confirms it. The nominal display is 10 MHz, while detector analysis initially uses only the central 8 MHz or less and treats outer bins as guard/roll-off.

Use the advanced wizard only when an RF or Linux engineer has approved a different infrastructure design:

```bash
sudo rf-monitor configure --advanced
```

The advanced wizard exposes storage, SDRconnect endpoint, device index, expected sample rate, backend port, and log limits. A nonzero IQ value is invalid in spectrum-only v1. Monitoring targets and detection recommendations remain in the dashboard. Keep 9 MS/s experimental: passive noise-floor comparisons cannot establish sensitivity or flat usable bandwidth.

Before starting headless SDRconnect, configuration resolves the process owning its local API port. If SDRconnect GUI or another process owns that port, setup stops with its name and PID. It never kills that process silently. Close the GUI yourself or deliberately select another port in advanced configuration.

## HTTPS And Firewall


Run or rerun:

```bash
sudo rf-monitor configure-web
```

The wizard asks for:

1. dashboard DNS name or fixed IPv4 address;
2. allowed operator network in CIDR form;
3. generated local CA or an existing organization certificate;
4. permission to apply UFW rules.

It configures Nginx to:

- serve HTTPS on port 443;
- proxy `/live` WebSocket traffic separately from buffered ordinary API/static traffic;
- stream export downloads separately at a defensive 5 MiB/s per response while the application remains authoritative for the one-global-download budget;
- proxy all application traffic to `127.0.0.1:8080`;
- admit only the selected operator CIDR;
- add browser security headers;
- preserve the real client address for audit records.

UFW rules allow HTTPS only from that CIDR and explicitly block the Node and local SDRconnect ports. SSH is preserved only if an SSH listener/profile exists.

Before accepting firewall changes over a remote session, confirm that the operator CIDR and SSH access are correct.

### Trusting A Generated Local CA

Show the path and dashboard address:

```bash
sudo rf-monitor access
```

The easiest route is to create an operator connection kit in the Ubuntu user's
Downloads folder:

```bash
sudo rf-monitor access --export /home/USER/Downloads
```

Replace `USER` with the Ubuntu login name. The command creates a new,
timestamped folder containing:

- the public CA certificate (never its private key);
- the exact dashboard URL and allowed operator network;
- the CA SHA-256 fingerprint;
- beginner steps for Windows/Chrome, macOS/Chrome, and Ubuntu/Chrome;
- SHA-256 checksums for every kit file.

Transfer that folder through an approved secure channel and follow
`START-HERE.txt` on the operator computer. Compare its fingerprint with the
value printed directly on Ubuntu before trusting the CA.

You can also inspect the fingerprint manually:

```bash
openssl x509 -in /etc/rf-monitor/tls/rf-monitor-local-ca.crt -noout -fingerprint -sha256
```

Install it only on managed operator computers. Never distribute the `.key` file.
Close every Chrome window after installing the CA, reopen Chrome, and use the
exact URL in the kit. Do not substitute another IP address or hostname.

## Installed Files

Default locations:

| Purpose | Path | Ownership |
|---|---|---|
| Active application link | `/opt/rf-monitor/active` | `root:root` |
| Immutable releases | `/opt/rf-monitor/releases/BUILD_ID` | `root:root`, read-only |
| Deployment records | `/opt/rf-monitor/deployment-records` | `root:root` |
| Infrastructure environment | `/etc/rf-monitor.env` | `root:root`, mode 0600 |
| Versioned frequency catalog | `/etc/rf-monitor/catalog.json` | `root:rfmonitor`, mode 0640 |
| Settings credential | `/etc/rf-monitor/admin.json` | `root:rfmonitor`, mode 0640 |
| Installation path state | `/etc/rf-monitor/install.conf` | `root:root` |
| Operations paths/limits | `/etc/rf-monitor/ops.conf` | `root:rfmonitor`, mode 0640 |
| Active operational profile | `/var/lib/rf-monitor/config/operational.json` | `rfmonitor:rfmonitor`, mode 0640 |
| Profile revisions and audit | `/var/lib/rf-monitor/config` | `rfmonitor:rfmonitor` |
| Evidence sessions | `/var/lib/rf-monitor/evidence` | `rfmonitor:rfmonitor` |
| SDRconnect state | `/var/lib/rf-monitor/sdrconnect` | `rfmonitor:rfmonitor` |
| Restore dry-run staging | `/var/lib/rf-monitor/restore-drills` | `root:rfmonitor`, mode 0750 |
| Operations check records | `/var/lib/rf-monitor-ops` | systemd-managed, mode 0750 |
| RF Monitor service | `/etc/systemd/system/rf-monitor.service` | `root:root` |
| SDRconnect service | `/etc/systemd/system/sdrconnect-headless.service` | `root:root` |
| Nginx site | `/etc/nginx/sites-available/rf-monitor` | `root:root` |

Archive manifests and ZIP entries always use relative POSIX paths, even when a development build is run on Windows.

## Upgrade And Roll Back

Build and test the candidate in its source folder with the system runtime:

```bash
cd /absolute/path/to/rf-monitor-candidate
/usr/bin/npm ci
/usr/bin/npm run check
/usr/bin/npm run build
/usr/bin/npm run validate:release
```

Expected: every command exits successfully and `dist/release.json` exists. Stop if a test, build, or identity check fails.

Deploy the already-built candidate:

```bash
sudo rf-monitor deploy-release /absolute/path/to/rf-monitor-candidate
sudo rf-monitor releases
sudo rf-monitor doctor
```

Deployment copies the candidate to a versioned directory, runs the exact production install from `package-lock.json`, generates an SPDX SBOM and production dependency audit, verifies their hashes, checks disk/clock/TLS/Nginx/firewall state, and only then switches `/opt/rf-monitor/active`. Before the switch, it disables the exact recovery/operations timer set and stops any running one-shot jobs so none can inspect or restart mixed generations. The new service must report the same build ID. The application, recovery, and four operations service/timer pairs must load from the same active release with no drop-in or pending daemon reload; every new timer must be enabled, active, and have a future run. A failed health, unit, or timer check restores the complete previous unit bundle, release, and prior timer enable state automatically.

Preflight also binds `/etc/rf-monitor/ops.conf` to the current local health URL,
storage/evidence roots, certificate, and restore-staging path. A stale path stops
activation instead of monitoring the wrong files. The installer never invents
an off-host backup destination. Until `RFMON_OPS_BACKUP_ROOT` names an approved
mounted destination and a backup is verified, installation reports Attention
and production qualification remains blocked.

Expected: `releases` marks one build `ACTIVE`, older verified builds `READY`, and damaged builds `INVALID`. Stop if it reports `INVALID`, activation says the previous release could not be restored, or `doctor` reports a blocking failure.

Verify or deliberately restore an older build:

```bash
sudo rf-monitor verify-release BUILD_ID
sudo rf-monitor rollback-release BUILD_ID
sudo rf-monitor doctor
```

Replace `BUILD_ID` with an exact value printed by `sudo rf-monitor releases`. Rollback repeats the same preflight, loaded-unit, and build-identity health gates. It changes the application link; it does not delete or replace `/etc/rf-monitor*` or `/var/lib/rf-monitor` data.

Supply-chain files and immutable attempt records are stored under:

```text
/opt/rf-monitor/releases/BUILD_ID/deployment/
/opt/rf-monitor/deployment-records/
/opt/rf-monitor/current.json
```

Remote operator-browser reachability is a separate installed-site check. Deployment never infers it from localhost health.

## Initial Dashboard Configuration

Open the URL printed by:

```bash
sudo rf-monitor access
```

Then:

1. Select **Settings**.
2. Select **Admin mode**, enter the Settings password, and select **Enter admin mode**.
3. For a new GNSS-first installation, select the separate fast Tier-1 profile explicitly.
4. Confirm its four physical targets and the feasibility report. The 2/6-second revisit values are objectives, not guarantees.
5. Set site name, deployment ID, and display time zone.
6. Set evidence-retention limits based on the real disk.
7. Leave detector recommendations unchanged until the bounded 24-hour timing and signal-learning gate is complete.
8. Apply changes.
9. Confirm a new revision and evidence session.
10. Lock Settings.

The apply operation validates first. An invalid profile returns field-level errors and does not alter monitoring. A valid apply atomically saves a revision, finalizes the current evidence session, marks changed fingerprints stale or selects an exact prior match, starts a session with the new configuration hash, and resumes without restarting Node.js. Protected baselines remain immutable and are never silently deleted.

## Installation Verification

Run:

```bash
sudo rf-monitor doctor
sudo rf-monitor verify-sdr
sudo rf-monitor commission
```

Expected: the recovery-supervision checks confirm that the installed timer and service match this release, systemd has no pending reload or local drop-in, the timer is enabled and active with a future run, and the helper produced a fresh structured result. Stop if any of these checks fails; an enabled timer without a next run is not active supervision.

Also verify listeners:

```bash
sudo ss -lntp
```

Expected security posture:

- `127.0.0.1:5454` for SDRconnect;
- `127.0.0.1:8080` for RF Monitor;
- LAN address or all interfaces on `:443` for Nginx;
- no LAN listener for 5454 or 8080.

Verify active memory/file/task limits rather than assuming the source template was installed:

```bash
systemctl show rf-monitor.service \
  -p ExecStart -p MemoryHigh -p MemoryMax -p TasksMax -p LimitNOFILE
systemctl show sdrconnect-headless.service \
  -p MemoryHigh -p MemoryMax -p TasksMax -p LimitNOFILE
```

Expected RF Monitor values include `/usr/bin/node --max-old-space-size=384`, `MemoryHigh=512M`, and `MemoryMax=768M`. SDRconnect should report `MemoryHigh=768M` and `MemoryMax=1G`. Stop and correct the deployed units if these values are absent; `/opt/rf-monitor/active` and active systemd units may differ from workspace templates.

Check service logs:

```bash
sudo rf-monitor logs 200
```

Complete [Hardware Commissioning](hardware-validation.md) and [Fast-GNSS Commissioning And Resource Acceptance](fast-gnss-commissioning.md) before production acceptance.

## Removal

The safe default removes application services and code while preserving `/etc/rf-monitor`, `/etc/rf-monitor.env`, and `/var/lib/rf-monitor`:

```bash
sudo rf-monitor uninstall
```

Only `sudo rf-monitor uninstall --purge-data` removes configuration and evidence, and it requires typing `REMOVE`. Treat that operation as irreversible unless a separate backup exists.


## Upgrade Procedure

1. Schedule a maintenance window.
2. Download or place the new release in a normal-user-owned source folder.
3. Read the release notes.
4. Run from the new source:

   ```bash
   bash install.sh
   ```

5. A prior immutable release is retained for automatic rollback, and runtime data remains outside releases. An older unidentifiable package requires the sealed `legacy-install-snapshot` and `verify-current` procedure; it is never assigned fabricated release metadata. Set `RFMON_LEGACY_SNAPSHOT` only after the exact package, unit, protected configuration, candidate, and live receiver match. Failed first activation restores the captured legacy units and timer states.
6. An existing catalog is preserved; the schema-v3 vendor catalog is stored as a timestamped candidate for review.
7. A v2 catalog/profile migration must back up the prior revision and preserve the active selection. Fast Tier-1 is a separate explicit choice; SBAS is not silently enabled for an existing profile and G3/E6/B3I choices are not erased.
8. Existing profiles and credentials receive timestamped backups before replacement.
9. Run `sudo rf-monitor doctor` and hardware verification.
10. Confirm that historical incident ZIP hashes still verify.

Do not manually replace the active catalog during operation. Catalog changes alter the meaning of frequency evidence and require controlled review and commissioning.

## Unattended Installation

Unattended use is intended for managed automation, not first-time beginners. Install the approved system Node.js and SDRconnect releases first, then provide a protected password file:

```bash
sudo install -m 0600 /secure/input/settings-password /root/rf-monitor-settings-password
RFMON_NONINTERACTIVE=true \
RFMON_ADMIN_PASSWORD_FILE=/root/rf-monitor-settings-password \
bash install.sh
sudo shred -u /root/rf-monitor-settings-password
```

Do not put the password directly in an environment variable. HTTPS still requires `sudo rf-monitor configure-web` unless a valid previous web configuration is preserved.

## Next Guides

- [Configuration Reference](configuration-reference.md)
- [Operations](operations.md)
- [Troubleshooting](troubleshooting.md)
- [Security, Backup, And Recovery](security-backup-recovery.md)
- [Fast-GNSS Commissioning And Resource Acceptance](fast-gnss-commissioning.md)
