# Fast-GNSS Commissioning And Resource Acceptance

This is the acceptance runbook for the fast-GNSS profile. It is deliberately conservative. A successful software install does not establish receiver sensitivity, calibrated power, continuous GNSS coverage, or detector accuracy.

## Rollout Status Gate

Treat every item below as required behavior to verify on the exact installed package and active systemd/Nginx configuration. Source files, simulated tests, or a visible control are not proof that the behavior is active.

Do not commission fast-GNSS when any of these remains true:

- `/api/health` lacks scheduler, baseline, rolling resource, writer, disk, or export diagnostics;
- `GET /api/settings` lacks the feasibility report and per-target baseline states;
- the protected approve/restart baseline routes reject the expected-revision workflow;
- only the legacy synchronous incident export exists instead of the queued create/status/direct-download workflow;
- the real RSPdx bounded 24-hour timing and signal-learning gate has not passed;
- managed-switch counters were not captured or show egress drops/discards/pause events.

Until all gates pass, the installation is a research/commissioning build: keep targets Checking, allow Low evidence only, and retain the prior operational revision/package for rollback.

## What The Sensor Can And Cannot Establish

The supported v1 deployment has one original RSPdx, one tuner, one local SDRconnect process, and a fixed antenna/gain/display configuration. It observes one physical RF window at a time. Every other target is unobserved while the tuner is elsewhere.

RF Monitor v1:

- records spectrum only and rejects IQ capture;
- analyzes normalized 8-bit SDRconnect FFT display bins as relative values;
- does not treat the vendor-reported signal-power field as calibrated dBm;
- reports relative anomalies and suspected interference;
- does not classify spoofing or claim that interference is deliberate;
- requires independent GNSS/navigation data for conclusions about position, timing, or spoofing.

An alert means that a configured RF rule was repeatedly met during valid observations. A normal result means no rule was met in the observations actually completed. Missing, stale, mistuned, or incomplete visits are unknown, never clean.

## Physical GNSS Targets

Logical signals sharing one tune center use one physical capture target and one baseline. Different tune centers must never be merged.

| Tier | Physical capture target | Tune center | Revisit objective |
|---|---|---:|---:|
| 1 | GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1 | 1575.420 MHz | 2 s |
| 1 | GPS L2C | 1227.600 MHz | 6 s |
| 1 | GPS L5 / Galileo E5a / BeiDou B2a | 1176.450 MHz | 6 s |
| 1 | GLONASS G1 | 1601.719 MHz; display 1602.000 MHz | 6 s |
| 2 | BeiDou B1I | 1561.098 MHz | 30 s when admitted |
| 2 | Galileo E5b / BeiDou B2b | 1207.140 MHz | 30 s when admitted |
| 2 | GLONASS G2 | 1245.781 MHz | 30 s when admitted |

The nominal one-second visits consume all tuner time in the default Tier-1 schedule. Therefore, Tier 2, GLONASS G3, Galileo E6, BeiDou B3I, StarTrack, and 4DX are disabled or shown as **Paused — protecting GNSS** in the fast profile. They may run only after real qualification demonstrates at least 10% protected slack and zero Tier-1 misses caused by optional work.

The 2-second and 6-second values are objectives measured from one valid-observation completion to the next. They are not guarantees. Record observed exposure and the actual unobserved gap separately. Report **Meeting objective** only when at least 99.9% of completed revisits meet the applicable objective during qualification, with every miss and cause retained.

## Bandwidth And Sample-Rate Boundaries

Production uses the read-only 10 MS/s value reported by SDRconnect. RF Monitor verifies it; it must not command a different rate during routine monitoring. The RSPdx output is 8-bit at 10 MS/s and 10-bit at 9 MS/s, not 14-bit, and the analog IF is approximately 8 MHz at the 3 dB points.

Display the nominal 10 MHz capture, but analyze only the configured central 8 MHz or less. The outer bins are guard/roll-off regions and must be shaded accordingly. This sentinel does not completely capture every wide GNSS waveform.

