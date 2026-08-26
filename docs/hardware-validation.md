# Hardware Commissioning

Complete this procedure on the actual Ubuntu 24.04 host with the installed SDRplay receiver, final antenna/RF chain, final network, and final storage. WSL or simulation results do not satisfy commissioning.

The supported v1 configuration is one original RSPdx acting as one uncalibrated, single-tuner spectrum sensor. It does not capture IQ, measure calibrated dBm, classify GNSS spoofing, identify a transmitter, or establish deliberate intent. Its revisit values are measured objectives, not guarantees.

Use only legal, authorized, low-power test sources and approved RF procedures. Do not radiate in GNSS or licensed operational bands unless explicitly authorized. Prefer shielded/cabled injection with suitable attenuation and protection.

## Commissioning Record

Record before testing:

- UTC date/time and personnel;
- RF Monitor version;
- SDRconnect version/build;
- Ubuntu kernel and host asset ID;
- SDRplay model and serial/asset identifier;
- USB port/cable/hub details;
- antenna, cable, splitter, filter, LNA, attenuator, and surge-protection chain;
- configured receiver URL, device index, sample rate, and gain approach;
- catalog version;
- operational profile revision/hash;
- site name, deployment ID, display time zone;
- enabled logical signals, physical capture targets, and measured revisit objectives;
- confirmed sample rate, central analysis width, FFT grid, and guard-bin mask;
- evidence path/filesystem/capacity;
- test equipment model, calibration status, levels, and connections.

Do not include passwords or private keys.

## 1. Physical Inspection

- [ ] Receiver is mechanically secure and labelled.
- [ ] USB cable is short/reliable and not through an unapproved hub.
- [ ] Antenna/feed line matches enabled frequency coverage.
- [ ] Splitter/LNA/bias configuration is documented.
- [ ] Input protection/attenuation prevents damage and overload.
- [ ] Host power and shutdown strategy are appropriate.
- [ ] Evidence disk is the intended durable filesystem.
- [ ] Cooling, grounding, and cable routing are acceptable.

Photograph/record the final RF chain according to site policy.

## 2. Host And Time

```bash
cat /etc/os-release
uname -a
timedatectl status
df -h
sudo rf-monitor doctor
```

Pass criteria:

- Ubuntu 24.04;
- clock synchronized;
- no blocking doctor failure;
- evidence filesystem mounted with configured reserve available;
- service uses `/usr/bin/node`.

## 3. Device Discovery

```bash
lsusb
groups rfmonitor
sudo systemctl status sdrconnect-headless.service --no-pager -l
sudo rf-monitor verify-sdr
```

Pass criteria:

- physical RSP appears in SDRconnect valid devices;
- selected device index points to that RSP;
- source is not only `IQ File`;
- SDRconnect API/version metadata is captured.
- SDRconnect listens only on localhost and port 5454 is unreachable from the operator LAN.

## 4. Binary Spectrum Stream

```bash
sudo rf-monitor verify-spectrum
```

Pass criteria:

- test starts the physical receiver;
- at least one documented binary spectrum frame is received within timeout;
- reported frame length/header are plausible for the API;
- service resumes normal operation afterward.

Save the command output in the commissioning record.

## 5. Dashboard Readiness

Open the production HTTPS URL from an operator computer.

- [ ] Certificate is trusted and hostname matches.
- [ ] Header identifies the correct site.
- [ ] Receiver says Monitoring/Spectrum stream live.
- [ ] Archive says Recording evidence.
- [ ] Status uses Normal/Checking/Alert/Recovering/Paused/Offline truthfully.
- [ ] Every configured service/GNSS system and physical target matches the approved profile.
- [ ] Revisit/coverage warnings reflect one tuner.
- [ ] RF-only evidence is Low or Medium; High is never generated.
- [ ] No view claims absolute dBm, spoofing, deliberate jamming, or transmitter identity.
- [ ] Display time is correct while evidence fields remain UTC.

## 6. Frequency Accuracy

For each receiver path, inject or receive an authorized known-frequency signal.

1. Open Engineer details.
2. Use time-bounded Exclusive Engineer Focus on the valid catalog target when appropriate, after accepting the two-step coverage warning.
3. Observe the peak in the actual frame bounds.
4. Compare displayed frequency with the source/reference.
5. Record offset, sample rate, receiver temperature, and configuration.
6. End focus and confirm automatic normal-profile resume and an audit record of every suspended objective.

Pass criteria are defined by the RF engineer for the receiver/reference. RF Monitor does not perform laboratory calibration automatically.

## 7. StarTrack Coverage

For the deployed profile:

- [ ] complete range or every selected deployed frequency is represented;
- [ ] selected frequencies align to the installed 25 kHz catalog grid;
- [ ] frame windows cover selected frequencies without unintended gaps;
- [ ] measured full revisit is consistent with the displayed estimate;
- [ ] known in-band signal is visible;
- [ ] out-of-selection frequency is not incorrectly attributed to StarTrack evidence.

