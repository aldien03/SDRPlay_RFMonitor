# RF Monitor

RF Monitor is an Ubuntu 24.04 spectrum-monitoring dashboard and tamper-evident evidence logger for SDRconnect. It uses one SDRplay RSPdx as one uncalibrated, single-tuner RF sensor, identifies relative spectrum anomalies, and saves the observed spectrum data with UTC timestamps and SHA-256 manifests.

RF Monitor v1 is spectrum-only. IQ capture is disabled, SDRconnect display bins are relative values rather than calibrated dBm, and the application does not classify GNSS spoofing or deliberate jamming. It can support an operator decision by reporting a repeated RF anomaly as suspected interference, but stronger conclusions require calibrated equipment or independent navigation-receiver evidence.

Start with [Start Here](docs/START-HERE.md). The supported installation command is:

```bash
bash deploy/install-ubuntu.sh
```

Run that command as the normal Ubuntu user, not with `sudo`. The installer asks for `sudo` only when it needs to change the computer.

**Windows 11 (evaluation only, never production-qualified):** see [Install RF Monitor on Windows 11](docs/windows-11.md).

**Required download:** [SDRconnect for Windows, Linux and macOS](https://sdrplay.com/sdrconnect/#) from SDRplay. RF Monitor reads its spectrum from SDRconnect, so install it before you start.

## Operator Design

The default dashboard shows only what an operator needs:

- Normal, Checking, Alert, Recovering, or Offline status;
- affected service and frequency;
- what was observed and the recommended action;
- whether evidence is being recorded;
- a queued, direct evidence-package download when an incident exists.

Spectrum, waterfall, raw metrics, and display controls are behind **Engineer**. Persisted sessions/incidents and downloads are in **Evidence History** without requiring Engineer mode. Deployment configuration is behind **Settings** and a separate Settings password.

## Configurable Monitoring

The protected **Settings** page controls:

- site name, deployment ID, and display time zone;
- StarTrack enabled/disabled, complete `410-470 MHz` coverage, or selected frequencies on the catalog's `25 kHz` grid;
- 4DX enabled/disabled, all 91 channels, or a contiguous deployment range of at least 51 channels;
- Navigation/GNSS enabled/disabled and independent GPS, GLONASS, Galileo, BeiDou, and SBAS selection;
- individual logical GNSS signals mapped to explicit physical capture targets;
- physical-target timing overrides, detector recommendations, Exclusive Engineer Focus timeout, and evidence retention.

The browser does not contain fixed service names, frequency ranges, or site labels. It renders the installed versioned catalog and active operational profile returned by the backend.

The fast-GNSS profile gives Tier-1 GNSS targets deadline-based priority. Its 2-second L1 and 6-second L2/L5/G1 revisit values are measured objectives, never promises of continuous coverage. StarTrack, 4DX, and optional GNSS targets stay paused unless measured scheduler slack safely admits them.

**Exclusive Engineer Focus** temporarily inspects one valid target, shows and records every suspended coverage objective, and automatically returns to the saved deployment profile. Selecting a feed on the normal dashboard never changes tuner behavior.

## Security Model

RF Monitor 1.0 has no LAN access token. Browsers admitted by the Nginx operator-network allowlist can view status and use evidence actions. Only configuration writes require the Settings password.

Production deployment uses:

- Node bound to `127.0.0.1` only;
- HTTPS through Nginx;
- a narrow operator-network firewall allowlist;
- SDRconnect bound locally and blocked from the LAN;
- salted Node `scrypt` password hashing;
- short-lived signed `HttpOnly`, `SameSite=Strict`, HTTPS-only Settings sessions;
- Origin, CSRF, rate-limit, and optimistic-revision checks;
- a hash-chained configuration audit log.

Do not expose RF Monitor 1.0 directly to the public internet.

## Evidence Scope

Evidence timestamps are always UTC ISO-8601. The selected time zone changes display formatting only. Session folders and ZIP entries use portable POSIX `/` separators on every operating system.

The archive stores active configuration, catalog version, SDRconnect metadata, visit/tune state, event JSONL, spectrum summaries, raw bin frames, screenshots, operator notes, configuration audit entries, and SHA-256 manifests. IQ is explicitly disabled. Automatic retention removes the oldest eligible closed sessions first based on age, archive limit, and minimum free-space reserve. It never intentionally deletes an active session or evidence merely because software is rolled back.

RF spectrum measurements describe what this uncalibrated receiver observed. They do not establish absolute field strength, transmitter identity, deliberate intent, or GNSS spoofing. Correlate alerts with independent receiver/navigation data and operational reports before making safety or security decisions.

**RF data can show interference, not intent.**

## Production Qualification

New installations remain in **Checking** while baselines and scheduler behavior are measured. A baseline needs at least 30 minutes of valid coverage before it can be provisional, 24 representative hours before it is reviewable, and an explicit protected Settings approval before it can support Medium evidence. The local timing and learning gate is capped at 24 hours.

The production target is 10 MS/s with a nominal 10 MHz display. Detection initially uses only the configurable central 8 MHz or less; outer bins are guard/roll-off regions, and the sensor does not capture every wide GNSS waveform completely. A passive 9-versus-10 MS/s comparison cannot prove sensitivity or flat usable bandwidth, so 9 MS/s remains experimental.

See [Fast-GNSS Commissioning And Resource Acceptance](docs/fast-gnss-commissioning.md) for the physical target schedule, eight-dashboard/network limits, managed-switch checks, baseline approval, stop conditions, and rollback procedure.

## Local Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm run check
npm run build
RF_MONITOR_SIMULATION=on npm start
```

Open `http://127.0.0.1:8080/`. Development mode creates local runtime files under the project directory. Production requires explicit catalog, operational profile, credential, storage, and receiver settings.

Useful commands:

```bash
npm run check
npm run build
npm run verify:sdrconnect
npm run verify:sdrconnect -- --spectrum
```

The first SDRconnect check verifies the documented JSON WebSocket API. The spectrum check starts the selected device briefly and requires an actual binary spectrum frame. An `IQ File` source verifies API connectivity but is not proof that a physical RSP is receiving live RF.

## Production Administration

After installation:

```bash
sudo rf-monitor access
sudo rf-monitor doctor
sudo rf-monitor status
sudo rf-monitor logs 200
sudo rf-monitor configure
sudo rf-monitor configure-web
sudo rf-monitor reset-admin-password
sudo rf-monitor support-bundle
```

## Documentation

- [Start Here](docs/START-HERE.md): first installation with checkpoints.
- [Installation And Configuration](docs/installation-and-configuration.md): complete beginner runbook.
- [Configuration Reference](docs/configuration-reference.md): dashboard and system settings.
- [Operations](docs/operations.md): daily operator and maintainer procedures.
- [Troubleshooting](docs/troubleshooting.md): symptom-based diagnosis and recovery.
- [Security, Backup, And Recovery](docs/security-backup-recovery.md): trust boundaries, backup, restore, and audit.
- [Ubuntu 24.04 Checklist](docs/ubuntu-24.04.md): compact deployment checklist.
- [WSL Test Lab](docs/wsl-ubuntu-24.04-test-lab.md): software testing without confusing it with production RF evidence.
- [Mediterranean Internal Monitoring Specification](docs/mediterranean-internal-monitoring-spec.md): constrained purpose, hardware envelope, missions, claims, and acceptance for the current internal deployment.
- [Mediterranean Internal Monitoring Plan](docs/mediterranean-internal-monitoring-plan.md): minimal ordered implementation and site-acceptance work for that deployment.
- [Production Development Roadmap](docs/production-development-roadmap.md): ordered engineering work, dependencies, verification levels, operator acceptance, and the final production gate.
- [Hardware Commissioning](docs/hardware-validation.md): required physical receiver acceptance tests.
- [Fast-GNSS Commissioning And Resource Acceptance](docs/fast-gnss-commissioning.md): physical targets, the 24-hour development gate, optional site assurance, switch checks, and rollback.
