# RF Monitor Production Development Roadmap

**Status:** Approved product scope; development completion capped at V7  
**Target:** One SDRplay RSPdx or RSPdx R2, one tuner, local SDRconnect, Ubuntu 24.04  
**Last updated:** 2026-08-23

This is the controlling plan for completing RF Monitor. Detailed commands remain in the existing installation, validation, commissioning, operation, and recovery guides. This document defines the order of work, dependencies, evidence, and release gates.

Production is fail-closed. A feature is not production evidence, a passing software test is not physical qualification, and a currently healthy receiver does not make an unqualified installation production-ready.

No development goal, release gate, acceptance test, or agent-run task exceeds 24 elapsed hours. `V7` is the final gate. Later long-duration observation programs are outside this roadmap and outside the production-readiness decision.

Production qualification is live-data only. `V5` uses independently captured real receiver FFT recordings, and `V6`–`V7` use the installed physical RSPdx/RSPdx R2 and final RF chain. Simulation remains isolated software-regression and training evidence; it cannot approve a baseline, commissioning epoch, physical gate, or production release.

The gate-by-gate source rules are defined in [Live Qualification Data Policy](live-qualification-data-policy.md).

## 1. Product Contract

RF Monitor will be the strongest reliable spectrum-only RF sentinel that can be built around one RSPdx or RSPdx R2.

### In scope

- Run continuously while truthfully observing one physical RF window at a time.
- Prioritize the four Tier-1 GNSS capture targets.
- Detect repeated relative RF-energy behavior covered by the validated rules:
  - wideband energy rise;
  - narrowband carrier or multitone activity;
  - moving narrowband energy;
  - slow relative drift against an approved baseline;
  - receiver overload;
  - tune, receiver, data, and coverage faults.
- Report affected service/frequency, observation, evidence strength, coverage, recording state, and first safe action.
- Preserve bounded, verifiable spectrum evidence and all monitoring gaps.
- Provide operator-safe diagnosis and recovery without routine developer assistance.
- Keep CPU, memory, network, disk, queues, exports, and browser clients bounded for unattended operation.

### Fixed hardware and signal assumptions

| Item | Production rule |
|---|---|
| Receiver | One original RSPdx or one RSPdx R2; each model and device is qualified separately |
| Tuner | One physical window at a time; all other targets are unobserved |
| Sample rate | Confirmed read-only 10 MS/s |
| Analysis span | Configurable central span no wider than 8 MHz; outer display bins are guard/roll-off |
| Input | SDRconnect normalized spectrum bins as relative values |
| IQ | Disabled and rejected |
| Priority | Four Tier-1 GNSS capture targets; optional surveys are slack-only |
| Baseline | Exact receiver, antenna, gain, RF configuration, target, grid, software, catalog, and detector fingerprint |

RSPdx and RSPdx R2 share the software implementation. Installed-chain, timing, and baseline results do not transfer between devices or between antenna, filter, cable, LNA/gain, SDRconnect, sample-rate, FFT-grid, or analysis-mask changes.

### Not claimed

- GNSS spoofing classification.
- Proof of deliberate jamming or transmitter intent.
- Navigation position, timing, or integrity assessment.
- Calibrated dBm or field strength.
- Simultaneous or gap-free coverage of multiple frequencies.
- Detection of an event that occurs entirely between visits.
- Detection of steady interference that is already present throughout first learning without an external reference.

RF-only operator verdicts are limited to **Suspected RF interference**, **Narrow RF anomaly**, **Receiver overloaded**, **Coverage lost**, **Test inconclusive**, and **No RF anomaly detected**. RF-only v1 produces Low or Medium evidence, never High.

## 2. Development Definition of Done

Development is complete when all of the following are true for one immutable production candidate on the final installed system and gates `V0` through `V7` pass.

### Truth

