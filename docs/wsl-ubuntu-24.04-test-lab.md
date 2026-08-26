# Ubuntu 24.04 WSL Test Lab

WSL is useful for build, migration, API, authentication, persistence, restart, corruption-recovery, and log-retention tests. It is not a production RF evidence platform and does not replace commissioning on a physical Ubuntu 24.04 host.

## What WSL Can Prove

- system Node.js build and service execution;
- SDRconnect headless executable starts;
- SDRconnect JSON WebSocket API is reachable;
- RF Monitor simulation workflows;
- protected Settings, revision conflicts, validation, audit, and Exclusive Engineer Focus;
- atomic profile persistence and recovery;
- restart/reconnect behavior;
- browser desktop/mobile workflows;
- bounded evidence and system logs.
- idempotent live subscriptions, client admission, and bounded live payload/queues.

## What WSL Does Not Prove By Default

- a physical SDRplay is attached;
- binary spectrum comes from live RF;
- USB remains stable over long periods;
- antenna, gain, overload, or calibrated receiver behavior;
- production clock behavior after host sleep/restart;
- production firewall, routing, power-loss, or disk durability;
- legal/operational suitability of evidence.
- RSPdx 10 MS/s sensitivity, analog flatness, or real 2/6-second tune/revisit behavior.

An SDRconnect source named `IQ File` proves software/API connectivity only.

## Create Ubuntu 24.04 WSL

In Windows PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
wsl --shutdown
```

Start **Ubuntu 24.04** from the Start menu and create a normal Linux user/password when prompted. Do not place that password in any script.

Check the distro from PowerShell:

```powershell
wsl --list --verbose
```

## Enable systemd

Inside Ubuntu:

```bash
sudo nano /etc/wsl.conf
```

Ensure it contains:

```ini
[boot]
systemd=true
```

Save, close, then in Windows PowerShell:

```powershell
wsl --shutdown
```

Reopen Ubuntu and verify:

```bash
systemctl is-system-running
```

`running` or `degraded` with an understood unrelated unit is acceptable for the lab. RF Monitor and SDRconnect units themselves must be active when tested.

## Keep Source On The Linux Filesystem

Building below `/home` avoids Windows-mount permission and performance surprises. From Ubuntu, copy/extract the release into a Linux directory, for example:

```bash
mkdir -p ~/src
cp -a /mnt/c/path/to/rf-monitor ~/src/rf-monitor
cd ~/src/rf-monitor
```

Replace the Windows path. Confirm:

```bash
pwd
test -f deploy/install-ubuntu.sh && echo ready
```

## Install System Node.js

The RF Monitor installer handles this, but the lab can preflight:

```bash
command -v /usr/bin/node || true
```

Run the supported installer as the normal WSL user:

```bash
bash deploy/install-ubuntu.sh
```

Do not run it with `sudo`. Accept Node.js 22 when offered. Verify:

```bash
/usr/bin/node --version
/usr/bin/npm --version
sudo -u rfmonitor /usr/bin/node --version
```

An interactive `command -v node` may still point into NVM. RF Monitor services must use `/usr/bin/node`.

## Install SDRconnect In WSL

The RF Monitor installer does not download SDRconnect. Install a versioned, checksum- or signature-verified SDRconnect release separately. After installation:

```bash
test -x /opt/sdrconnect/SDRconnect_headless && echo "SDRconnect installed"
/opt/sdrconnect/SDRconnect_headless --help
sudo systemctl status sdrconnect-headless.service --no-pager -l
```

The RF Monitor-managed service uses a local WebSocket port, normally 5454. Test:

```bash
nc -vz 127.0.0.1 5454
sudo rf-monitor verify-sdr
```

If the API reports `IQ File` and no RSP, that is expected until USB is attached and recognized.

## Optional Physical USB Attachment

USB attachment to WSL requires current Microsoft-supported Windows USB/IP tooling and administrator approval. The Windows-side workflow generally is:

1. list USB devices;
2. bind/share the SDRplay bus ID;
3. attach that bus ID to the `Ubuntu-24.04` distro;
4. confirm with `lsusb` inside WSL.

Tool syntax changes over time. Follow the current Microsoft WSL USB documentation for the installed Windows/usbipd version rather than copying an old command blindly.

After attachment:

```bash
lsusb
sudo rf-monitor restart
sudo rf-monitor verify-sdr
sudo rf-monitor verify-spectrum
```

Even if this works, repeat all hardware tests on physical Ubuntu before acceptance.

## Software-Only Build Test

From the source folder:

```bash
/usr/bin/npm ci
/usr/bin/npm run check
/usr/bin/npm run build
```

Expected: TypeScript succeeds and all Vitest files pass.

## Isolated Simulation Test

Do not reuse the production evidence directory. Use a temporary lab root:

```bash
LAB_ROOT="$(mktemp -d /tmp/rf-monitor-lab.XXXXXX)"
cp config/band-catalog.example.json "$LAB_ROOT/catalog.json"
cp config/operational.example.json "$LAB_ROOT/operational.json"
mkdir -p "$LAB_ROOT/evidence"
```

Create a temporary Settings credential without putting a password on the command line:

```bash
read -r -s -p 'Temporary lab Settings password: ' LAB_PASSWORD
printf '\n'
printf '%s' "$LAB_PASSWORD" | /usr/bin/node dist/server-node/admin-credential.js > "$LAB_ROOT/admin.json"
unset LAB_PASSWORD
chmod 0600 "$LAB_ROOT/admin.json"
```

Start RF Monitor on a non-production port:

```bash
env \
  RF_MONITOR_REQUIRE_EXPLICIT_CONFIG=true \
  RF_MONITOR_HOST=127.0.0.1 \
  RF_MONITOR_PORT=18080 \
  RF_MONITOR_STORAGE="$LAB_ROOT/evidence" \
  RF_MONITOR_CATALOG_FILE="$LAB_ROOT/catalog.json" \
  RF_MONITOR_OPERATIONAL_FILE="$LAB_ROOT/operational.json" \
  RF_MONITOR_ADMIN_FILE="$LAB_ROOT/admin.json" \
  RF_MONITOR_SIMULATION=on \
  RF_MONITOR_WSL_TEST_MODE=true \
  /usr/bin/node dist/server-node/index.js
