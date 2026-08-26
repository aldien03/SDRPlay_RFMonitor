# Mediterranean Internal GNSS/RF Awareness Specification

**Status:** Constrained implementation baseline  
**Date:** 2026-08-24  
**Deployment:** Known Mediterranean maritime work area  
**Audience:** Internal project operators, site IT, and RF support

## 1. Purpose

RF Monitor provides early awareness of unusual RF conditions before and during project work. It helps an operator:

- confirm that the receiver, selected monitoring mission, and evidence recording are working;
- notice relative RF changes affecting the selected GNSS or project-radio frequencies;
- preserve UTC-stamped spectrum evidence and operational notes for later correlation; and
- distinguish an RF observation from receiver overload, missing data, or late coverage.

This is an internal situational-awareness tool. It is not the sole navigation or safety alarm, a predictive system, or a regulatory/forensic attribution instrument. “Anticipation” means checking conditions before work and maintaining a watch during work; it does not mean forecasting a future RF event.

## 2. Fixed Hardware Envelope

| Item | Deployment rule |
|---|---|
| Receiver | One SDRplay RSPdx or RSPdx R2, qualified as the exact installed device |
| Tuner | One physical RF window at a time |
| RF chain | One final antenna/cable/filter/LNA/bias/gain chain at a time |
| GNSS antenna | The installed commercial antenna, currently AD492, only after its exact frequency and DC-power requirements are recorded |
| Antenna inputs | A or B may be used as alternative mission inputs; they are not simultaneous sensors |
| Antenna C | Not used for GNSS, StarTrack, or 4DX because those frequencies exceed its supported range |
| SDR input | Local SDRconnect, confirmed 10 MS/s, normalized relative FFT bins |
| Analysis | Configured central mask no wider than 8 MHz |
| Recording | Spectrum frames and metadata only; IQ remains disabled |

Connecting two antennas to A and B does not provide diversity, direction finding, angle of arrival, or spoofing detection. Only the selected input is observed. The software fingerprint binds receiver-reported settings, including active input, gain/reference settings, sample rate, FFT grid, and analysis mask. Physical changes that the receiver cannot identify—antenna, cable, filter, LNA, bias method—must be recorded in the deployment record and require a new acceptance run and restarted Signal learning.

RF Monitor v1 displays the confirmed active input. The full physical RF-chain identity remains an explicit site-acceptance record until the hardware exposes a trustworthy read-back. The software does not automatically hop antenna ports or control bias power. A mission requiring a different antenna is paused, changed under the site procedure, confirmed, and recommissioned.

## 3. Operating Missions

Only one mission runs at a time.

### Primary Watch — default

Primary Watch monitors one selected physical GNSS capture window and is the dependable internal operating mode for this one-tuner installation. Unless the project identifies a different critical signal, use the combined:

- GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1 window at 1575.42 MHz.

Another catalog GNSS target may be selected when it better matches the operational equipment. A Primary Watch result applies only to that selected physical window.

### Multi-band Survey — best effort

Multi-band Survey visits the four Tier-1 windows:

- GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1;
- GPS L2C;
- GPS L5 / Galileo E5a / BeiDou B2a; and
- GLONASS G1.

The 2-second L1 and 6-second L2/L5/G1 revisit values are measured objectives, not continuous-coverage promises. The current nominal schedule uses all tuner time. Multi-band remains a gap-labelled survey and is not called qualified unless live timing demonstrates sufficient reserve and the formal V7 criteria pass.

Tier-2 GNSS windows are selectable in Primary Watch. They are not added as background work while the Tier-1 schedule has no measured reserve.

### Radio Survey — separate antenna/setup

Radio Survey pauses GNSS and builds completed stitched surveys of:

- StarTrack: 410–470 MHz; and
- 4DX: 902.4–927.6 MHz.

It is operationally allowed only when the selected antenna and RF chain are documented to cover the requested range; v1 cannot electrically identify an attached antenna, so this remains a protected site procedure and acceptance stop condition. An AD492 or other GNSS-only chain does not qualify radio reception. Radio surveys show **Building first sweep** or **Last full sweep** and never imply simultaneous full-band reception.

## 4. What the Software May Conclude

RF Monitor may report:

- Suspected RF interference;
- Narrow RF anomaly;
- Receiver overloaded;
- Coverage lost;
- Test inconclusive; or
- No RF anomaly detected in completed valid observations.

It may detect repeated relative patterns covered by the validated rules, including wideband energy rise, narrow or moving energy, slow relative drift, overload, and receiver/data/coverage faults.

RF Monitor must not report:

- “spoofing detected” or a navigation-integrity conclusion;
- confirmed or deliberate jamming;
- transmitter identity, intent, direction, or location;
- calibrated dBm or field strength;
- simultaneous or gap-free multi-band coverage; or
- absence of an event during a period the tuner did not observe.

Spectrum-only evidence can support a **suspected interference** finding. Suspected spoofing remains an external operational observation that must be correlated manually with independent GNSS receiver alarms, position/time behavior, vessel or project logs, and other reports. That correlation is recorded as an operator note; it does not change the RF Monitor verdict.

