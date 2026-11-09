# Operations Guide

This guide covers routine use after installation and hardware commissioning.

## Roles

### Operator

An operator can:

- view monitoring and storage status;
- pause/resume monitoring;
- read an incident and recommended action;
- add a factual note;
- acknowledge an incident;
- download an evidence package;
- use Engineer details and Exclusive Engineer Focus when authorized.

### Configuration Administrator

The Settings password additionally allows profile, site, time-zone, detector, and retention changes. It does not grant Ubuntu root access.

### System Administrator

An Ubuntu administrator uses `sudo rf-monitor ...` for services, receiver endpoints, storage paths, HTTPS, firewall, backup, and password reset.

## Start Of Watch

1. Open the URL supplied by the system administrator.
2. Confirm the browser shows a trusted HTTPS connection.
3. Confirm the site name in the header is the intended installation.
4. Confirm the receiver header says **Monitoring** and **Spectrum stream live**.
5. Confirm the archive says **Recording evidence**.
6. Confirm the main status is not **Offline** or **Data late**.
7. Review every coverage warning and measured revisit objective.
8. Confirm the displayed time zone is expected. Evidence remains UTC regardless.

If any check fails, do not interpret **Normal** as proof of a clear spectrum. Follow [Troubleshooting](troubleshooting.md).

## Main Dashboard

The default view intentionally avoids spectrum controls.

### Monitoring Checklist

Each enabled service shows selected coverage, whether it is being observed now or waiting in the scan queue, and estimated revisit. Disabled services are clearly marked.

The supported RSPdx is one uncalibrated, single-tuner sensor. A queued service is temporarily unobserved while another physical target is active. This is a real coverage gap. The 2/6-second Tier-1 values are measured objectives, not continuous-coverage guarantees.

### Status

- **Normal:** no rule is sustained in completed valid observations.
- **Checking:** a baseline is learning/stale or valid coverage is insufficient.
- **Alert:** repeated relative RF evidence matches the suspected-interference rule.
- **Recovering:** the anomaly has stopped so far; ten valid clean observations are required to clear.
- **Paused / Data late / Offline:** there is no valid current observation. The RF condition is unknown.

Status includes affected logical signals/physical target, evidence strength, and start/last-observation time. RF-only v1 reports Low or Medium evidence, never High.

### Active Incident

When an incident exists, read in order:

1. status and evidence strength;
2. affected service and frequency range;
3. **What we see**;
4. **Recommended action**;
5. evidence-recording state.

The wording describes received RF conditions. It does not accuse a source or prove intent.

### Header Commands

- **Pause/Resume:** temporarily stops/starts scan scheduling without changing the saved profile.
- **Engineer:** shows spectrum, waterfall, raw metrics, and display controls.
- **Help:** opens the version-matched offline operator guide at `/help`. It covers alert response, RF-data recovery, recording, signal learning, and simulation tests without requiring server access.
- **Evidence History:** shows the persisted session/event archive and downloads; it does not require Engineer mode.
- **Settings:** opens the protected deployment workflow.

## Responding To An Incident

### 1. Confirm Evidence Is Healthy

The incident panel must say evidence is being saved. If storage is unhealthy, preserve what is already available and escalate immediately.

### 2. Read Before Changing Anything

Record the affected service, frequency, start time, evidence strength, and observation. Avoid changing antennas, gain, cables, or profile until the initial evidence is saved unless safety requires it.

### 3. Add A Factual Note

Select **Add note** and record only observable facts, for example:

```text
Operator observed loss of vessel GNSS fix at 14:32 UTC. Independent receiver alarm active. No antenna or gain changes made.
```

Avoid unsupported conclusions such as naming a jammer. Notes become evidence records.

### 4. Acknowledge

Select **Acknowledge** after the incident has been seen and assigned. Acknowledgement does not close, delete, or downgrade the event.

### 5. Download Evidence

Select **Download evidence package**. The queued export contains the incident slice, not the entire session. The browser downloads it directly after the application streams its SHA-256; large incidents are numbered multipart archives without truncation.

Open the incident first. The drawer leads with the verdict, the **disturbed frequencies** and the action, then **Why this alert**: the rule that fired, how strong and how wide the raised energy was against the alert level in force, and how often it repeated. Below that are a picture of exactly what the detector compared when the alert was raised, the timeline, notes and the evidence actions. **Incident report** opens the client report exactly as it is delivered, with **PDF**, **Open to print** and **Evidence package** buttons.

The package file is named `RF-Incident_<start UTC>_<window>_<id>.zip`. After the download, the drawer shows its SHA-256 with a Copy button; record it with the transfer.