```

Open `http://127.0.0.1:18080/` for this local-only lab. Press `Ctrl+C` when finished.

Never set `RF_MONITOR_SIMULATION=on` in production.

## Required WSL Stress Scenarios

Run these against the isolated lab, not `/var/lib/rf-monitor`:

1. enter **Admin mode** and apply at least 20 valid revisions;
2. submit an invalid empty profile and confirm `422` with no runtime change;
3. reuse a stale revision and confirm `409`;
4. start/stop Exclusive Engineer Focus repeatedly and confirm automatic resume plus suspended-objective audit records;
5. stop/restart RF Monitor and confirm the last revision loads;
6. interrupt/corrupt a copy of the active profile and confirm recovery from a valid revision;
7. stop/start SDRconnect and confirm RF Monitor reconnects;
8. use temporary small evidence limits and confirm oldest closed sessions recycle;
9. confirm journald maximum-use/retention settings on the installed service;
10. run desktop and mobile browser workflows without console errors.
11. replay 100,000 semantically identical live subscriptions and confirm exactly one bootstrap/replay, no recurring acknowledgement/control traffic, and no memory slope;
12. confirm an empty target list remains status-only, eight dashboards are admitted, a ninth live dashboard is rejected, and removed target buffers are immediately pruned;
13. confirm hidden/normal/Engineer traffic and slow-client queues stay within the documented resource budgets.

After each test, inspect:

```bash
find "$LAB_ROOT" -maxdepth 3 -type f -print
df -h "$LAB_ROOT"
```

## Test The Installed Services

```bash
sudo rf-monitor doctor
sudo rf-monitor status
sudo rf-monitor logs 300
sudo rf-monitor verify-sdr
```

The doctor intentionally identifies WSL as a test environment. That warning is expected and must not be suppressed in a production acceptance record.

## Browser Access From Windows

Modern WSL usually forwards Linux localhost to Windows. Try the local URL printed by:

```bash
sudo rf-monitor access
```

For the isolated lab, use `http://127.0.0.1:18080/`. If unavailable:

```bash
hostname -I
sudo ss -lntp
```

Do not expose the lab service broadly merely to work around localhost forwarding.

## Clean Up The Isolated Lab

Stop the foreground lab server first. Verify the exact variable:

```bash
printf '%s\n' "$LAB_ROOT"
```

It must begin with `/tmp/rf-monitor-lab.`. Then remove only that verified directory:

```bash
case "$LAB_ROOT" in
  /tmp/rf-monitor-lab.*) rm -rf -- "$LAB_ROOT" ;;
  *) echo "Refusing unexpected path: $LAB_ROOT" ;;
esac
```

Do not remove `/opt/rf-monitor`, `/var/lib/rf-monitor`, `/etc/rf-monitor`, or the physical production evidence archive.

## WSL Exit Criteria

Software validation passes when:

- system Node executes for the service account;
- build/tests pass;
- SDRconnect JSON API connects;
- Settings security and revisions behave correctly;
- persistence, recovery, focus, restart, and retention tests pass;
- browser workflows pass at desktop/mobile sizes;
- no test used embedded credentials.

Production remains blocked until [Hardware Commissioning](hardware-validation.md) and the [Fast-GNSS Resource Acceptance](fast-gnss-commissioning.md) pass on physical Ubuntu with a real RSPdx, final antenna chain, managed switch, storage, and operator dashboards.