- The server is the single source of operator state, timestamps, detector attribution, recording state, and qualification state.
- Missing, stale, incomplete, mistuned, or unobserved data is Unknown, never Normal or clean.
- Simulation and field data cannot cross storage, baseline, incident, commissioning, export, or API boundaries.
- No display or evidence record overstates the analyzed frequency range or detector conclusion.

### Operator operation

- The normal dashboard answers: what is happening, where, what was observed, what to do first, whether evidence is recording, and how strong the evidence is.
- A normal user can recover a reconnectable receiver, diagnose Data late and Recording stopped, understand Signal learning, and download diagnostics/evidence without a terminal.
- Unresolved failures name the site-IT, storage, network, or hardware boundary; they do not merely say to contact the developer.

### Runtime and evidence

- Recovery is bounded, externally supervised, and cannot enter a restart loop.
- Evidence cannot be labelled complete until its data and hashes are finalized successfully.
- Upgrade, rollback, backup, and restore preserve all evidence and configuration history.
- Application pressure degrades browser service before scheduler, detector, or evidence work.

### Initial service objectives

| Objective | Required result |
|---|---:|
| Browser stale-state transition | `Data late` within 5 seconds of lost freshness |
| Stalled receiver detection | Within 10 seconds |
| Bounded recovery start | Within 30 seconds when recovery is safe |
| Reconnectable receiver restoration | Fresh confirmed RF frame within 2 minutes or visible lockout/failure |
| Tier-1 revisit conformance | At least 99.9% within the 2/6-second objectives |
| Optional-work Tier-1 misses | Zero |
| Old-frequency misattribution | Zero |
| Alert-evidence loss | Zero |
| Clear-frame loss | Below 0.1% |
| Live dashboards | Eight Engineer dashboards remain bounded; ninth live client rejected |
| Live traffic | No more than 1 MiB/s aggregate; 2 MiB burst |
| Total egress during export | No more than 6 MiB/s |
| RF Monitor RSS | p99 below 384 MiB; maximum below 448 MiB after warm-up |
| Heap | p99 below 256 MiB |
| Event loop | p99 below 50 ms normally; below 100 ms during export |
| RSS slope across the bounded V7 run | No more than 1 MiB/hour |
| Visible diagnostics traffic | Below 16 KiB/s per client |

The site owner must approve backup recovery-point and recovery-time objectives before site qualification. The initial design target is hourly incremental off-host evidence backup and a four-hour bare-host restoration, subject to the available backup system.

## 3. Delivery Rules

1. Refine the current Quiet Mission Board and task-based Settings. Do not replace the product shell.
2. Complete truth and data isolation before visual polish or new detector families.
3. Every backlog item requires implementation, automated tests, documentation, migration/rollback behavior, and a saved evidence artifact.
4. A failed qualification result is preserved. It is never edited into a pass.
5. A qualification-blocking fault restarts the affected clean clock after remediation on a new frozen release candidate.
6. Rollback may restore software and configuration, but never deletes or rewrites newer evidence.
7. Simulation, replay, laboratory, installed-chain, and field results remain separate validation levels.
8. Resource bounds are correctness requirements, not performance suggestions.
9. No production waiver is allowed for simulation contamination, stale-frequency attribution, unknown-as-clean behavior, false evidence completeness, alert-evidence loss, unbounded resources, or a false Normal/Qualified presentation.

Use these task states: **Planned**, **In progress**, **Blocked**, **Evidence ready**, **Passed**, and **Failed**. “Code complete” is not a terminal state.

## 4. Current Release Blockers