Package contents:

| Path | Contents |
|---|---|
| `report.pdf`, `report.html` | The client report (same content): cover with company, client, vessel and project; summary; why the alert was raised; spectrum at the alert, before/during spectrum and waterfall; timeline; analysis; receiver and configuration; operator notes; evidence integrity; limitations and terms. |
| `report.json` | The report as data. |
| `README-VERIFY.txt` | What is in the package and how to check it on Linux, macOS, Windows and the RF Monitor host. |
| `incident.json`, `events/history.jsonl` | The incident record (including its stored trigger, peak values and timeline) and every stored version of it. |
| `spectrum/` | The recorded frames: the evidence itself. |
| `evidence/trigger-snapshot.json` | The levels, usual level and alert level the detector compared when the alert was raised. |
| `evidence/screenshots/`, `evidence/notes/` | Screenshots and operator note files for this incident. |
| `logs/` | Operations, configuration-audit (with the preceding hash-chain entry) and SDRconnect logs for the incident window plus 10 minutes. |
| `source-context/` | Configuration, receiver snapshot and integrity record of each recording session. |
| `figures/` | Overview sheet, waterfall image and the four analysis charts as stand-alone, time-stamped files. |
| `export-record.json` | When, from which address and by which software the package was made. |
| `manifest.json`, `SHA256SUMS.txt` | SHA-256 of every file, including the report. |

To check a package, extract it and run `sha256sum -c SHA256SUMS.txt` (Linux), `shasum -a 256 -c SHA256SUMS.txt` (macOS), or `Get-FileHash -Algorithm SHA256` per file (Windows), or `sudo rf-monitor verify-evidence <folder>` on the host. Every line must report OK.

The report and charts are derived from the recorded frames. Analysis counts "above the alert level" with the incident's own sensitivity, and also shows the looser "above usual range" (three normal variations) for context. When few frames were recorded before the incident, the report says the comparison is weak. Levels are relative and uncalibrated. RF data can show interference, not intent.

Store the ZIP in the approved incident repository. Do not rename or modify its contents before verification. Record who transferred it and where it was stored according to local procedure.

### 6. Correlate Independently

For GNSS, correlate with independent receiver data, clock behavior, satellite count, C/N0, position/velocity jumps, NMEA/UBX logs, and operational reports. RF Monitor spectrum alone does not classify spoofing, and matched-power spoofing may not be distinguishable from legitimate RF spectrum.

For radio services, correlate with link alarms, known transmit schedules, receiver overload indicators, antenna state, and nearby authorized emitters.

## Engineer Details

Select **Engineer** to expose technical evidence.

### Spectrum And Waterfall

- Spectrum is the latest observed window.
- Waterfall shows recent frames for that same observed window, newest at the top.
- Frequency labels describe the actual frame bounds, not the complete service range.
- Uncalibrated SDRconnect display bins are labelled as relative values.
- SDRconnect power/SNR fields, when present, remain explicitly vendor-reported/relative; they are not calibrated dBm.
- The nominal 10 MHz display shades outer guard/roll-off bins; detector analysis uses the configured central 8 MHz or less.

### Metrics

- mean and peak bin;
- baseline delta;
- occupied-bin ratio;
- supplied power and SNR, when available;
- overload flag;
- raw frame ID.

An overload flag can indicate receiver-chain saturation rather than external interference. Check gain, strong local transmitters, and filtering.

### Display Options

Waterfall, baseline, markers, audio alert, and browser notification choices are local to the browser. They do not alter evidence detection or the deployment profile.

Browser notifications require user permission. Audio can be blocked until the browser has received an operator interaction.

## Exclusive Engineer Focus

Use Exclusive Engineer Focus only for a time-limited investigation of one valid channel or physical GNSS target. Merely selecting, pinning, or expanding a normal feed never changes tuner behavior.

1. Open **Settings**.
2. Stay on **Monitoring profile**.
3. In **Exclusive Engineer Focus**, choose the target.
4. Enter/select a valid channel frequency when available.
5. Choose a short duration.
6. Read the two-step warning and confirm every objective that will be suspended.
7. Select **Start focus**, then watch the countdown and truthful Paused states.
8. Select **Resume monitoring** early when finished, or let the timer expire.

Exclusive Engineer Focus does not require the Settings password because it does not change the saved profile. It is still origin-protected, time-bounded, and fully recorded in the evidence session.

During focus, the rest of the one-tuner deployment is not being scanned. Never leave focus running without an operational reason.

## Changing The Deployment Profile