If using full `410-470 MHz`, document that this range requires multiple instantaneous windows at typical sample rates and therefore is swept, not continuously observed by one tuner.

## 8. 4DX Coverage

- [ ] all 91 channels or approved contiguous range is selected;
- [ ] saved range contains at least 51 channels;
- [ ] channel 1 center is `902.400 MHz` in the supplied catalog;
- [ ] channel 91 center is `927.600 MHz` in the supplied catalog;
- [ ] adjacent centers are separated by `280 kHz`;
- [ ] boundary and representative middle channels are visible through Exclusive Engineer Focus;
- [ ] scan attribution reports 4DX correctly.

Use Exclusive Engineer Focus, not a saved one-channel profile, for single-channel diagnosis.

## 9. GNSS Physical Targets

For the default fast profile:

- [ ] combined GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1 tunes at 1575.420 MHz with a 2-second objective;
- [ ] GPS L2C tunes at 1227.600 MHz with a 6-second objective;
- [ ] combined GPS L5 / Galileo E5a / BeiDou B2a tunes at 1176.450 MHz with a 6-second objective;
- [ ] GLONASS G1 tunes at 1601.719 MHz and displays nominal 1602.000 MHz with a 6-second objective;
- [ ] logical signals sharing a center produce one physical observation/incident while retaining all logical labels;
- [ ] signals with different centers never merge;
- [ ] the nominal 10 MHz display shades outer guard/roll-off bins and detector analysis is central 8 MHz or less;
- [ ] Tier 2, G3, E6, B3I, StarTrack, and 4DX are disabled or **Paused — protecting GNSS** unless separate qualification proves safe slack;
- [ ] every miss is visible with a cause and optional work causes zero Tier-1 misses.

Do not attempt an unauthorized GNSS transmission test. Use shielded conducted methods, passive observation, or an approved simulator facility. An IQ-file replay may test software separately, but IQ capture/replay is not a production RF Monitor v1 feature and cannot commission the live RF chain.

## 10. Baseline Lifecycle

Collect a representative quiet baseline for every physical target over operational day/night conditions. Keep the receiver, antenna, LNA/fixed gain, center/span, sample rate, FFT grid, analysis mask, SDRconnect version/display reference, catalog, and detector version unchanged.

Record:

- per-bin median/MAD and quantization-aware robust scale;
- observed exposure, unobserved gap, and valid-visit coverage;
- baseline fingerprint and hourly coverage counters;
- SDRconnect vendor-reported relative power/SNR fields, clearly sourced and never called calibrated dBm;
- overload state;
- known local emitters and schedules;
- weather/antenna state where relevant;
- false-positive events.

The initial defaults are commissioning recommendations, not universal calibrated limits. Require at least 30 minutes for Learning/Provisional and 24 representative hours for Reviewable. Approve Protected only through the protected Settings session after the bounded 24-hour timing and signal-learning gate passes. A fingerprint change must select an exact baseline or return the target to Checking; it must not transform/delete an old protected baseline.

## 11. Detection Scenarios

Use authorized shielded/conducted injection or controlled simulation to test each rule. Simulation is a detector/software test, not live-RF hardware acceptance.

### Wideband Noise Rise

- apply a broadband rise across a monitored window;
- confirm at least 3 of 5 valid visits and the required observed-exposure behavior;
- verify affected service/range and recommendation;
- remove the signal and confirm recovery.

### Narrowband Spike

- apply one narrow in-band carrier;
- confirm peak and occupied-ratio classification;
- verify correct frequency attribution.

### Baseline Drift

- introduce a slow sustained level change;
- verify it does not trigger on one transient frame;
- confirm reset after approved profile/detector change.

### Overload

- use a safe attenuated method to demonstrate receiver overload behavior;
- confirm overload is recorded distinctly;
- verify operator guidance checks gain/filtering rather than claiming jamming.

### GNSS Abnormal Energy

- use an approved passive or shielded laboratory method;
- confirm wording is relative RF anomaly/suspected interference, not spoofing;
- correlate with independent navigation receiver data if available.

### Unknown And Clear Behavior

- delay or omit a visit and confirm it is unknown, not clean;
- introduce a tune mismatch/stale epoch and confirm the frame is rejected;
- confirm a candidate freezes short-term adaptation;
- after removing the fixture, confirm exactly ten valid clean observations are required to clear;
- confirm a matched-power spoofing fixture remains **not distinguishable from RF spectrum alone**.

Pass criteria:

- expected detector triggers within documented timing;
- no detector claims intent;
- event continues gathering evidence on normal revisits without an automatic incident hold;
- event JSON, bins, screenshot, notes, and manifest are consistent.

## 12. Operator Workflow

Using a controlled event:

1. observe plain-language status;
2. read affected service/frequency and recommendation;
3. add a factual note;
4. acknowledge;
5. open Engineer details;
6. start/end a short Exclusive Engineer Focus and confirm every suspension warning/audit entry;
7. download evidence package;
8. verify ZIP transfer checksum and internal manifest;
9. confirm focus/config/operator actions appear in evidence.