Keep 9 MS/s experimental. A passive comparison of noise floors cannot establish sensitivity or flat usable bandwidth. Do not change production to 9 MS/s without conducted, calibrated RF testing and a full recommission.

## Baseline Lifecycle

Each baseline is tied to the exact receiver/device serial, antenna, fixed LNA/gain state, target, center/span, confirmed sample rate, FFT grid, analysis mask, SDRconnect version, display reference/base, catalog version, detector version, and a canonical hash of every detector-rule value. A fingerprint change makes the prior baseline stale; it must not be silently transformed or deleted. Field SDR observations remain unknown until SDRconnect reports a non-empty device serial.

With SDRconnect WebSocket API 1.0.3, the observable fixed RF-gain field is `lna_state`; IF gain is not exposed by that interface. Keep the SDRconnect gain configuration fixed during commissioning and record any unverified GUI-only gain control in the site log.

Use these gates:

1. **Learning:** keep the target in Checking for at least 30 minutes and require sufficient valid visits.
2. **Provisional:** Low-evidence observations are allowed, but the baseline is not approved.
3. **Reviewable:** require at least 24 representative UTC hours with stable RF configuration and healthy receiver/frame flow. By default, each counted hour needs at least 30 minutes between its first and last valid visits, at least 10 seconds of accumulated accepted-frame exposure, and at least 80% valid scheduled opportunities. One tune, health, overload, candidate, or data-gap invalidation makes that hour non-representative.
4. **Protected:** an authorized person explicitly approves the reviewable baseline in protected Settings after the bounded 24-hour gate passes.
5. **Stale:** any fingerprint mismatch returns the target to Checking.

Before approval, record the antenna, filters, cable, receiver serial, gain/LNA state, SDRconnect version, catalog/profile revisions, sample rate, analysis span, and quiet-site conditions. Do not approve while an anomaly, overload, tune fault, data gap, configuration change, receiver recovery, or Exclusive Engineer Focus is active.

The protected baseline remains immutable. Short-term adaptation may use only clean, time-decimated observations and must freeze during candidates, incidents/recovery, overload, tune faults, data gaps, configuration changes, or exclusive focus.

Learning memory is bounded to one packed 256-observation reservoir per active physical target. Sampling is uniform across time with hourly coverage counters; median/MAD calculation reuses scratch storage, and persistence contains only compact arrays plus metadata.

## Resource Limits

These are hard acceptance boundaries, not sizing suggestions.

| Resource | Bound |
|---|---:|
| Live dashboards | 8 |
| Live payload | 1 MiB/s aggregate; 2 MiB burst |
| Hidden / normal / Engineer client | 16 / 64 / 128 KiB/s |
| Per-client queued data | 256 KiB |
| Slow-client action | Drop frames at 64 KiB; close at 256 KiB or after 10 s |
| Control state | Bins-free, no more than 128 KiB, latest-only, no more than 1 Hz |
| Evidence frame queue | 8 jobs or 256 KiB |
| Total priority writer queue | 64 items or 2 MiB |
| Export download | One active at 5 MiB/s; two queued |
| RF Monitor Node.js old-space heap | 384 MiB |
| RF Monitor systemd memory | 512 MiB high; 768 MiB maximum |
| SDRconnect systemd memory | 768 MiB high; 1 GiB maximum |

At application pressure (RSS at least 448 MiB, heap at least 80%, external buffers at least 128 MiB, or sustained queue/event-loop pressure), new clients/exports must be rejected and dashboards capped at 2 Hz. At critical pressure (RSS at least 576 MiB, evidence queue age at least 2 seconds, or disk below reserve), dashboards must become status-only while scheduling, detection, and evidence work continue.

If a health response lacks rolling 10/60-second bandwidth, client queues/drops, RSS/heap/external memory, event-loop percentiles, writer latency, disk rate/free space, export state, and baseline/ring allocation, that release has not met this acceptance plan.

## Preflight

Run on the production Ubuntu host:

```bash
sudo rf-monitor doctor
sudo rf-monitor verify-sdr
sudo rf-monitor verify-spectrum
timedatectl status
sudo ss -lntp
df -h /var/lib/rf-monitor/evidence
systemctl show rf-monitor.service \
  -p ExecStart -p MemoryHigh -p MemoryMax -p TasksMax -p LimitNOFILE
systemctl show sdrconnect-headless.service \
  -p MemoryHigh -p MemoryMax -p TasksMax -p LimitNOFILE
```

Expected results:

- doctor has no blocking failure;
- the physical RSPdx, not only an IQ File source, produces a binary spectrum frame;
- the clock reports synchronized;
- only Nginx is LAN-facing; ports 5454 and 8080 are loopback-only;
- evidence storage is mounted with more than the configured reserve;
- RF Monitor runs `/usr/bin/node` with `--max-old-space-size=384`;
- active systemd limits match the table above.

Stop if any result differs. Save `sudo rf-monitor support-bundle`, correct the deployment, and repeat preflight. Do not weaken memory limits, expose port 5454, or treat a simulated/IQ-file source as acceptance.

## Confirm The Fast Profile Safely

The v2-to-v3 migration must preserve the active selection and back up the prior revision. It must add the fast Tier-1 profile as a separate choice; it must not silently apply it, erase G3/E6/B3I choices, or enable SBAS in an existing legacy profile.

1. Open **Settings** and enter Admin mode.
2. Record the current profile revision and preserve the configuration backup according to site procedure.
3. Select the separate fast Tier-1 profile.
4. Confirm its four Tier-1 physical targets and logical-signal attribution, including SBAS on L1.
5. Confirm optional targets say disabled or **Paused — protecting GNSS**.
6. Review the feasibility report. Stop if it is absent or reports an infeasible Tier-1 schedule.
7. Apply explicitly and record the new revision.
8. Lock Settings and confirm every target begins in **Checking**.

Feed selection on the normal dashboard must not retune the receiver. Exclusive Engineer Focus must present a two-step coverage warning, be time-bounded, log suspended objectives, and show other feeds as Paused. End focus immediately after the required check.

## Bounded 24-Hour V7 Acceptance

Use the final antenna chain, network switch, disk, browser computers, HTTPS path, and eight simultaneous Engineer dashboards. Run one incident-rate export while injecting a legal, shielded anomaly fixture or using another approved passive method. Do not transmit in GNSS bands without authorization.

Use the fail-closed V7 collector and evidence procedure in [V7 Development Qualification](v7-v8-site-qualification.md):

```bash
npm run validate:v7 -- --help
```

The V7 runner collects the timing, baseline, resource, network, and evidence
series for no more than 24 elapsed hours. Required fault, recovery, switch, and
backup/restore checks are bounded prerequisites. A manual `curl` loop may help
troubleshooting, but it is not qualification evidence: it does not enforce exact
identity, counter continuity, clock integrity, evidence custody, or external
witness signatures. Do not pause or resume the gate across a collector restart.

Acceptance requires:

- live traffic no more than 1 MiB/s aggregate and total application egress no more than 6 MiB/s during one 5 MiB/s export;
- no switch egress drops, discards, or pause events;
- no alert-evidence loss, clear-frame loss below 0.1%, and no growing queue;
- RF Monitor RSS p99 below 384 MiB and maximum below 448 MiB after warm-up;
- heap p99 below 256 MiB;
- event-loop p99 below 50 ms normally and below 100 ms during export;
- whole-run RSS slope no more than 1 MiB/hour;
- at least 99.9% of completed Tier-1 revisits within 2/6 seconds;
- zero Tier-1 misses caused by optional work;
- 60 seconds of packed pre-candidate spectrum and ten minutes of post-clear evidence;
- long incidents continue across hourly/2 GiB/24-hour rotations without truncation;
- incident downloads are sliced, hashed, multipart when required, and no part exceeds 256 MiB.

The intended production-like soak assumes roughly 15 GiB host RAM, 1.8 TB evidence disk, and 1 GbE. A smaller system needs a separately approved qualification plan; it does not inherit these results.

