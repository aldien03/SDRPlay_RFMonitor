# Validation And Assurance

RF Monitor is qualified in stages. A result from one stage must not be used as evidence for a higher stage.

The frozen scenario set, seed protocol, score definitions, confidence limits, and installed-chain stop conditions are in [Detector Validation Protocol](detector-validation-protocol.md).

| Level | Evidence | Supported conclusion |
|---|---|---|
| 1 | Deterministic synthetic display-FFT scenarios | Software scheduling, detection, unknown-state, evidence, UI and resource behavior for the tested fixtures |
| 2 | Held-out real recordings with frozen preprocessing | Algorithm behavior on those recordings; the installed RF chain remains untested |
| 3 | Calibrated conducted or shielded input through the installed RSPdx and SDRconnect | Detection performance within the tested frequency, waveform, duration and input-level range |
| 4 | Authorized field test with independent GNSS/navigation truth | Relationship between RF observations and navigation effects for the tested equipment and conditions |

Passing Level 1 does not establish RF sensitivity, field false-alarm rate, navigation integrity, spoofing detection, transmitter identity or deliberate intent.

## Synthetic Qualification Rules

- Every scenario has a schema version, scenario version, deterministic seed and SHA-256 commitment.
- Scenario time is global monotonic time. It does not begin when the tuner reaches a target.
- Detector-facing frames contain only normalized `Uint8Array` bins and measurement-health state. They contain no scenario identity, event kind or expected result.
- Guided runs may reveal truth. Blinded runs reveal only a commitment until scoring is complete.
- Sham and matched-power-spoofing fixtures require no alert.
- Data-gap and configuration-change fixtures require an unknown result, never clean.
- Synthetic outputs are marked `synthetic: true` and never enter operational evidence or protected baselines.
- Scenario definitions, software build, configuration, rule set and baseline inputs are hashed independently.

Score independent runs, not adjacent frames. Report event-level detections, misses, expected non-detections, unexpected alerts, wall-clock latency, observed-exposure latency, unobserved events, false-alert duration and confidence intervals. Publish results by scenario family and scheduler phase instead of only one aggregate percentage.

## Software Release Evidence

Run from the source directory with Ubuntu system Node.js:

```bash
/usr/bin/node --version
npm run check
npm run build
npm run test:sites
```

### V2 packaged process and storage qualification

Run V2 only after freezing and building the candidate. The harness starts the
built server with `/usr/bin/node`, a loopback SDRconnect fixture, real HTTP and
WebSocket clients, and temporary field/test trees. It deliberately sends
`SIGKILL` at bounded evidence-write, finalization, and rotation boundaries,
then restarts the same package and runs the offline evidence verifier twice.

```bash
npm run build
npm run validate:v2
```

Expected result: six named fault cases print `PASS`, followed by the absolute
path to `artifacts/validation/v2/.../qualification.json`. Stop if any case
prints `FAIL`, if the process is not reported as `SIGKILL`, or if the final
record says anything other than `PASS`. Do not copy the fault environment
variables into a service file. The server accepts them only with the exact
test acknowledgement and only when all paths are confined to one directory
below the host temporary directory.

The V2 record proves only the built software boundaries exercised by the
fixture. It checks:

- real packaged HTTP/WebSocket flow and a fake SDRconnect control/readback path;
- no falsely Complete session after each crash;
- deterministic `PASS` or `INCOMPLETE` evidence-verifier output, never `FAIL`;
- byte-identical test-domain data while the field process runs;
- no stale-frequency marker assigned to a newly confirmed tune epoch; and
- the 64-item/2 MiB writer, 256 KiB client queue, 64 KiB health response,
  packed ring, and 768 MiB process ceilings.

It does not replace sudden-power-loss testing on the installed filesystem,
calibrated RF work, or the required bounded gates through V7.

### V7 development qualification