Repeat on the smallest supported operator viewport and normal desktop viewport.

## 13. Runtime Reconfiguration

1. Record current revision/hash/session ID.
2. Open Settings and enter **Admin mode**.
3. Make one valid profile change.
4. Apply.
5. Confirm old session finalized and hashes exist.
6. Confirm a new session starts with new revision/hash/catalog version.
7. Confirm affected baselines become Stale/Checking or select only an exact fingerprint match; protected baselines remain preserved.
8. Confirm monitoring resumes without Node restart.
9. Submit an invalid profile and confirm running revision is unchanged.
10. Test stale-revision conflict from a second browser.

## 14. Disconnect And Recovery

### Receiver Service

```bash
sudo systemctl stop sdrconnect-headless.service
```

Confirm dashboard changes to Offline/Data late and does not claim Normal. Then:

```bash
sudo systemctl start sdrconnect-headless.service
```

Confirm automatic reconnect, new frames, baseline behavior, and recorded gap.

### RF Monitor Restart

```bash
sudo systemctl restart rf-monitor.service
sudo rf-monitor doctor
```

Confirm last valid revision loads and temporary Exclusive Engineer Focus does not remain stuck.

### Host Reboot

```bash
sudo systemctl reboot
```

After return, confirm clock sync, mounts, services, receiver, monitoring, evidence, HTTPS, and revision.

## 15. Storage And Recycling

Use a controlled test environment or temporary small limits. Do not force production evidence deletion.

- [ ] session rotates at configured age;
- [ ] session rotates at configured size;
- [ ] raw chunks rotate hourly and at 128 MiB;
- [ ] sessions rotate at 2 GiB or 24 hours even during a long incident;
- [ ] the same incident continues across session parts without evidence truncation;
- [ ] oldest closed session is removed first;
- [ ] active session is retained;
- [ ] minimum free-space reserve is enforced;
- [ ] missing/read-only storage creates a visible failure;
- [ ] journald stays within configured maximum use/age;
- [ ] service recovers after storage restoration.
- [ ] first-candidate evidence includes the packed 60-second pre-history and continues for ten minutes after clear;
- [ ] incident-slice exports are multipart when required, each part is no larger than 256 MiB, and hashes verify.

Restore approved production limits after the test and record the resulting revision.

## 16. Scheduler And Resource Acceptance

Run the bounded V7 acceptance from [Fast-GNSS Commissioning And Resource Acceptance](fast-gnss-commissioning.md). The measured interval must not exceed 24 elapsed hours.

- [ ] Tier-1 command-to-confirm, confirm-to-third-frame, visit duration, revisit, and miss distributions are retained.
- [ ] At least 99.9% of completed Tier-1 revisits meet the applicable 2/6-second objective.
- [ ] Optional work causes zero Tier-1 misses.
- [ ] Live traffic stays at or below 1 MiB/s and total egress at or below 6 MiB/s during export.
- [ ] Managed-switch egress drops, discards, and pause-event counters do not increase.
- [ ] RF Monitor RSS p99 is below 384 MiB, maximum is below 448 MiB after warm-up, and whole-run slope is no more than 1 MiB/hour.
- [ ] Heap p99 is below 256 MiB and event-loop p99 is below 50 ms normally/100 ms during export.
- [ ] No queue grows, no alert evidence is lost, and clear-frame loss is below 0.1%.
- [ ] A ninth live dashboard is rejected and slow clients cannot grow beyond the configured queue bound.

## 17. Evidence Replayability

For a representative incident package:

- [ ] unzip on a separate controlled computer;
- [ ] verify transfer hash;
- [ ] verify every manifest file hash;
- [ ] parse JSON/JSONL successfully;
- [ ] reconstruct frequency axis from frame metadata;
- [ ] confirm screenshot matches event window;
- [ ] confirm catalog/profile revision and audit entries are included;
- [ ] confirm no IQ file exists and any unexpected IQ payload was counted/dropped;
- [ ] confirm no absolute Windows/Linux host path is required to interpret ZIP entries.

## Acceptance

Commissioning passes only when all required checks are complete, exceptions are documented and approved, and the following are true:

- live physical spectrum is proven;
- receiver/antenna chain is documented;
- clock and storage are healthy;
- selected coverage and temporal gaps are understood;
- measured Tier-1 revisit objectives, learning, recovery, evidence continuity, and resource bounds pass the bounded gates through V7;
- detector behavior is characterized at the site and the protected baseline is explicitly approved;
- runtime changes/recovery work;
- evidence exports verify independently;
- operators can complete the incident workflow without Linux access;
- system is not publicly exposed and SDRconnect port 5454 remains localhost-only;
- no acceptance statement claims IQ evidence, absolute dBm, GNSS spoofing, deliberate intent, or continuous coverage.

Sign and retain the commissioning record with the approved configuration hash, catalog version, test evidence hashes, open exceptions, and next review date.