| Blocker | Required resolution |
|---|---|
| Current health can say Normal while qualification is failed | Separate authoritative Monitoring now and Production qualification states |
| Deployed package and workspace can differ invisibly | Expose immutable release/build identity and stale-client detection |
| Ambient simulation can use operational stores | Add mandatory field/test domains and quarantine contaminated learning records |
| Restart learning does not clear all detector state | Make restart atomic across active generation, votes, adaptation, and readiness |
| Missing visits do not reliably reduce baseline eligibility | Derive expected coverage from the scheduler and record every gap |
| Browser can derive red anomaly regions and fallback baseline values | Send detector-authoritative baseline/anomaly data or show unavailable |
| A real alert on an unpinned target may remain hidden | Temporarily surface the affected feed without changing saved pins or tuner behavior |
| Recovery timer can be enabled but inactive | Repair supervision and verify it in health and doctor |
| Evidence finalization errors can be detached or suppressed | Add a bounded transactional finalizer and offline verifier |
| Deployment is not immutable or health-gated | Use versioned releases, atomic activation, and automatic safe rollback |
| No automated off-host recovery | Add encrypted backup-age monitoring and measured restore drills |
| Formal browser, replay, installed-chain, and bounded 24-hour evidence is absent | Complete the required validation ladder through `V7` in section 8 |

### Milestone status

| Milestone | Current state | Completion condition |
|---|---|---|
| Product contract | Software evidence ready; final candidate pending | Exact hardware/claim guards pass focused source tests; the current candidate has not run immutable V1 |
| Wave A — Truth foundation | In progress | Historical evidence remains provenance only. Current health cannot imply development qualification. |
| Wave B — Monitoring trust | Passed | Combined software gate: `docs/validation-results/2026-08-23-wave-b-integration.md`; physical and statistical qualification remain in V4–V7 |
| Wave C — Evidence/recovery | In progress | Transactional evidence, resource-budget, and bounded-recovery tracks are active |
| Wave D — Operator product | Blocked | Canonical state and action contracts are stable |
| Wave E — Deployment/operations | Blocked | Recovery and evidence lifecycle pass fault tests |
| `V0`–`V3` software qualification | V1 passed; V2 passed for `1.0.0+c47dca84f3d3` only; V0/V3 not passed | V1/V2 are software evidence only. The V2 record is `artifacts/validation/v2/20260823T132122615Z-1.0.0+c47dca84f3d3/qualification.json`; rerun V2 after any later source change before promotion. |
| `V4`–`V6` detector/lab qualification | Not passed | Isolated synthetic, held-out replay, and installed-chain gates pass |
| `V7` development qualification | Not passed | The eligible final hardware completes the bounded 24-hour timing/learning gate |
| Development complete | Blocked | Waves A–E and required gates `V0`–`V7` pass for one frozen candidate |

## 5. Critical Path

```text
Scope and identity
    ↓
Field/test isolation + truthful health + RF epoch gate
    ↓
Scheduler + detector/baseline correctness + evidence transaction
    ↓
Bounded recovery + operator workflows + resource pressure behavior
    ↓
Immutable deployment + backup/restore + external supervision
    ↓
Frozen release candidate
    ↓
V0–V7 required development/qualification gates (no run exceeds 24 hours)
    ↓
Development complete; frozen production candidate
```

Scheduler/detector, evidence, and UI work may proceed in parallel only after their shared truth/data contracts are stable.

## 6. Engineering Work Breakdown

### Wave A — Scope, identity, and stop-the-line correctness

No later wave can qualify until this wave passes.

