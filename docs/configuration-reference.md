# Configuration Reference

RF Monitor separates configuration into two ownership domains so ordinary operators do not need Linux access.

| Domain | Changed with | Stored under | Owner |
|---|---|---|---|
| Monitoring, site, display time, detection, retention, baseline approval, Exclusive Engineer Focus | Protected dashboard **Settings** | `/var/lib/rf-monitor/config` | RF Monitor service |
| Receiver URLs, device, sample rate, ports, TLS trust, storage path | `sudo rf-monitor configure` and `configure-web` | `/etc` | root |
| Factory service and frequency definitions | Controlled catalog installation | `/etc/rf-monitor/catalog.json` | root |

Do not manually edit the active operational JSON while RF Monitor runs. Use the dashboard so validation, optimistic revision checks, audit records, evidence rollover, and atomic persistence all occur.

## Monitoring Profile

Open **Settings**, enter the Settings password, and use **Monitoring profile**.

### Parent Services

Available service IDs and labels come from the installed catalog. The supplied schema-v3 catalog contains:

- StarTrack radio;
- 4DX radio;
- Navigation/GNSS.

Each parent can be enabled or disabled. Disabling a parent preserves its child selections. At least one usable service and child target must remain enabled. To stop all monitoring temporarily, use **Pause** on the dashboard.

### StarTrack

Modes:

- **Complete range:** compile the catalog's full StarTrack range into scan windows.
- **Deployed frequencies:** add one or more channel centers.

Validation is derived from the catalog:

- each value must be inside the catalog start/end range;
- each value must align to the catalog channel grid;
- duplicates are removed;
- at least one frequency is required in deployed-frequency mode.

The supplied catalog defines `410-470 MHz` on a `25 kHz` grid based on the supplied StarTrack specification. These values are not duplicated in React source.

### 4DX

Modes:

- **All channels:** use every channel in the installed catalog.
- **Deployed range:** select a contiguous start and end channel.

The supplied catalog defines 91 channels from `902.400 MHz` through `927.600 MHz` at `280 kHz` spacing. Saved deployed ranges must contain at least 51 channels. Use **Exclusive Engineer Focus** for a temporary single-channel investigation.

Channel center calculation is catalog-driven:

```text
center = catalog start + (channel number - 1) * channel spacing
```

### Navigation/GNSS

GPS, GLONASS, Galileo, BeiDou, and SBAS can be enabled independently. A selected GNSS system must contain at least one enabled logical signal.

**Engineer settings** exposes each logical signal and its physical capture-target mapping. Signals are grouped by catalog metadata, not by fixed client-side frequencies. Logical signals may share a capture target only when the catalog gives them exactly the same physical tune center. Incidents, graphs, and baselines use the physical target ID while retaining every affected logical-signal label.

RF Monitor observes relative RF energy around selected GNSS signals. It does not decode navigation messages and v1 has no spoofing classification. A matched-power spoofing signal may be indistinguishable from legitimate RF spectrum without independent navigation data.

### Fast Tier-1 Profile

New installations default to the separate fast-GNSS choice, with only these physical targets enabled:

| Target | Tune center | Revisit objective |
|---|---:|---:|
| GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1 | 1575.420 MHz | 2 s |
| GPS L2C | 1227.600 MHz | 6 s |
| GPS L5 / Galileo E5a / BeiDou B2a | 1176.450 MHz | 6 s |
| GLONASS G1 | 1601.719 MHz (nominal display 1602.000 MHz) | 6 s |

Tier 2, G3, E6, B3I, StarTrack, and 4DX remain selectable but disabled or **Paused — protecting GNSS**. The nominal Tier-1 schedule consumes all tuner time; optional work is admitted only after measured qualification demonstrates at least 10% protected slack and zero optional-work Tier-1 misses.

An upgrade structurally migrates the catalog/profile and backs up the prior revision, but it does not silently apply fast-GNSS, erase optional selections, or enable SBAS in an existing legacy profile.

## Coverage And Revisit

Before applying a draft, Settings displays a feasibility report. For physical GNSS targets RF Monitor:

1. resolves each logical signal to its explicit `captureTargetId`;
2. rejects combinations that attempt to merge different tune centers;
3. uses earliest-deadline/least-laxity scheduling for Tier 1;
4. completes the confirmed-tune, settle, discard, fresh-frame observation sequence;
5. admits optional weighted-deficit work only when live look-ahead preserves Tier-1 deadlines and a 10% reserve.

Every visit follows `select → command → confirm → settle 250 ms → discard 2 raw frames → collect at least 3 fresh frames → complete/fail`. Immutable configuration, tune, and visit epochs keep the frame gate closed until confirmation; a timeout or mismatched epoch can never assign old-frequency data to the requested target. A nominal visit is 1,000 ms and may extend toward 1,500 ms only when online look-ahead proves another Tier-1 latest-safe-start is preserved.

One RSPdx is one uncalibrated, single-tuner sensor. Every target shares its schedule. Revisit is measured from valid-observation completion to completion; observed exposure and the actual unobserved gap are reported separately. The 2/6-second Tier-1 values are objectives, not guarantees. A Normal status means no anomaly was detected in completed valid observations; it does not imply continuous observation.

The nominal capture display is 10 MHz at the read-only 10 MS/s reported by SDRconnect. Detection initially uses only the configurable central 8 MHz or less. Outer bins are guard/roll-off regions and must not train the baseline. The sentinel does not capture every wide GNSS waveform completely. Nine MS/s remains experimental until conducted, calibrated RF testing establishes its behavior.

## Site And Time

### Site Name

- required;
- 1 to 80 printable characters;
- displayed in the header;
- copied into each new evidence session.

Examples should describe the real installation, such as a vessel name, platform ID, or shore site. There is no compiled location string.

### Deployment ID

- optional but recommended;
- maximum 80 characters;
- use a stable asset/deployment identifier rather than a person's name.

### Report Identity

**Settings › Site › Report identity** sets the company name, an optional PNG or JPEG logo (up to 512 KB and 2000 × 2000 pixels, stored by SHA-256 next to the operational profile), the client, the vessel or platform and the project or job reference. They are printed on the cover and header of every incident report. They apply live.

### Display Time Zone

Choose an IANA time zone such as `UTC` or a relevant regional zone. This changes browser display only.

All evidence timestamps, audit timestamps, filenames, and manifests remain UTC ISO-8601. Changing display time does not rewrite historical evidence.

## Evidence Retention

### Keep Evidence For

Maximum age of closed sessions. Range: 1 to 3650 days.

### Maximum Archive Size

Combined archive limit for managed session folders. The value must be at least as large as the maximum single-session size.

### Keep Disk Space Free

Minimum filesystem free-space reserve. If free space approaches this threshold, RF Monitor removes the oldest eligible closed sessions first and reports storage pressure.

### Close Each Session After

Maximum active-session age. Range: 1 to 168 hours. Rotation finalizes hashes and starts a new session without stopping monitoring.

### Maximum Session Size

Maximum data size for one active session before rotation. New evidence rotates at 2 GiB or 24 hours, and hourly raw chunks also rotate at 128 MiB. A long incident continues across session parts rather than preventing rotation. This protects archive manageability but does not replace the total archive limit.

### Maintenance Behavior

Maintenance runs periodically and can also be requested through the API. It:

- finalizes sessions at age/size limits;
- removes oldest closed sessions to meet age, total-size, and free-space limits;
- never intentionally removes the current active session;
- reports a failure when the configured storage filesystem is unavailable.

System service logs are separately bounded by journald values configured with `sudo rf-monitor configure`.

## Runtime Work Budgets

Continuous operation uses bounded work queues and binary bins:

| Variable | Default | Purpose |
|---|---:|---|
| `RF_MONITOR_SPECTRUM_RATE_HZ` | `4` | Maximum FFT frames per second passed from each SDRconnect socket into detection and UI processing. Newer frames replace obsolete frames before expensive conversion. |
| `RF_MONITOR_MAX_SPECTRUM_BINS` | `2048` | Maximum bins retained in routine storage/browser frames. Native `Uint8Array` input is analyzed first; one peak-preserving reduction is then stored. |
| `RF_MONITOR_EVIDENCE_FRAME_INTERVAL_MS` | `2000` | Routine clear-state evidence cadence. Detecting, active, and recovering targets automatically record up to the processing rate. |
| `RF_MONITOR_MAX_PENDING_EVIDENCE_FRAMES` | `8` | Hard cap on frame writes waiting for storage. Obsolete routine frames are dropped instead of consuming unbounded memory. |

