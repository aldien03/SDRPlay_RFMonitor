# Start Here: First RF Monitor Installation

This guide assumes you are not a Linux, Node.js, or web-server specialist. Follow the steps in order. Do not skip a red error and continue.

## What You Are Installing

One Ubuntu computer runs both:

1. **SDRconnect headless**, which talks to the SDRplay receiver and provides spectrum data on a local WebSocket.
2. **RF Monitor**, which schedules the selected bands, detects anomalies, saves evidence, and serves the dashboard through HTTPS.

Operator computers need only a modern web browser. They do not connect directly to SDRconnect.

The supported v1 sensor is one uncalibrated RSPdx with one tuner. It observes one physical RF window at a time. RF Monitor records spectrum only: IQ capture, absolute-dBm claims, spoofing classification, and claims of deliberate jamming are outside scope.

## Before You Begin

Prepare these items:

- an Ubuntu 24.04 computer, not an unsupported Ubuntu release;
- an SDRplay RSP supported by SDRconnect;
- the correct antennas and RF protection/filtering for every required band;
- internet access during installation;
- the RF Monitor source folder on Ubuntu;
- at least 4 GiB free for installation and initial evidence, with substantially more space recommended for operation;
- the IP network that operator computers use, for example your dedicated operations VLAN;
- a new Settings password with 12 to 128 characters.

Do not put passwords into scripts, command history, screenshots, support bundles, or documentation.

## Step 1: Open Ubuntu Terminal

Sign in as the normal Ubuntu user. Do not open a root shell.

Go to the RF Monitor source folder. Replace the example path with the actual path:

```bash
cd ~/rf-monitor
```

Confirm that you are in the correct place:

```bash
pwd
test -f install.sh && echo "RF Monitor source found"
```

Expected final line:

```text
RF Monitor source found
```

If that line does not appear, stop. Use `ls` to find the folder or ask the person who supplied the software where it was placed.

## Step 2: Connect The Receiver

Connect the SDRplay directly to the Ubuntu computer. Avoid an unpowered USB hub. Connect the correct antenna before commissioning, and follow the SDRplay hardware instructions for static protection and gain.

Check whether Ubuntu sees a USB device:

```bash
lsusb
```

This does not prove that spectrum streaming works. It only confirms that a USB device is visible.

## Step 3: Run The Installer

Run exactly:

```bash
bash install.sh
```

Do **not** run `sudo bash install.sh`. The installer itself requests `sudo` only for operating-system changes. This prevents root-owned project files and avoids private NVM Node.js installations.

The installer will:

- verify Ubuntu 24.04;
- install required operating-system packages;
- install the exact Node.js 20+ candidate only from an already configured signed APT repository;
- check for the separately installed, versioned SDRconnect release;
- build and run RF Monitor tests;
- create the protected `rfmonitor` service account;
- install the versioned frequency catalog;
- ask for a Settings password without showing it;
- use safe local infrastructure defaults;
- create and start system services;
- offer HTTPS and firewall setup;
- run a final diagnostic.

### Installer Questions

Use these rules when unsure:

- **Install system Node.js:** approve only the exact package version printed from the host's configured signed APT repository. If no Node.js 20+ candidate exists, stop and ask site IT to configure the approved repository.
- **SDRconnect missing:** stop hardware commissioning. Install a versioned SDRconnect release from approved media after verifying its signature or checksum; RF Monitor does not run a downloaded vendor script.
- **Settings password:** create a unique password. This password is needed only to change settings, not to view the dashboard.
- **Routine infrastructure:** the guided install automatically uses local SDRconnect, receiver 0, a 10 MS/s reported sample rate, rejected/disabled IQ capture, backend port 8080, protected evidence storage, and bounded logs. Detection uses only the configured central 8 MHz or less; the outer display bins are guard/roll-off regions.
- **Advanced infrastructure:** after installation, use `sudo rf-monitor configure --advanced` only when an engineer needs different ports, storage, or SDR endpoints.
- **Configure HTTPS:** answer Yes for any production or LAN deployment.

The installer does not ask for site frequencies, GNSS choices, detector thresholds, or evidence-retention policy. Those are changed later in the visual Settings page.

## Step 4: Read The Final Check

Run:

```bash
sudo rf-monitor doctor
```

The check explains each failure and prints a final result. Do not commission the system until the production host reports no blocking failures.

Useful checks:

```bash
sudo rf-monitor status
sudo rf-monitor logs 200
sudo rf-monitor verify-sdr
```

`verify-sdr` confirms the SDRconnect JSON API. It does not prove live RF reception. To require a real binary spectrum frame from the selected device:

```bash
sudo rf-monitor commission
```

Read the warning and confirm only when it is safe for the test to start the selected stream.

If SDRconnect reports only `IQ File`, the API is reachable but no physical receiver has been selected. Do not treat that as hardware acceptance.

## Step 5: Open The Dashboard

Show the exact address:

```bash
sudo rf-monitor access
```

Open the printed **Dashboard** address from an operator computer on the allowed network.

If the installer generated a local certificate authority, create the guided
operator connection kit:

```bash
sudo rf-monitor access --export /home/USER/Downloads
```