| ID | Deliverable | Depends on | Evidence of completion |
|---|---|---|---|
| `SCP-000` | Version the product contract, RF claims, hardware assumptions, data domains, and SLOs | None | Documentation and shared invariants agree; unsupported claims and IQ are impossible through type/API tests |
| `REL-010` | Add release version, source/package digest, dependency-lock digest, schema/catalog/config/detector versions, boot ID, and client/server build match | `SCP-000` | Health, bootstrap, diagnostics, and evidence identify the exact package; stale clients require reload |
| `DOM-020` | Carry `field` or `test` domain through monitor, detector, baselines, evidence, incidents, exports, commissioning, and APIs; use separate roots | `SCP-000`, `REL-010` | Every synthetic path and 100,000 test observations leave the pre-hashed field tree byte-for-byte unchanged |
| `DOM-030` | Add domain-safe Clear test data, atomic Restart signal learning, and separately protected recording retention | `DOM-020` | Cross-domain and crash tests prove an operation changes only the named domain and either commits fully or not at all |
| `HLT-040` | Separate current health and development qualification; add commissioning epoch and sticky fault ledger | `REL-010`, `DOM-020` | UI, API, doctor, and deployment refuse Qualified unless current health and required gates through V7 pass |
| `RF-100` | Harden requested/confirmed RF state, immutable configuration/tune/visit epochs, settle/discard/collect gate, model identity, and receiver/transport/frame separation | `HLT-040` | 100,000 delayed, duplicate, mismatched, reordered, and stale responses cause zero old-frequency attribution |

**Wave A exit:** field data is isolated; every deployed component identifies itself; no consumer can convert current Normal into Production qualified; RF frames are accepted only under a confirmed epoch.

### Wave B — Monitoring and detector trust

| ID | Deliverable | Depends on | Evidence of completion |
|---|---|---|---|
| `SCH-110` | Complete monotonic least-laxity Tier-1 scheduling, bounded visit extension, unknown visits, genuine completion-to-completion revisit, and actual unobserved gaps | `RF-100` | Virtual-clock fault matrix passes; only two real valid completions form a measured revisit; every miss has a cause |
| `DET-200` | Unify one active fingerprint/generation across persistent baseline and in-memory robust-statistics detector | `DOM-030`, `SCH-110` | Unknown/stale/mistuned/incomplete visits cannot train, vote clean, or clear; restart removes old votes and readiness |
| `DET-201` | Correct baseline eligibility, representative-hour exposure, rule fingerprinting, receiver identity, slow drift, candidate state, and cold-start handling | `DET-200` | A 23-hour outage plus isolated frames remains Learning; rule/hardware change returns to Checking; candidate cannot coexist with Normal |
| `DET-202` | Publish detector-authoritative anomaly bins and analyzed frequency bounds; separate overload from RF interference | `DET-200` | Guard-bin activity is never attributed to the analysis span; red UI regions exactly match detector output |
| `DET-210` | Freeze versioned deterministic, randomized, replay, and installed-chain scenario definitions and scorer | `DET-200`, `DET-201`, `DET-202` | Reports include per-target detections, misses, false alerts, observed/unobserved latency, seeds, truth commitments, and confidence intervals |

**Wave B exit:** the detector remains transparent median/MAD statistics, its state is reproducible, its claims are bounded, and its output is safe for one canonical operator presentation.

### Wave C — Evidence, budgets, and recovery

| ID | Deliverable | Depends on | Evidence of completion |
|---|---|---|---|
| `EVD-300` | Transactional evidence lifecycle: Active, Finalizing, Complete, Incomplete, or Corrupt; bounded finalizer queue; durability checkpoints; recovery; verifier | `REL-010`, `DOM-020`, `DET-200` | Kill/power-loss tests never produce a falsely complete archive; verifier deterministically reports PASS, INCOMPLETE, or FAIL |
| `EVD-310` | Incident slicing, multipart export, streamed hashes, `.partial` recovery, retention holds, and off-host backup/restore | `EVD-300` | Long incidents span rotations without truncation; parts reconstruct and hash; export cannot starve evidence; bare-host restore verifies v1/v2 evidence |
| `BUD-400` | Enforce receiver, waterfall, ring, queue, dashboard, bandwidth, export, memory, and pressure-degradation limits centrally | `SCH-110`, `EVD-300` | Adversarial subscriptions, slow clients, eight dashboards, alerts, and export create no queue or memory slope and preserve evidence priority |
| `REC-500` | Repair receiver recovery timer; add heartbeat watchdog, bounded attempts, cooldown/lockout, structured Retry state, and protected audited application restart | `HLT-040`, `RF-100`, `BUD-400`, `EVD-300` | USB loss, SDRconnect failure, stalled frames, app crash, and event-loop hang recover or enter a visible terminal state without loops |