1. Open **Settings**.
2. Enter the Settings password.
3. Make the smallest required change.
4. Review feasibility, measured revisit objectives, and actual unobserved gaps.
5. Review field warnings.
6. Select **Apply changes**.
7. Confirm the new revision number and success message.
8. Return to the dashboard and confirm monitoring resumes.
9. Select **Lock**.

The current evidence session closes and a new session starts after a successful change. Rejected changes do not alter the running profile.

## Evidence Archive

Open **Evidence History** to view persisted sessions and incident history. It is intentionally separate from Engineer tools.

Each session can contain:

- session/configuration metadata;
- catalog version and profile selection;
- SDRconnect receiver metadata;
- spectrum frame summaries and raw bins;
- event JSONL and operator actions;
- screenshots;
- tune/configuration epochs, discarded frames, gaps, drops, and relative calibration state;
- configuration audit entries;
- final SHA-256 manifest.

IQ is disabled and unexpected IQ payloads are dropped/counted. Sessions rotate at 2 GiB or 24 hours, raw chunks at one hour/128 MiB, and a long incident continues across parts. **Complete** means the manifest, checksums, and final descriptor commit passed. **Incomplete** keeps named gaps; **Corrupt** is retained and is not exported as intact evidence. The older **closed** label is not a completeness result. Active, Finalizing, and Corrupt sessions are not eligible for retention removal.

**Delete recordings** is a protected, domain-specific action. It removes finalized sessions only from the Field or Test domain explicitly shown in the confirmation. The current recording, sessions still finalizing, export-leased sessions, and exported ZIP files remain. The result reports exact deleted session and byte counts plus every retained class. `Refused` means no recording was deleted; `Recovery required` means a committed deletion needs startup cleanup and must be reviewed before repeating the action.

## Verifying An Export On Ubuntu

Copy the ZIP into an empty verification folder:

```bash
mkdir -p ~/rf-evidence-check
cd ~/rf-evidence-check
unzip /path/to/incident-package.zip
find . -maxdepth 3 -type f -print
sudo rf-monitor verify-evidence "$PWD/EXTRACTED_PACKAGE_ROOT"
```

Replace `EXTRACTED_PACKAGE_ROOT` with the directory that directly contains `manifest.json`. Expected output is `PASS`, `INCOMPLETE`, or `FAIL`. Stop and preserve the copy if the result is `FAIL`. Keep every numbered part together and use the multipart command in [Security, Backup, And Recovery](security-backup-recovery.md). Do not treat the ZIP transport checksum as a substitute for verifying manifest entries and the lifecycle commit.

For a simple transfer checksum:

```bash
sha256sum /path/to/incident-package.zip
```

Record that value separately at transfer time.

## Verified Backup Check

RF Monitor backup is an offline maintenance task. It copies both Field and Test roots plus the non-secret configuration/audit allowlist, verifies every manifest-v1/v2 evidence package, and publishes one immutable directory. It never includes Settings credentials, environment files, passwords, or private keys.

After stopping RF Monitor and confirming `/var/lib/rf-monitor/evidence` has no `.rf-monitor-active.json` lease, run the dry-run first:

```bash
BACKUP_ID="rf-monitor-$(date -u +%Y%m%dT%H%M%SZ)"
sudo -u rfmonitor env RFMON_INSTALL_DIR=/opt/rf-monitor/active \
  /opt/rf-monitor/active/deploy/rf-monitor-backup.sh create \
  --data-root /var/lib/rf-monitor/evidence \
  --config runtime=/var/lib/rf-monitor/config \
  --config system=/etc/rf-monitor \
  --destination /absolute/approved/mounted-backup-root \
  --backup-id "$BACKUP_ID" \
  --minimum-free-bytes 5368709120 \
  --dry-run
```

Proceed without `--dry-run` only when the source/destination paths, exact byte count, exclusion counts, and available capacity are correct. `PASS` is internally consistent. `INCOMPLETE` remains usable only with its named evidence gaps. `FAIL` is refused. `recovery-required` needs the exact-ID status/recovery procedure; never remove a `.partial` path by hand.

Full create, verify, interrupted-copy recovery, and empty-root restore commands are in [Security, Backup, And Recovery](security-backup-recovery.md). A successful local command does not establish that the destination is approved off-host media or that bare-host recovery has been witnessed.

## Routine System Checks

### Dashboard System Health

Open **Settings > System health** at the start of a watch and whenever the Engineer drawer reports Attention or Critical. This page is read-only and does not require Admin mode.

Read the overall state first:

- **Normal**: no current software, recording, receiver, or host fault is known.
- **Attention**: operation can continue, but one or more bounded counters or objectives need review.
- **Critical**: evidence, receiver flow, disk reserve, or resource protection is at risk. Follow the first listed safe action before qualification continues.
- **Simulation**: software-generated RF frames are active. USB and SDRconnect are **Not tested**; this state cannot satisfy hardware commissioning.

The normal view shows five checks: **Receiver**, **RF data**, **Recording**, **Scan coverage**, and **Signal learning**. **Needs attention** combines repeated reports of the same operator problem and sorts the most urgent first. Each item shows the observed value and limit when available, the latest occurrence, the count, one safe action, and a collapsed **What to do** procedure with a success check and stop condition.

Open **Engineer details** only when the first action asks for it or a support procedure needs exact counters. Receiver stages, CPU/memory, network, writer, disk, timing distributions, ten-minute trends, diagnostic downloads, and support commands remain there. The trends are browser-local and contain only CPU, RSS, bandwidth, loss, and writer delay. Closing or refreshing the page clears them. Visible pages poll every two seconds; hidden pages poll every ten seconds and do not queue overlapping requests.

### Protected Maintenance Actions

Unlock Settings before using any maintenance action. Each action has its own confirmation and audit entry:

- **Recording > Clear test data** removes only test recordings, test incidents, and test signal learning. Field data and settings remain.
- **Advanced > Signal learning > Learning details > Restart learning** starts a new generation for one named signal. The approved normal level and recordings remain. If an alert is active on that signal, the confirmation names it and restarting ends it; the incident stays in Evidence History marked as ended by the operator, and the audit log lists the ended incident IDs. Until learning is approved, alerts from that signal are Low evidence, and until the first 64 observations of that signal are collected (a few minutes) it flags nothing.
- **Recording > Delete recordings** removes finalized recordings only from the named active Field or Test domain. Active, finalizing, export-leased recordings, exports, learning, and settings remain.
- **Advanced > Software recovery > Restart software** requests the bounded external application-recovery helper. It does not expose `systemctl`. Recordings, learning, and settings remain.

A request being accepted is not success. Keep **System health** open. Success is shown only after the recovery helper reports a verified result; after a software restart, separately confirm **RF data** is Live and **Recording** is On. Stop after a cooldown, lockout, unavailable helper, repeated failure, or any continued recording fault.

Network counters have separate scopes:

- **Application** counts traffic and delivery pressure handled by RF Monitor.
- **Host NIC** reads the active non-loopback Linux interfaces and reports byte/error/drop counters without exposing IP or MAC addresses.
- **Managed switch** remains **External — not connected**. Record its port counters separately using the approved network procedure; the dashboard does not use SNMP.

Intentional tune settling and frame coalescing are work discarded by design. Invalid/stale frames, unknown visits, missed objectives, browser delivery drops, and evidence-frame loss are separate counters. Do not add them together or report an intentional discard as lost evidence.

### Daily

```bash
sudo rf-monitor doctor
sudo rf-monitor status
```

Expected: doctor reports that the receiver recovery timer is enabled, active, has a next run, and has produced a fresh structured result. `failed` or `lockout` is a stop condition for production qualification. Also check the dashboard start-of-watch items.

The local health endpoint exposes one atomic schema-versioned snapshot without credentials:

```bash
curl -fsS http://127.0.0.1:8080/api/health \
  | jq '{schemaVersion, summary, receiverPath, dataContinuity, software, network, evidence, schedule}'
```

It is normal for intentional tune discards or obsolete-frame coalescing to increase. Investigate actual loss counters, continuously growing resident/external memory, writer age approaching two seconds, growing queues, repeated slow-client drops, status-only pressure mode, or live traffic approaching 1 MiB/s. A missing schema version, structured summary, or task section means this release has not met diagnostics acceptance.

### Weekly

```bash
sudo rf-monitor logs 200
df -h /var/lib/rf-monitor/evidence
journalctl --disk-usage
```

Confirm automatic session rotation and evidence-retention removals are occurring as configured.

### Monthly And After Changes

```bash
sudo rf-monitor verify-sdr
sudo rf-monitor verify-spectrum
sudo rf-monitor support-bundle
```

Repeat a controlled RF commissioning signal, an incident export, restart/reconnect test, and archive restore sample according to site policy.

## Log And Evidence Recycling

Two independent controls prevent disk exhaustion:

1. Dashboard **Evidence retention** limits session age, total archive bytes, maximum session age/size, and minimum free bytes.
2. `sudo rf-monitor configure` limits journald maximum use, minimum free bytes, and log age.