Operator evidence is Low or Medium. RF-only v1 never reports High evidence.

## 5. Local Reference at a Known-Interference Site

Signal learning produces a **local reference**, not proof of a clean RF environment.

- The reference represents usual conditions for the exact installed chain and selected mission.
- A representative period is approved only after review against available GNSS receiver and operational records.
- If interference is already present throughout learning, the software may learn it as usual and later detect only changes from that condition.
- If no credible representative period is available, the target remains Checking or Provisional and evidence remains Low.
- A reference is never force-approved merely to make the dashboard green.

## 6. Operator Truth Contract

The interface keeps these facts separate:

- **Live field data:** real installed receiver data, not Simulation/Test;
- **Monitoring now:** Normal, Checking, Alert, Recovering, Data late, Paused, or Offline;
- **Scan coverage:** current visit timing and actual unobserved gaps;
- **Recording:** whether evidence is being committed; and
- **Production qualification:** the formal frozen-candidate V0–V7 result.

Primary Watch can be healthy and useful while formal Production qualification remains Pending. It must never imply that Multi-band or Radio Survey is qualified. Missing, stale, mistuned, incomplete, or unobserved data is Unknown/Checking/Data late, never Normal.

The normal dashboard leads with affected service/frequency, observation, first safe action, evidence state, and recording state. Raw counters and fault codes remain in Engineer details.

## 7. Evidence and Review

Field evidence includes UTC timestamps, actual coverage and gaps, relative spectrum frames, receiver/configuration identity, incident timelines, operator notes, and integrity hashes. Simulation/Test data remains in a separate trust domain.

Evidence History supports view, download, verification, and a minimal same-host replay:

- Complete sessions may replay.
- Incomplete sessions may replay only with persistent gap labels.
- Active, Finalizing, and Corrupt sessions do not replay.
- Replay reuses the existing spectrum/waterfall with play, pause, next, restart, speed, and the stored observation timestamp.
- An Incomplete replay keeps its recorded session-level gap reasons visible; v1 does not synthesize frame-level gaps or seek directly to an incident.
- Replay is always labelled **Archived replay · Read only**.
- Replay never trains a baseline, creates a Field incident, changes qualification, or reruns the detector.

Downloaded archives remain verifiable evidence packages. Upload/import playback and detector re-analysis are outside v1.

## 8. Reliability and Recovery

- USB presence, SDRconnect transport, live RF frames, scan timing, recording, and qualification are separate health facts.
- Qualification has a five-minute Preparing boundary. Warm-up metadata absence remains Pending; the automated live observation clock then starts and qualifying faults become sticky. This clock is not approval: the frozen-chain record, protected baseline, V0–V7 gates, and independent approval remain separate fail-closed prerequisites.
- A stalled receiver uses bounded recovery with cooldown and lockout. Success requires a newly confirmed RF frame at the requested center frequency and sample rate.
- Every tune failure, missed visit, restart, evidence gap, and recovery attempt remains visible and auditable.
- Current coverage may recover to On time while an earlier failed qualification epoch remains failed.

## 9. Internal Deployment Boundary

- The application remains on the approved private operator network behind HTTPS, firewall rules, and Nginx.
- SDRconnect and the Node backend remain local-only.
- Settings writes require the protected short-lived Settings session.
- Site identity and exact project location come from protected deployment configuration, not React constants or this document.
- No public internet, cloud service, mobile application, or multi-site fleet management is included.

## 10. Acceptance for Internal Use

The constrained deployment is useful when all of the following are true:

1. The exact receiver, active input, antenna power method, cable/filter/gain chain, software build, and selected mission are recorded.
2. A healthy startup reaches Monitoring ready without a warm-up-only permanent qualification failure.
3. Primary Watch meets its measured revisit objective during a bounded live field run, with no stale-frequency attribution or hidden gaps.
4. Recording remains healthy, and one downloaded evidence package verifies successfully.
5. Receiver-loss recovery succeeds with confirmed fresh frames or ends in a visible lockout.
6. An operator can identify the affected target, first action, recording state, and qualification state without Engineer details.
7. A stored incident can be reviewed through read-only replay without changing Field data.
8. No screen or export makes an unsupported spoofing, deliberate-jamming, dBm, localization, or continuous-coverage claim.

These checks make Primary Watch suitable for internal awareness. Formal Production qualification remains Pending unless the unchanged product contract and all V0–V7 requirements pass for the exact frozen installation.

## 11. Explicit Non-goals

The current project does not add a second receiver or antenna-processing path, direction finding, source geolocation, GNSS message/PVT decoding, spoofing classification, calibrated measurements, IQ recording, ML prediction, automatic countermeasures, automatic antenna/bias switching, simultaneous GNSS/radio monitoring, cloud services, or additional V8/V9 development gates.

Detailed installation, evidence, recovery, and formal qualification procedures remain in the existing documentation. This specification narrows the deployment; it does not duplicate those runbooks.