Server waterfalls retain at most 32 rows per physical target. A browser receives rows only for subscribed targets; removed pins are pruned immediately. A global packed 60-second, 4 Hz spectrum ring is retained per receiver, frozen on the first candidate, followed through alert/recovery, and continued for ten minutes after clear. Clear-state evidence remains decimated to one observation every two seconds.

Evidence raw bins are appended to hourly binary chunks, each capped at 128 MiB. Each frame record identifies the raw file/offset/length, requested and confirmed RF state, visit timestamps/epochs, input/stored bin counts, gaps/drops, baseline/rule versions, and reduction method.

Live resource budgets are:

| Resource | Bound |
|---|---:|
| Concurrent dashboards | 8 |
| Aggregate live payload | 1 MiB/s; 2 MiB burst |
| Hidden / normal / Engineer client | 16 / 64 / 128 KiB/s |
| Per-client queue | Drop frames at 64 KiB; close at 256 KiB or after 10 seconds |
| Control state | Bins-free, latest-only, no more than 128 KiB and 1 Hz |
| Evidence / priority writer queue | 8 jobs or 256 KiB / 64 items or 2 MiB |
| Export | One active, two queued; one global 5 MiB/s download |

RF Monitor starts Node with a 384 MiB old-space heap; systemd uses 512 MiB `MemoryHigh` and 768 MiB `MemoryMax`. SDRconnect uses 768 MiB high and 1 GiB maximum. At application pressure, new live clients/exports are rejected and dashboards fall to at most 2 Hz. At critical pressure, live spectrum becomes status-only so scheduler, detector, and evidence work retain priority.

These are infrastructure safeguards, not detection thresholds. Increasing them raises CPU, memory, disk, manifest, and browser-network load. Recommission storage growth and priority revisit timing after any change. Keep `SDRCONNECT_SAMPLE_RATE_HZ` at the required 10 MS/s value. On a confirmed mismatch the application makes one bounded SDRconnect API request, then keeps the frame gate closed until an exact read-back confirms the rate. A different confirmed rate changes the baseline fingerprint and blocks production until recommissioned.

## Engineer Settings

Only trained personnel should change these values after baseline collection.

### Scan Dwell

Milliseconds spent on a scheduled service window. Valid range: 250 to 300000 ms. Longer dwell improves temporal observation within a window but increases revisit time elsewhere.

### Priority

Relative scheduling weight from 0 to 10. It does not create a second receiver. Review the displayed revisit estimate after every change.

### Alert Sensitivity

**Settings › Monitoring › Alert sensitivity** decides when relative RF energy raises an alert. It is separate from the signal-learning rules below: it is not part of any baseline fingerprint, so changing it **never restarts signal learning, never ends an open incident and never retunes the receiver**. The change applies within a second, starts a new recording session that continues any open incident, adds a "Sensitivity changed" entry to each open incident's timeline, and is written to the configuration audit.

| Preset | Raised level | Band-wide share | Narrow peak | Must repeat | Noise-floor rise | Short bursts |
|---|---|---|---|---|---|---|
| Conservative | 8× | 50% | 12× | 4 of 5 checks, 1.5 s observed | 5× for 20 s, approved baselines only | Off |
| **Standard** (default) | 6× | 35% | 10× | 3 of 5 checks, 1 s observed | 4× for 10 s | Off |
| Sensitive | 5× | 30% | 8× (2 bins or wider) | 2 of 4 checks, 0.8 s observed | 3.5× for 8 s | Single frames at 8× |
| Very sensitive | 4× | 25% | 6× (2 bins or wider) | 2 of 3 checks | 3× for 6 s | Single frames at 7× |

"×" means multiples of each frequency's **normal variation** (`1.4826 × MAD`, at least one relative bin). A check is one completed visit to a frequency window (the per-bin median of three frames). The alert rules are:

- **Band-wide rise**: at least the band-wide share of the analysed window is at or above the raised level.
- **Wider signal (partial band)**: one raised block wider than the narrow limit (10% of the window, 0.8 MHz of 8 MHz) whose middle strength reaches the raised level. This closes the gap where a 0.8–4 MHz emission matched neither the narrow nor the band-wide rule.
- **Narrow signal**: a raised block no wider than the narrow limit whose peak reaches the narrow-peak level. Each block is judged on its own, so a wider block elsewhere does not hide it.
- **Noise-floor rise**: the middle level of the whole window sits at or above the noise-floor level for the stated observed time. It is checked against provisional and reviewable local references as well as approved baselines (Low evidence unless approved).
- **Short bursts** (Sensitive and Very sensitive): a raised block seen in a single frame that the three-frame median would hide. Bursts are never learned.
- **Must repeat**: raised checks of any shape count together; the alert names the most severe shape seen. Checks further apart than three times the window's revisit objective (at least 30 s) start a new count, so slowly revisited windows can still alert.

Choose **Custom** values in **Advanced › Alert rules**, and a different preset for one frequency window under **Per window**. When a baseline is learning, the page shows how many alerts each preset would have raised during live checks so far, as an estimate.

### Signal-Learning Rules

Raw SDRconnect spectrum bins are normalized relative display values. SDRconnect's vendor-reported power field is labelled as sourced/relative and is not treated as calibrated dBm.

| Field | Meaning |
|---|---|
| Robust scale | Initial per-bin scale is `max(1.4826 × MAD, 1 normalized bin)` |
| Wideband observation | Median deviation at least 6 scales and abnormal occupancy at least 35% |
| Interference suspected | Deviation at least 8 scales, occupancy at least 50%, 3 of 5 valid visits, and at least 2 seconds observed exposure |
| Narrowband anomaly | Peak at least 10 scales, contiguous occupied width no more than 10% of analyzed span, and 3 of 5 valid visits |
| Slow drift | Median deviation at least 4 scales against the protected baseline and at least 10 seconds observed exposure |
| Clear | Ten valid clean observations; missing/incomplete/stale/mistuned visits are unknown |

**Advanced › Signal-learning rules** decide which checks are learned as normal. They are hashed into every baseline fingerprint, so saving a change restarts signal learning for every window and ends open incidents; the server refuses the change unless the operator confirms it. Use Alert sensitivity to change when alerts are raised. These are versioned commissioning recommendations, not certified limits. A valid detector observation is the per-bin median of at least three accepted frames from one completed, epoch-confirmed visit. At the current 512-bin output, describe an observed temporal feature as **moving narrowband energy**, not a chirp or trustworthy 25 kHz StarTrack classification.

Baseline states are Learning, Provisional, Reviewable, Protected, and Stale. Learning requires at least 30 minutes and valid-visit coverage. Reviewable requires 24 representative UTC hours of stable RF configuration/health; elapsed wall time or isolated samples do not count. The default representative-hour gate requires a 30-minute visit spread, 10 seconds of accumulated observed exposure, and at least 80% valid scheduled opportunities without a tune, health, overload, candidate, or data-gap invalidation. Protected requires explicit approval through the protected Settings session after the bounded 24-hour timing and signal-learning gate. A fingerprint change—including receiver serial or any detector-rule value—selects an exact prior baseline or returns the target to Checking; it never silently transforms or deletes a baseline.

Evidence strength is Low or Medium. High is reserved for future calibrated or independent navigation evidence and is never generated in RF-only v1.

### Exclusive Engineer Focus Maximum

Maximum duration allowed for a temporary focus session, from 1 to 60 minutes. The operator can choose a shorter duration when starting focus.

## Exclusive Engineer Focus

Exclusive Engineer Focus is available on the Monitoring profile page and does not modify the saved deployment selection. Selecting or expanding a feed on the normal dashboard never retunes the receiver.

Required inputs:

- a catalog band/signal;
- a valid center frequency when the catalog permits channel tuning;
- a duration no longer than the configured maximum.

Runtime behavior:

- requires a two-step warning that names every suspended objective;
- stops normal scheduling temporarily;
- records focus start, target, duration, client address, and expected coverage gap;
- displays a countdown on the main dashboard;
- remains in the current evidence session;
- automatically resumes the deployment profile at expiry;
- can be ended early with **Resume monitoring**.

Starting another focus replaces the current temporary focus only after validation. It does not require a Settings session, but it is time-bounded and audited.

## Applying Settings

Before saving, the Settings footer states what Apply will do:

| Change | What happens |
|---|---|
| Alert sensitivity, site name, deployment ID, time zone, retention, report identity | **Applies now.** No retune; open incidents stay open; a new recording session continues them. |
| Monitoring task, windows, scan timing | **Retunes the receiver.** Open incidents end and a new recording session starts. |
| Signal-learning rules | **Restarts signal learning** for every window after an explicit confirmation (`428` without it). |

The browser sends the complete draft and expected revision. Possible results:

- `200`: applied, persisted, audited, and running;
- `401`: Settings is locked or the session expired;
- `409`: another client changed the revision first; the browser reloads the latest profile;
- `422`: one or more fields are invalid and the running profile is unchanged;
- `428`: the change restarts signal learning and was not confirmed;
- `5xx`: persistence or runtime apply failed; RF Monitor attempts rollback and records failure.

A successful apply:

1. validates against the installed catalog and infrastructure;
2. stops scheduling at a controlled boundary;
3. finalizes and hashes the current evidence session;
4. atomically writes the next operational revision;
5. appends a hash-chained configuration audit entry;
6. marks affected baselines stale or selects an exact fingerprint match; protected baselines are never deleted;
7. starts a new evidence session containing the new hash and catalog version;
8. resumes monitoring.

## Settings Authentication

Viewing and evidence operations do not require a token in v1. Configuration writes require an active Admin mode session.

Session properties:

- signed server-side session identifier;
- bound to the client address;
- short expiration, configurable through the root wizard;
- `HttpOnly` and `SameSite=Strict` cookie;
- `Secure` cookie on production HTTPS;
- explicit **Exit admin mode** action;
- Origin and CSRF checks on writes;
- rate limiting after repeated Admin mode failures.

Reset the password:

```bash
sudo rf-monitor reset-admin-password
```

No password-recovery answer is stored. A root administrator must reset it.

## Versioned Frequency Catalog

Production startup requires:

```text
/etc/rf-monitor/catalog.json
```

The schema-v3 catalog carries:

- schema and catalog version;
- source/reference metadata;
- service IDs, labels, descriptions, and order;
- band IDs and labels;
- service/GNSS-system ownership, including SBAS;
- explicit physical capture targets, tune and nominal display centers, capture/analysis spans, tier, visit budget, and revisit objective;
- logical-signal `captureTargetId` links plus radio start/end/spacing/channel count where applicable.

The catalog is root-managed because changing it changes evidence meaning. The installer preserves an existing catalog and saves a new release catalog as a timestamped vendor candidate. Review, approve, back up, install, restart, and recommission any catalog change.

Production startup fails closed if the catalog or operational profile is absent or invalid.

## Operational Files And Recovery

Default directory:

```text
/var/lib/rf-monitor/config/
```

It contains the active profile, revision backups, and configuration audit records. Writes use a temporary file, `fsync`, and atomic rename. On startup, RF Monitor validates the current profile and can recover the most recent valid revision if an interrupted or corrupted active write is found.

Every audit entry contains:

- UTC time;
- resulting revision;
- changed field paths;
- success/failure outcome;
- client address;
- old and new configuration hashes;
- previous audit-entry hash and current entry hash.

Audit chaining detects later modification; it is tamper-evident, not an externally notarized chain of custody.

## Root-Managed Infrastructure

Use:

```bash
sudo rf-monitor configure
```

Primary environment settings generated in `/etc/rf-monitor.env`:

| Setting | Purpose |
|---|---|
| `RF_MONITOR_HOST` | Must remain loopback in production |
| `RF_MONITOR_PORT` | Local Node port |
| `RF_MONITOR_STORAGE` | Evidence root |
| `RF_MONITOR_CATALOG_FILE` | Installed catalog |
| `RF_MONITOR_OPERATIONAL_FILE` | Active profile |
| `RF_MONITOR_ADMIN_FILE` | Password hash/signing secret |
| `RF_MONITOR_ADMIN_SESSION_MINUTES` | Settings-session lifetime |
| `RF_MONITOR_SIMULATION` | Must be `off` for production |
| `RF_MONITOR_IQ_CAPTURE_MS` | Must be `0`; nonzero values are rejected in spectrum-only v1 |
| `RF_MONITOR_IQ_MAX_BYTES` | Legacy compatibility only; no v1 IQ allocation/capture is permitted |
| `SDRCONNECT_URL` | The single loopback receiver WebSocket endpoint. Fast-GNSS v1 rejects remote or multiple endpoints; `SDRCONNECT_URLS` is accepted only when it contains that one local URL. |
| `SDRCONNECT_DEVICE_INDEX` | Valid device index |
| `SDRCONNECT_SAMPLE_RATE_HZ` | Required hardware sample rate; production default 10 MS/s. RF Monitor requests it when needed and gates frames until SDRconnect confirms it. |
| `SDRCONNECT_TIMEOUT_MS` | Connection/operation timeout |
| `SDRCONNECT_TLS_REJECT_UNAUTHORIZED` | Must remain true for WSS |
| `NODE_EXTRA_CA_CERTS` | Optional approved private CA bundle |
| `RF_MONITOR_ALLOWED_ORIGINS` | Additional exact approved browser origins |

Do not add site names, selected bands, thresholds, or retention values to this file. Old deployments that contain them are migrated into the initial operational profile and backed up. Keep SDRconnect on `127.0.0.1:5454`; the operator LAN must never reach it directly.

## API Summary

Read endpoints:

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/bands`
- `GET /api/settings`
- `GET /api/admin/session`
- `WS /live`

`GET /api/settings` includes structured schedule feasibility facts and baseline states. `GET /api/health` returns `schemaVersion: 2`, immutable `identity`, separate `currentHealth` and persistent `productionQualification`, the fail-closed `productionReady` boolean, bounded diagnostic issues, and atomic task sections for receiver path, continuity, software, network, evidence/disk, and schedule/commissioning. `summary.state` describes current operation only; it never means the installation is production-qualified. Existing top-level fields remain for one release as compatibility aliases; automation must migrate from `.ok`, `.monitoringReady`, or `.summary.state` readiness checks to `.productionReady == true`. The health response excludes network addresses, MAC addresses, command lines, credentials, logs, and evidence contents. Even a healthy completed 24-hour local gate remains `Not qualified` without the exact separately managed V0–V7 approval described in [Production qualification approval](production-qualification-approval.md); the application never creates that record. The live bootstrap carries the same identity so the browser can require reload when its packaged build differs. Manifest-v2 evidence records the runtime/build/configuration identity; legacy manifests remain readable. The live protocol is versioned; one release accepts the legacy subscription shape, but all subscription signatures are canonicalized and an empty target list is status-only.

Settings endpoints:

- `POST /api/admin/unlock`
- `POST /api/admin/lock`
- `PUT /api/settings`

Monitoring/evidence endpoints:

- `POST /api/monitor/pause`
- `POST /api/monitor/focus`
- `DELETE /api/monitor/focus`
- `POST /api/storage/maintenance`
- `POST /api/events/:id/notes`
- `POST /api/events/:id/acknowledge`
- `POST /api/events/:id/screenshots`
- `POST /api/baselines/:targetId/approve` (protected; expected configuration revision required)
- `POST /api/baselines/:targetId/restart` (protected; expected configuration revision required)

Queued incident-export endpoints:

- `POST /api/exports`
- `GET /api/exports/:jobId`
- `GET /api/exports/:jobId/download`

Before production acceptance, verify these endpoints on the deployed package; do not run the eight-dashboard/export soak if only the legacy synchronous `GET /api/events/:id/export` is present. The queued workflow contains only the incident slice, not the entire session; permits one active/two queued jobs; streams SHA-256 into atomic `.partial` files; and splits without truncation into numbered parts no larger than 256 MiB under one global 5 MiB/s download budget.

The browser should use the same HTTPS origin as the dashboard. Direct Node and SDRconnect access is intentionally unavailable from the operator LAN.