**Wave C exit:** faults create explicit gaps, evidence remains truthful, resource pressure is bounded, and recovery succeeds or fails visibly.

### Wave D — Operator product and self-service

The server publishes one canonical operator summary. Mode, monitoring, incident, recording, system health, and production qualification remain separate dimensions.

Monitoring precedence is:

`Offline → Data late → Alert → Recovering → Paused → Checking → Normal`

An open incident remains visible if monitoring becomes Offline or Data late.

| ID | Deliverable | Depends on | Evidence of completion |
|---|---|---|---|
| `UX-001` | Canonical operator-summary contract and exhaustive state truth table | `HLT-040`, `DET-202` | No React component derives a competing verdict; compatibility aliases remain for one release only |
| `UX-002` | One authoritative observation timestamp, coverage state, and age per feed | `SCH-110`, `UX-001` | Card, graph, pinned shelf, incident, and footer timestamps agree through 100,000 deltas |
| `UX-003` | Separate compact Field/Simulation, Recording, Monitoring, and Qualification indicators; versioned reason/action copy | `UX-001`, `REL-010` | Unknown codes fail closed as Needs attention; Simulation is visible on every screen and test export |
| `UX-101` | Refine the existing footer into an incident/status strip with state, affected service, observation, first action, evidence, and recording | `UX-001`, `DET-202` | Operator understands the incident without opening Engineer; content fits at both approved viewports |
| `UX-102` | Automatically surface an affected operational feed and restore the previous wall after clear | `UX-001`, `UX-002` | Every Tier-1 incident shows the correct target without changing pins, subscriptions, or tuner behavior |
| `UX-103` | Make blue/current, green/baseline, and red/anomaly graph semantics server-authoritative | `DET-202` | Learning, missing, or stale data never creates red anomaly segments or a fabricated usual level |
| `UX-104` | Refine incident details: Verdict, Affected, Observed, First action, Coverage, Evidence, Recording, Timeline, Notes, Export | `UX-001`, `EVD-300` | No duplicate severity/evidence labels and no RF-only spoofing, intent, navigation-integrity, or dBm claim |
| `UX-201` | Simplify System Health to overall state and prioritized Needs attention; keep metrics under Engineer details | `HLT-040`, `REC-500`, `BUD-400` | Every active issue appears once with value/limit, last occurrence, and one safe action |
| `UX-202` | Guided self-service for USB, SDRconnect, RF flow, Data late, Recording stopped, Coverage late, overload, learning, and restart | `UX-201`, `REC-500`, `EVD-300` | Each flow shows action, progress, verified success, stop condition, and non-developer escalation boundary |
| `UX-301` | Friendly Signal learning states and separated Clear test data, Restart signal learning, Delete recordings, and Restart software controls | `DOM-030`, `DET-201` | Every action states what changes and what is retained; destructive field actions are scoped, protected, and audited |
| `UX-401` | Finish Settings, keyboard/dialog behavior, screen-reader states, non-colour chart equivalents, 200% zoom, and responsive layouts | Stable UI contracts | No critical control is mouse-only; zero serious/critical axe findings; no overflow at 1920×1080 or 1366×768 |
| `DOC-001` | Version-matched offline in-app help and operator guide organized by real tasks | Stable reason/action codes | Routine recovery requires no Linux command; each procedure includes symptom, action, expected result, stop condition, and escalation boundary |
| `QA-001` | Packaged Playwright, accessibility, state-contract, fault-fixture, polling, and visual-layout suite | All Wave D tasks | Critical flows pass against the built package with no console errors, request growth, stale Normal, or field/test confusion |

**Wave D exit:** a representative non-developer can understand and respond to every normal, alert, recovery, data, receiver, recording, learning, and simulation state.

