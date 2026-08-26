# Mediterranean Internal GNSS/RF Awareness Delivery Plan

**Status:** Bounded implementation plan  
**Date:** 2026-08-24  
**Specification:** [Mediterranean Internal GNSS/RF Awareness Specification](mediterranean-internal-monitoring-spec.md)

## 1. Delivery Goal

Deliver a dependable **Primary Watch** and evidence-review workflow for the known Mediterranean work area using the existing single RSPdx/RSPdx R2 installation.

The project will improve the current product in place. It will not become a general RF platform, a spoofing detector, or a multi-sensor system. Each implementation or acceptance task is bounded to no more than 24 elapsed hours. V7 remains the final formal development gate; no V8/V9 work is added.

## 2. Scope Decisions

1. Primary Watch on one selected GNSS capture window is the default internal mission.
2. The combined L1/E1/B1C/SBAS-L1 target is the initial recommendation unless the project names another operationally critical target.
3. Multi-band is a best-effort, gap-labelled survey until live timing proves reserve. Its current nominal schedule is fully utilized.
4. StarTrack/4DX remain off unless a documented matching antenna/RF chain is selected and recommissioned.
5. The application displays the confirmed antenna input; it does not automatically switch ports or bias power.
6. Signal learning creates a local reference, not an assumed clean baseline.
7. Evidence replay is same-host, read-only visualization. Import and detector re-analysis are deferred.
8. Internal Monitoring ready does not silently weaken or replace formal Production qualification.

## 3. Work Sequence

### Batch 0 — Freeze the deployment record

Record before qualification work:

- exact RSPdx/RSPdx R2 model and serial;
- exact AD492 model, supported frequencies, required DC voltage/current, and power method;
- active antenna input;
- cable, filter, LNA/bias, gain, SDRconnect version, 10 MS/s read-back, FFT grid, and analysis mask;
- selected Primary Watch target; and
- site/deployment identity and UTC clock status.

If the antenna power or frequency specification is unknown, monitoring may continue for investigation, but Signal learning is not approved and the installation is not qualified.

**Exit:** One reviewed deployment record matches the values reported by the running server.

### Batch 1 — Correct qualification truth

Implement a clear qualification boundary:

`Preparing → live observation running → formal Passed or Failed`

- During the five-minute Preparing interval, incomplete RF fingerprint/receiver metadata remains Pending and is not added to the sticky fault ledger.
- The automated live observation window starts after Preparing. Missing or invalid receiver metadata, timing, evidence, or resource health from that point is recorded fail-closed.
- The live observation clock is not formal approval. Frozen-chain documentation, protected baselines, V0–V7 artifacts, and independent approval remain required blockers until present.
- A qualifying loss or mismatch after the live observation starts is recorded once and remains sticky.
- A configuration/mission change creates a new Pending epoch. A receiver-reported fingerprint change invalidates matching baseline readiness; a physical RF-chain change that is not machine-readable must be recorded by the site procedure and starts a new acceptance run. None of these paths edits an old failure into a pass.
- Monitoring now and Production qualification remain separate API and UI facts.

Focused tests:

- startup metadata absent, then available;
- metadata loss after Running;
- duplicate health polling does not duplicate a fault;
- restart preserves the prior failed epoch;
- RF-chain or mission change starts a new Pending epoch; and
- missing formal gates produce Pending/Not qualified, not a fabricated pass.

**Exit:** A healthy startup cannot fail solely because it was still warming up; a real post-start fault still fails closed.

### Batch 2 — Make coverage and recovery truthful

- Keep a short recent-window coverage state for the operator and a full-epoch ledger for qualification.
- Show the late capture target, objective, measured revisit, and cause.
- Measure tune confirmation, settling, discarded frames, collection, processing, and total visit time from the live receiver.
- Make Primary Watch the default mission for this deployment.
- Keep optional targets paused while their work could affect the selected mission.
- Treat Multi-band as best effort until measured p99 timing leaves at least 10% reserve and the formal revisit criteria can pass.
- Do not lower the 99.9% formal threshold or weaken the fresh-frame gate to obtain a green result.
- Exercise existing bounded SDRconnect recovery. Change its cadence or trigger only if it misses the existing detection/recovery objectives.

Focused tests:

- delayed/missing frames, tune timeout, mismatched read-back, and event-loop jitter;
- current coverage returns On time after recovery while an earlier failed epoch remains failed;
- zero old-frequency attribution;
- zero optional-work misses; and
- receiver stall recovers to a confirmed fresh frame or reaches visible lockout without a restart loop.

**Exit:** Primary Watch is timely and explainable on the installed receiver. Multi-band is either measured feasible or remains explicitly unqualified.

### Batch 3 — Improve only the operator-facing gaps