Use [V7 Development Qualification](v7-v8-site-qualification.md) only after the
exact-candidate V0–V6 artifacts and physical installed-chain evidence exist.
The system-Node runner caps V7 at 24 server-timestamped hours. It copies
witnessed prerequisite evidence, records bounded fsynced JSONL chunks, rejects
identity/epoch/counter/clock discontinuities, and writes a no-replace `PASS`
or `FAIL` artifact.

```bash
npm run validate:v7 -- --help
```

This command displays the staged `init`, `collect`, `status`, and `finalize`
interfaces. It does not run or pass the gate. V7 is the final development gate.

The release record must include:

- source/package revision or digest;
- operating-system and Node versions;
- configuration, catalog, detector and baseline hashes;
- complete command output and exit status;
- independent test count and failing-test details;
- browser URL, viewport, console result, interaction path and screenshots;
- a downloaded synthetic validation report with matching truth commitment;
- known exclusions and the highest validation level actually completed.

A passing build is not physical acceptance. Keep development qualification incomplete until the real receiver, final antenna chain, timing objectives, protected baselines, recovery, fault checks, resource limits, and evidence continuity pass the bounded gates through V7.

Physical qualification is live-data only: V5 accepts independently captured real-receiver FFT sessions, V6 accepts real RSPdx/RSPdx R2 frames from the witnessed installed-chain fixture, and V7 accepts only live field-domain frames from that installed receiver. Simulation and generated scenarios can prove software behavior in V4, but they cannot satisfy V5–V7 or production readiness.

See [Live Qualification Data Policy](live-qualification-data-policy.md) for the exact accepted sources and stop conditions.

## Release Stop Conditions

Do not approve a protected baseline or describe the installation as qualified when any of these is true:

- simulated data is presented as physical RF;
- a stale or mismatched frame is assigned to a new tune epoch;
- unknown data trains a baseline or clears an incident;
- learning or provisional data produces a normal/qualified operator state;
- synthetic evidence appears in operational history;
- an expected matched-power non-detection is described as spoofing detection;
- evidence loss, unbounded queues, timing-history mixing or configuration-epoch mixing remains unresolved;
- the current qualification interval contains a prior fault or did not complete its required duration.

## Operator Workflow Validation

Use representative operators and both routine and rare critical scenarios. Measure whether they:

1. identify monitoring availability;
2. distinguish an RF observation from navigation impact;
3. use an independent position check and vessel procedure;
4. preserve the incident evidence;
5. avoid claiming confirmed jamming or spoofing.

Record task completion, incorrect conclusions, time to action and evidence-download success. UI preference is not detector validation, and detector validation is not navigation-system validation.

## Research Basis

- [Kriezis et al., Real-World Spoofing Detection (ION ITM 2025)](https://web.stanford.edu/group/scpnt/gpslab/pubs/papers/Kreizis_ION_ITM_2025_Real_World_Spoofing_Detection.pdf) reports that no single metric detects every spoofing attack and that performance can be receiver- and scenario-dependent. This is why the matched-power fixture is a required negative control, not a claimed spoofing-detection success.
- [IMO MSC.112(73)](https://wwwcdn.imo.org/localresources/en/KnowledgeCentre/IndexofIMOResolutions/MSCResolutions/MSC.112%2873%29.pdf) assigns position-validity and loss-of-position warnings to shipborne GPS receiver equipment. A spectrum-only sensor does not have those navigation measurements.
- [BSH/DLR BeJamDetect final report](https://doi.bsh.de/10.57802/ekj6-1326) documents maritime interference work with dedicated functional models tested aboard ships. RF Monitor therefore keeps synthetic software tests separate from installed-chain and field evidence.
- [SDRplay RSPdx datasheet](https://www.sdrplay.com/resources/RSPdxDatasheet.pdf) defines the receiver's rate, output-resolution and bandwidth constraints used by the hardware qualification plan.
- [SDRconnect WebSocket API](https://sdrplay.com/wpyog_document/sdrconnect-websocket-api-specification/) defines the observable control and spectrum interface. The validation generator models its packed relative display-bin boundary, not calibrated RF power or IQ navigation observables.