### Wave E — Reproducible deployment and unattended operations

| ID | Deliverable | Depends on | Evidence of completion |
|---|---|---|---|
| `DEP-600` | Locked dependency release, SBOM/audit, immutable versioned directories, atomic active symlink, health-gated activation/rollback, loaded-unit verification, TLS/firewall/Nginx/clock/disk preflight | `REL-010`, `REC-500`, `EVD-310` | Fresh install, reinstall, upgrade, failed upgrade, and rollback pass; ports 5454 and 8080 are unreachable from a LAN machine |
| `OPS-700` | External uptime probe, backup age, restore status, clock sync, certificate expiry, disk reserve/health, restart count, recovery lockout, and bounded redacted support bundle | `DEP-600`, `HLT-040` | Every blocking condition creates one actionable diagnostic and remains visible until reviewed or a new clean epoch qualifies |
| `OPS-710` | Daily readiness archive; weekly evidence/backup verification; monthly recovery and restore drill; change-triggered recommissioning | `OPS-700` | Scheduled tasks produce bounded, hashed records and missed tasks create Attention rather than silently disappearing |

**Wave E exit:** the exact installed package is traceable, independently supervised, safely replaceable, backed up, and recoverable without changing or losing evidence.

## 7. Operator Recovery Contract

| User sees | First safe action | Verified success | Stop or escalation boundary |
|---|---|---|---|
| Receiver offline — USB not found | Check power/USB, then Retry receiver | USB, SDRconnect, and fresh RF data become Live | Hardware remains absent after reconnect and one retry |
| Receiver offline — SDRconnect | Retry receiver | A fresh epoch-confirmed RF frame arrives | Recovery fails or enters cooldown/lockout |
| Data late | Check browser/network, then Reload connection | Server/client freshness returns | Other browsers are also late or self-check reports server failure |
| Recording stopped | Open Recording and follow the disk/writer action | A new evidence frame is confirmed committed | Disk below reserve, read-only, lost mount, or persistent writer failure |
| Coverage late | Stop optional focus or radio survey | Tier-1 objective returns on time | Primary monitoring continues to miss objectives |
| Receiver overloaded | Check approved antenna/gain configuration and keep recording | Valid observations resume without overload | Configuration must change or overload persists |
| Signal learning paused | Resolve the named data/configuration issue | Representative-time progress resumes | Fingerprint changed and Restart signal learning is required |
| Software not responding | Protected Restart RF Monitor | Service reconnects, fresh frames return, and recording is confirmed | Restart fails, loops, or evidence cannot finalize |

The normal UI does not expose raw service commands. Protected recovery actions call bounded service-controller helpers and report verified outcomes.

## 8. Verification and Qualification Ladder

Passing one level never qualifies the next. Freeze the release candidate before physical testing. Any change repeats the affected gates.