## Managed-Switch Checks

Record the exact switch ports for the RF Monitor host and every dashboard path before the soak. Save counters immediately before and after. Vendor commands differ; use the switch's read-only interface or approved network-management system to capture at least:

- transmitted/received bytes and packets;
- output queue drops/discards;
- input errors/discards;
- pause/PFC frames;
- link speed/duplex and port resets;
- the counter-clear or last-reset time.

Do not clear counters unless network operations authorizes it. If counters contain old traffic, record a timed before/after delta. Expected acceptance result is zero increase in egress drops, discards, and pause events on relevant ports. Any nonzero increase is a failed network soak until its cause is understood and the test is repeated.

As a host-side cross-check:

```bash
ip -s link
sudo ethtool -S "$(ip route show default | awk '/default/ {print $5; exit}')" 2>/dev/null | less
```

`ip -s link` should show no growing dropped/error counters on the active interface. If `ethtool` is unavailable or a virtual driver lacks counters, use the managed switch as the authoritative source.

## Stop Conditions And Recovery

Stop qualification and preserve evidence/support data when any of these occurs:

- an old-frequency frame is attributed to a newly requested target;
- a missing/incomplete visit trains a baseline or clears an incident;
- the eighth dashboard cannot remain bounded, or a ninth is admitted as live;
- live traffic exceeds its bound persistently;
- queues, RSS, or external buffers grow without returning toward baseline;
- alert evidence is lost, the evidence queue reaches two seconds, or disk reaches reserve;
- SDRconnect becomes LAN-reachable on port 5454;
- the receiver rate/configuration changes without a new baseline fingerprint;
- the UI claims dBm, spoofing, deliberate jamming, or High evidence from RF-only data.

Collect without deleting evidence:

```bash
sudo rf-monitor support-bundle
sudo rf-monitor logs 500
systemctl show rf-monitor.service -p MemoryCurrent -p MemoryPeak -p NRestarts
systemctl show sdrconnect-headless.service -p MemoryCurrent -p MemoryPeak -p NRestarts
df -h /var/lib/rf-monitor/evidence
sudo ss -lntp
```

For a stalled receiver, check USB, RF power/gain state, and SDRconnect logs, then use the bounded dashboard Retry action. Do not create an unbounded restart loop.

## Rollback Without Losing Evidence

Rollback restores the saved operational revision and prior application package; it never rolls back, edits, or deletes evidence written under manifest v2.

1. Stop accepting new operator work and record the rollback reason/UTC time.
2. Finish or cancel export jobs through the application. Preserve any completed `.partial` diagnostics rather than renaming them as valid ZIPs.
3. Use protected Settings to select the saved pre-fast operational revision when the current application is healthy enough to do so.
4. If the package must be reverted, run the supported installer from the previously approved release folder. The installer must preserve `/var/lib/rf-monitor/evidence` and configuration backups.
5. Run:

   ```bash
   sudo systemctl daemon-reload
   sudo rf-monitor restart
   sudo rf-monitor doctor
   sudo rf-monitor verify-sdr
   sudo rf-monitor verify-spectrum
   ```

6. Confirm the previous profile revision is active, monitoring resumes, ports remain loopback-only, and new evidence is written to a new session.
7. Verify a sample of both manifest-v1 and manifest-v2 evidence. Record the incident IDs/session parts that span the rollback.

Stop if the rollback would overwrite active configuration blindly or delete evidence. Preserve a support bundle and escalate to the software/evidence custodian.

## Approval Record

Protected-baseline approval is permitted only after all applicable checks pass. Record:

- operational/catalog/detector versions and baseline fingerprint;
- bounded V7 start/end UTC and 24-hour representative-coverage evidence;
- revisit and miss distributions, not only averages;
- network, memory, event-loop, writer, disk, and export results;
- managed-switch before/after counter evidence;
- every exception and remediation;
- approver identity and UTC approval time.

Until approval, the system remains Checking or produces Low-evidence observations only.