Replace `USER` with the Ubuntu login name, transfer the timestamped folder to
the operator computer, and follow `START-HERE.txt`. It contains the public CA,
the exact URL, the allowed network, the verified fingerprint, and steps for
Windows, macOS, and Ubuntu. It never contains the CA private key or a password.

Never bypass a certificate warning for routine production use. Correct the hostname, certificate trust, or computer clock instead.

## Step 6: Complete First-Time Settings

1. Open **Settings** in the dashboard.
2. Select **Admin mode**, enter the Settings password, and select **Enter admin mode**.
3. On **Monitoring profile**, select the separate fast Tier-1 profile for a new GNSS-first installation. Applying it is an explicit protected action; an upgrade must not silently change the active profile.
4. Confirm the physical targets: combined L1/E1/B1C/SBAS L1, GPS L2C, combined L5/E5a/B2a, and GLONASS G1.
5. Confirm Tier 2, G3, E6, B3I, StarTrack, and 4DX are disabled or say **Paused — protecting GNSS**. The default schedule has no safe optional-work reserve.
6. If the approved deployment is not GNSS-first, configure StarTrack/4DX only after a separate feasibility review. Invalid catalog-grid values are rejected.
7. Review the feasibility report and measured revisit objectives. The L1 2-second and L2/L5/G1 6-second values are objectives, not guarantees.
8. On **Site and time**, enter the real site name, deployment ID, and display time zone.
9. On **Evidence retention**, choose limits that fit the installed disk.
10. Leave **Engineer settings** at factory values until an RF engineer establishes a local clean baseline. Keep the antenna, LNA/gain, sample rate, SDRconnect display reference/base, and analysis mask fixed.
11. Select **Apply changes**.
12. Confirm that the dashboard reports the new revision and starts a new evidence session.
13. Select **Lock** when finished.
14. Confirm every new/fingerprint-changed target reports **Checking**, not Normal.

The service rejects an empty profile. Use **Pause** on the dashboard when monitoring is temporarily not required. Disabling a parent service preserves its child frequency selections for later re-enabling.

## Step 7: Understand The First Screen

- **Normal:** no detector rule was sustained in completed, valid observations. It is not a claim of continuous coverage.
- **Checking:** the target is learning, has stale configuration, or lacks enough valid observations.
- **Alert:** repeated relative RF evidence meets the suspected-interference rule.
- **Recovering:** observations are clean so far, but ten valid clean observations are required to clear.
- **Paused / Offline / Data late:** the target was not validly observed. These states are unknown, never clean.
- **Recording evidence:** evidence storage is healthy and the applicable observations are being saved.

Operator evidence is **Low** or **Medium**. RF-only v1 never generates High evidence. RF data can show interference, not intent.

Select **Engineer** only when spectrum, waterfall, raw metrics, or advanced display controls are needed. Use **Evidence History** for the persisted session/incident archive.

## Step 8: Perform Hardware Commissioning

Installation success is not commissioning. Complete [Hardware Commissioning](hardware-validation.md), [Fast-GNSS Commissioning And Resource Acceptance](fast-gnss-commissioning.md), and the fail-closed V7 gate in [V7 Development Qualification](v7-v8-site-qualification.md). V7 is capped at 24 elapsed hours.

## Software-Ready Versus Commissioned

A host with no receiver attached can finish as `SOFTWARE READY — HARDWARE COMMISSIONING PENDING`. This is a successful software installation, not RF acceptance. Connect the RSP and correct antenna chain, then run:

```bash
sudo rf-monitor commission
```

The command requires USB discovery, the SDRconnect JSON API, a selected physical device, and a real binary spectrum frame. It does not prove sensitivity, flat usable bandwidth, or calibrated power. RF evidence can support an interference finding; it cannot prove deliberate jamming intent or GNSS spoofing.


## Daily Commands

```bash
sudo rf-monitor access
sudo rf-monitor doctor
sudo rf-monitor status
sudo rf-monitor logs 200
sudo rf-monitor restart
```

Use `sudo rf-monitor configure` only for infrastructure such as receiver URLs, local ports, storage paths, or system-log limits. Use the dashboard **Settings** page for monitoring, site, time zone, detection, and retention.

## Stop And Get Help When

Stop instead of guessing if any of these occur:

- `sudo rf-monitor doctor` reports a blocking failure;
- the dashboard says **Offline** or **Data late**;
- evidence storage is unhealthy;
- `verify-spectrum` receives no binary spectrum frame;
- the clock is not synchronized;
- HTTPS is not trusted by the operator computer;
- only an `IQ File` source appears when a physical receiver is expected;
- the requested 4DX profile has fewer than 51 channels;
- disk free space is below the configured reserve.
- the feasibility report is missing or Tier-1 is infeasible;
- the application reports absolute dBm, spoofing, deliberate intent, or High evidence from RF-only data;
- a ninth dashboard is admitted as live, network queues grow, or managed-switch egress drops/discards/pause counters increase.

Continue with [Troubleshooting](troubleshooting.md). Create a redacted diagnostic archive with:

```bash
sudo rf-monitor support-bundle
```

The Settings credential file and evidence payload are excluded from that bundle.