| Gate | Purpose | Minimum pass criteria | Required evidence |
|---|---|---|---|
| `V0` Claims and traceability | Map every release requirement to a test | No untested requirement or unsupported RF claim | Scope, requirement/test matrix, hardware assumptions, risk register |
| `V1` Unit/static | Prove bounded algorithms and invariants | TypeScript, all tests, build, Sites package, config validation, dependency audit and SBOM pass; no skipped release tests | Logs, test report, source/package hashes, Node/OS versions |
| `V2` Packaged integration | Test the built server at real protocol/storage boundaries | Zero old-frequency attribution, unknown-as-clean, simulation contamination, or breached resource limit | Protocol/fault report, evidence verifier output, resource traces |
| `V3` Browser/operator | Test the packaged user workflows | No stale Normal, field/test confusion, overflow, serious accessibility issue, console error, or polling growth | Playwright/axe report, screenshots, console/network logs |
| `V4` Isolated synthetic | Exercise all Tier-1 paths through scheduler, detector, recovery, evidence, and UI | Mandatory deterministic cases pass; gaps/config changes Unknown; matched-power neutral; no field mutation | Scenarios, seeds, truth commitments, rule/config hashes, per-run results |
| `V5` Held-out live-data replay | Test independently captured real receiver distributions with frozen rules | Predeclared tested-envelope and nuisance-alert criteria pass without tuning on holdout; synthetic/test-domain input is rejected | Corpus provenance/hashes, receiver-capture provenance, frozen rule hash, per-session scores and confidence intervals |
| `V6` Installed live RF chain | Characterize the physical receiver, SDRconnect, antenna/filter/LNA/gain chain | Correct target/range, tested detection envelope, overload separation, guard rejection, no unexplained sham alert; simulation is rejected | Chain diagram, device IDs, equipment/calibration record, raw tables, evidence hashes |
| `V7` Live 24-hour timing/learning | Prove real single-tuner coverage, resource behavior, evidence continuity, and baseline eligibility | Live field-domain receiver data for the full bounded run; at least 99.9% Tier-1 revisit conformance, zero optional misses, zero stale attribution/evidence loss, 24 representative healthy hours | Health JSONL, live receiver identity, distributions, miss ledger, clock state, fingerprint/baseline/resource report |

`V7` closes the required development ladder. RSPdx and RSPdx R2 require separate `V6` and `V7` results and separate baseline fingerprints.

### Synthetic statistical protocol

- Keep deterministic regression cases, then run blinded randomized trials across every Tier-1 target.
- Use at least 400 independent seeds per event-family/target combination for high-margin must-detect and negative-control cases.
- Score independent runs, never adjacent frames.
- Report one-sided 95% confidence limits per target and scenario family.
- Separate end-to-end performance, conditional detector performance after sufficient observations, and events never observed by the tuner.
- Treat threshold-edge sweeps as characterization, not relabelled pass cases.
- Any threshold change after viewing holdout results creates a new detector version and requires a new holdout set.
- Synthetic success is software evidence only.

### Mandatory fault matrix

- USB removal.
- SDRconnect stop, crash, hang, initialization failure, and start-limit lockout.
- RF Monitor crash and event-loop hang.
- Tune timeout, delayed/mismatched confirmation, stale frame, and rate/gain/configuration change.
- Browser/network interruption, slow clients, eight clients, and rejected ninth client.
- Disk reserve, full disk, read-only filesystem, lost mount, torn write, and sudden power loss.
- Wall-clock jump and NTP loss while monotonic scheduling continues.
- Corrupt configuration, baseline, index, and evidence tail.
- CPU, RSS, heap, external-buffer, event-loop, writer-queue, and export pressure.
- NIC/switch errors, drops, discards, pause frames, and link reset.
- Upgrade failure, rollback, backup failure, and bare-host restore.

A fault test and a clean observation are separate. A qualification fault during `V7` preserves evidence but restarts `V7` after remediation on a new release candidate. The development goal stops at `V7`.

## 9. Operator Acceptance

Use at least five representative operators who are not developers and do not require RF expertise. No developer guides scored tasks.

- At least 90% identify the affected service/frequency within 15 seconds.
- At least 90% state the correct first action within 30 seconds.
- 100% distinguish Simulation/Test from field monitoring.
- 100% distinguish missing data from Normal.
- Zero participants interpret the software as proof of spoofing, deliberate jamming, or navigation error.
- At least 90% recover a reconnectable receiver within three minutes without a terminal.
- At least 90% distinguish receiver failure, browser Data late, recording failure, and coverage lateness.
- At least 90% find Signal learning state and remaining requirement within 30 seconds.
- 100% clear test data without selecting a field-data action.
- At least 90% download incident evidence and redacted diagnostics without assistance.
- Keyboard-only users complete monitoring, alert response, health, Retry, notes, export, and Settings flows.
- No contradictory status or timestamp appears during the bounded operator test.

## 10. Qualification Artifact