Do not use `rm -rf` against the evidence directory. If emergency space is required, stop RF Monitor, preserve the active session, follow the approved evidence-disposition process, and use [Security, Backup, And Recovery](security-backup-recovery.md).

## Restart And Shutdown

Restart both services:

```bash
sudo rf-monitor restart
sudo rf-monitor doctor
```

Stop cleanly before planned power maintenance:

```bash
sudo rf-monitor stop
```

Start afterward:

```bash
sudo rf-monitor start
sudo rf-monitor doctor
```

The service finalizes evidence on controlled shutdown when possible. An abrupt power loss is detectable through incomplete session state and should be documented.

## End Of Watch

1. Review unacknowledged incidents.
2. Confirm evidence remains healthy.
3. Export incident packages required by procedure.
4. Record any coverage gaps/revisit misses, Exclusive Engineer Focus use, receiver disconnects, pressure state, or storage warnings.
5. Leave monitoring running unless an authorized shutdown is planned.

Select **Exit admin mode** before leaving an operator computer unattended.

## Automatic incident images

When **Settings > Recording > Incident images** is on (the default), RF Monitor saves a time-stamped image of each incident on its own, without anyone starting an export:

- about one minute after the incident starts, so there is something to look at even if it never clears;
- every 30 minutes while it stays open (at most 12 times);
- when it ends, and once more about ten minutes later, when the post-clear recording is complete.

Each save writes `incident-figures/<incident>/<UTC time>-<start|progress|end|final>.svg`, `.png` and `-analysis.svg` inside the evidence folder of the active data domain (Field or Test; simulation incidents never produce images). In **Evidence History**, **Image** and **Analysis** links open the newest saved overview and analysis charts of an incident.

Cleanup is automatic. Images older than **Delete images after** (1 to 365 days, default 30) are deleted by the regular storage maintenance, even when saving has been switched off. Independently of that setting, no more than 400 images are kept: the oldest go first. Only files this feature wrote are ever deleted. Images are skipped while the host is under memory or resource pressure, and a failure to draw one never affects monitoring or evidence health. Deleting an image does not touch the recorded evidence, and an incident package exported later still contains its own figure.

### Reading incident images and reports from a folder

The evidence store (`/var/lib/rf-monitor/...`) is private to the `rfmonitor` service account on purpose: the same account can read the protected Settings secret, so nobody should be added to that group. People who only need the incident images and reports use one of these:

- **The dashboard.** Evidence History opens the newest **Image** and **Analysis** of an incident and downloads full evidence packages. No file permissions are involved.
- **A separate share folder**, for people who work from a file manager. Set it up once:

  ```
  sudo rf-monitor share-evidence --dry-run                  # show the plan, change nothing
  sudo rf-monitor share-evidence                            # prepare the default folder
  sudo rf-monitor share-evidence --folder /ABSOLUTE/PATH    # or choose another place
  sudo rf-monitor share-evidence --source /ABSOLUTE/BUILT/SOURCE   # also run the deploy that applies it
  ```

  - The default folder is `/srv/rf-monitor-evidence`. It must be an ordinary folder outside the evidence store, home folders and system directories (`/home`, `/root`, `/tmp`, `/etc`, `/opt`, ...). The service runs with `ProtectHome` and a strict file system, so it cannot write into a home folder, and this command does not weaken that.
  - The command creates the group `rf-evidence-readers`, adds your user to it (never to `rfmonitor`), creates the folder with mode `2750`, and puts a link named `RF-Monitor-Evidence` in your `~/Documents`. You must log out and back in once for the group to apply.
  - It records `RF_MONITOR_SHARE_DIR` in `/etc/rf-monitor.env`. A release deploy (`sudo rf-monitor deploy-release /ABSOLUTE/BUILT/SOURCE`) then adds the folder to the service's writable paths and restarts RF Monitor briefly.
  - For Field incidents the share receives, next to the copy in the evidence store, `<UTC time>-<start|progress|end|final>.svg`, `.png`, `-analysis.svg` and `-report.html` in one folder per incident. Test and simulation data never reach the share. The folder is also cleaned by the **Delete images after** setting and the 400-file cap. Anything else you put in it is never deleted.
  - A missing or unwritable share never affects monitoring or the evidence store; a warning is logged at most once every ten minutes.
  - Full evidence packages are not copied automatically: they can only be built from a Complete session, and the open session closes on rotation. Download them from Evidence History when needed.
  - `sudo rf-monitor share-evidence --stop` switches the copying off and keeps the files already there.