- Replace ambiguous `Mode: Field` presentation with `Live field data`.
- Present `Monitoring now`, `Scan coverage`, `Recording`, and `Production qualification` separately.
- Group qualification blockers into no more than four operator actions; keep raw codes in Engineer details.
- Show `Unlock to change` beside view-only Monitoring settings.
- Keep the three monitoring tasks: Primary Watch, Multi-band Survey, and Radio Survey.
- Show the confirmed active antenna input in System Health/Engineer details; keep the complete physical RF-chain label in the site-acceptance record until a trustworthy backend field exists.
- Warn when the confirmed input or RF fingerprint changes.
- Add short `/help` actions for Coverage late, receiver recovery, Signal learning, and evidence review.

No dashboard redesign, automatic antenna switching, or bias-T control is included.

**Exit:** A normal operator can identify what is monitored, whether it is timely, what input is active, what action is required, and why formal qualification is Pending/Failed.

### Batch 4 — Add minimal evidence replay

Add **Replay** to eligible same-host Evidence History sessions.

- Allow Complete and clearly gap-labelled Incomplete sessions.
- Reject Active, Finalizing, and Corrupt sessions.
- Stream bounded frame batches using `frames.jsonl` offsets into the referenced raw `.bin` chunks.
- Reuse the existing spectrum and waterfall.
- Provide play/pause, next, restart, speed, and the stored observation timestamp.
- Keep recorded session-level gap reasons visible. Direct incident seeking and synthetic frame-level gap markers are deferred.
- Keep a persistent `Archived replay · Read only` label.
- Show the original stored incident verdict; do not rerun the detector.
- Make zero writes to Field baselines, incidents, evidence, commissioning, or qualification.

Focused tests cover invalid paths, out-of-range offsets, truncated chunks, lifecycle refusal, gap/event ordering, bounded memory, and zero Field-tree mutation.

**Exit:** An operator can review one stored event without opening `.bin` files manually or changing operational data.

### Batch 5 — Focused release verification

Run only the tests needed by the changed surfaces:

- type checking, unit tests, and production build;
- qualification-state regression tests;
- scheduler and SDRconnect fault tests;
- evidence decoding, integrity, and domain-isolation tests;
- packaged browser flows for startup, Primary Watch, Coverage late/recovery, active-input visibility, and replay; and
- evidence package download and verifier check.

Do not add unrelated detector families or expand the UI during this batch.

**Exit:** The frozen package passes the focused suite with no stale Normal state, field/test contamination, console error, unbounded queue, or evidence-integrity regression.

### Batch 6 — Freeze the RF chain and run the site acceptance

1. Freeze the exact package, configuration, receiver, active antenna input, and RF chain.
2. Restart Signal learning for the selected Primary Watch target.
3. Review and protect a representative local reference only when independent operational information supports it.
4. Run a bounded 24-hour live Primary Watch acceptance with actual coverage/gap, evidence, resource, clock, and recovery records.
5. Have one internal verifier other than the implementer review the package hashes and result.

This establishes internal Monitoring readiness for the selected mission. It does not claim that Multi-band or Radio Survey is qualified.

Formal Production qualification follows the existing V0–V7 contract without weakening it. If the installed setup cannot satisfy the four-target timing or installed-chain evidence requirements, Production qualification remains Pending while truthful Primary Watch monitoring and evidence collection may continue. V7 is the final gate.

**Exit:** The selected mission has a preserved pass/fail site-acceptance record; formal Production qualification accurately reflects the separate V0–V7 status.

## 4. Stop Conditions

Stop promotion and correct the cause if any of these occurs:

- a warm-up-only condition still creates a sticky failure;
- receiver, active input, antenna power, or RF-chain identity is unknown;
- stale or mistuned data is presented as Normal;
- Primary Watch repeatedly misses its objective;
- Multi-band is presented as qualified without measured reserve;
- an evidence package fails verification or an alert loses its evidence;
- replay writes to Field data or opens an unsafe raw path;
- recovery loops, loses receiver identity, or resumes without confirmed center/rate read-back; or
- any screen claims spoofing, deliberate intent, calibrated power, source location, or continuous coverage.

## 5. Deferred Work

The following are deliberately excluded from this execution plan:

- second receiver or spatially separated antenna processing;
- direction finding, source geolocation, or spoofing classification;
- GNSS message/PVT decoding or automatic navigation-receiver integration;
- calibrated dBm/field-strength measurement or IQ capture;
- automatic A/B/C switching or bias-T control;
- simultaneous GNSS, StarTrack, and 4DX monitoring;
- ML/predictive analytics or automatic countermeasures;
- uploaded-archive replay or detector re-analysis;
- public cloud, mobile, maps, AIS/weather integrations, or multi-site fleet management; and
- V8/V9 development gates.

Any future proposal must identify a real operational need and show that the current receiver, antenna, timing, and evidence limits can support it before it enters the plan.

## 6. Required Deliverables

The plan produces only:

1. the constrained specification and deployment record;
2. focused code changes and tests for qualification, coverage, status/antenna visibility, and replay;
3. an immutable built package;
4. one bounded live Primary Watch acceptance record; and
5. the truthful formal V0–V7 status for the exact installation.