Every development candidate produces one immutable qualification bundle containing:

- release, source, package, dependency-lock, configuration, catalog, detector, baseline, and scenario hashes;
- requirement-to-test traceability;
- commands, output, exit status, OS, Node, SDRconnect, and receiver identity;
- unit, integration, browser, accessibility, synthetic, replay, and installed-chain reports;
- the bounded V7 health series plus derived distributions;
- complete miss, loss, gap, fault, restart, and outage ledgers;
- managed-switch before/after counters;
- evidence verification, export reconstruction, backup, and restore results;
- operator task results;
- SBOM and production dependency audit;
- known limitations, approved deviations, rollback-package hash, and approvals.

Reports are generated mechanically from captured data. A stale validation report is replaced by a new immutable release record, never edited after the fact.

## 11. Release Governance

Required development states are:

`Development → Software qualified → Lab qualified → Installed-chain qualified → Development complete`

Development approval requires the release owner, verifier/RF engineer, operator representative, and site owner. Where staffing is limited, at least one person other than the implementer witnesses `V6`–`V7` and verifies artifact hashes.

### Change invalidation

| Change | Required development gates repeated |
|---|---|
| UI-only | `V1`, `V3` |
| Detector, rules, or preprocessing | `V1`, `V4`, `V5`, `V6`; baselines stale |
| Scheduler or SDRconnect protocol | `V1`, `V2`, `V7` |
| Evidence, storage, or export | `V1`, relevant `V2` faults, restore test |
| Receiver, antenna, filter, cable, LNA/gain, sample rate, grid, mask, or SDRconnect version | `V6`, `V7`; rebuild baselines |
| Node, kernel, systemd, Nginx, firewall, TLS, or storage mount | Deployment integration and recovery/security tests |
| Fix during a timed gate | Freeze a new candidate and restart the affected gate |

Noncritical deviations require an owner, rationale, operational mitigation, expiry, and retest date. The prohibited-waiver conditions in section 3 cannot be accepted as deviations.

## 12. Immediate Implementation Batch

Start with this batch and do not begin later-wave polish until its exit test passes:

1. `SCP-000` — convert this approved scope into shared invariants and claim tests.
2. `REL-010` — make the deployed package and browser build visible and comparable.
3. `DOM-020` — create field/test domains and quarantine known simulation-created learning records.
4. `DOM-030` — implement safe Clear test data and atomic Restart signal learning.
5. `HLT-040` — split Monitoring now from Production qualification everywhere, including doctor.
6. `REC-500` first slice — repair and test the recovery timer and structured Retry result.
7. `UX-001`–`UX-003` — consume the canonical state without changing the selected dashboard layout.
8. `QA-001` first slice — add state truth-table, contamination, restart, timer, stale-client, and timestamp replay tests.

Immediate-batch exit requires:

- no UI, API, or CLI path can call the installation Production ready;
- simulation/test activity makes zero field-tree mutations;
- Restart signal learning removes all active detector readiness and returns the target to Checking;
- the recovery timer is enabled, active, has a next run, and returns a verified Retry outcome;
- server and browser build identities match or the browser requires reload;
- header, feed card, pinned shelf, footer, and incident use one state and timestamp source;
- all automated tests and the production build pass;
- a new immutable validation record is generated with the correct test count and hashes.

After this batch passes, continue in dependency order through Waves B–E, freeze the release candidate, and execute the eligible `V0` through `V7` development gates without skipping levels. Development is complete when those required gates pass.

## 13. Existing Detailed Procedures

- [Validation and assurance](validation-and-assurance.md)
- [Fast-GNSS commissioning and resource acceptance](fast-gnss-commissioning.md)
- [Hardware validation](hardware-validation.md)
- [Installation and configuration](installation-and-configuration.md)
- [Operations](operations.md)
- [Troubleshooting](troubleshooting.md)
- [Security, backup, and recovery](security-backup-recovery.md)
