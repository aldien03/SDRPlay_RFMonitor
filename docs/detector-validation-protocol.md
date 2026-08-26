# Detector Validation Protocol

**Protocol:** `rf-relative-mad-qualification-1.1.0`  
**Status:** frozen test design; physical installed-chain qualification not run

This protocol verifies the transparent median/MAD detector. It does not validate a spoofing classifier, navigation integrity, transmitter intent, dBm, field strength, or simultaneous multi-band coverage.

## Validation levels

| Level | Input | What it can establish | What it cannot establish |
|---|---|---|---|
| Isolated deterministic | Versioned normalized uint8 FFT fixtures | Reproducibility, mandatory event/control behavior, gap semantics, scoring | Receiver or antenna performance |
| Isolated randomized | At least 400 independent seeds per Tier-1 target/family | Software behavior across the frozen high-margin parameter envelope and one-sided 95% limits | Physical sensitivity or field performance |
| Held-out replay | Immutable receiver FFT sessions not used to tune rules | Performance on recorded receiver distributions and nuisance conditions | Current installed-chain performance |
| Installed chain | Conducted RF through the final receiver/filter/cable/LNA/gain chain | Tested detection envelope, overload separation, target/range correctness, guard rejection | Events outside the tested envelope or between visits |

The four Tier-1 targets are tested separately. Results do not transfer across receiver model/device, antenna, filter, cable, LNA/gain, SDRconnect version, sample rate, FFT grid, analysis mask, catalog, detector, or rule-set changes.

## Frozen definitions

The machine-readable plan is returned by `detectorQualificationPlan()` in `src/shared/detectorQualification.ts`. Its canonical SHA-256 is stored in each isolated report. Each run records:

- plan, scenario, detector, rule, configuration, baseline, and software hashes;
- physical target and exact analyzed frequency bounds;
- seed or immutable corpus/acquisition ID;
- a SHA-256 truth commitment created before detector output is scored;
- valid and unknown observation windows;
- alerts, event verdicts, misses, false alerts, and receiver-overload classification.

Random trial seeds are SHA-256 of:

`plan-version:target-id:scenario-family:trial-index`

Adjacent frames are not independent trials. Confidence limits are computed across independent runs.

The randomized high-margin envelope is deliberately limited to events observable
by the configured visit cadence. Pulsed-wideband cases use a one-second period,
60–90% duty cycle, and enough median-preserved visits to accumulate the required
exposure. Moving-narrowband cases use a 90–180 second sweep so motion across one
three-frame visit is no more than two bins. Lower-duty, asynchronous, faster, or
wholly inter-visit events remain characterization cases and are never relabelled
as guaranteed detections.

## Scoring definitions

- **End-to-end detection:** an expected alert was reported, including tuner scheduling and data availability.
- **Conditional detection:** an expected alert was reported among events with valid observed exposure.
- **Unobserved event:** no valid exposure overlapped the truth interval. It remains an end-to-end miss and is reported separately; it is not counted as a clean detector result.
- **Wall-clock latency:** alert start minus truth-event start.
- **Observed exposure to alert:** union of valid target-observation windows between event start and alert start.
- **Unobserved latency to alert:** wall-clock latency minus observed exposure to alert.
- **False alert:** an unmatched alert or an alert overlapping a no-alert control.
- **False-alert duration:** union of false-alert intervals, so overlapping alerts are not double-counted.

Alert continuity follows the detector's configured ten-clean-observation clear
rule. The harness does not split one continuing incident after a shorter gap.

Reports contain per-target counts and latency distributions. Aggregate qualification reports contain one-sided 95% Wilson limits per physical target and scenario family. Randomized high-margin alert and negative-control families require a lower limit of at least 0.99 after at least 400 independent trials.

## Mandatory scientific controls

- A matched-power spoofing control leaves the post-FFT power distribution unchanged and must remain a neutral RF-spectrum non-detection.
- Configuration change and data gap must be Unknown, never clean.
- Receiver overload must be reported as overload with no RF-anomaly bin mask.
- Guard-only energy outside the central analysis mask must create neither analyzed anomaly bins nor an RF-interference alert.
- Threshold-edge sweeps characterize the boundary; they are not relabelled as high-margin pass cases.
- Viewing a holdout result and then changing a threshold creates a new detector/rule version and requires a new holdout corpus.

## Installed-chain stop conditions

Installed-chain results cannot be generated in simulation. Qualification stops if the final chain is incomplete, equipment calibration is absent/expired, target/range metadata does not match the conducted setup, the truth commitment is missing, or raw acquisitions/hashes are unavailable. A failed or incomplete run is retained; it is not rewritten as a pass.
