# V7 Installed-Chain Development Qualification

V7 is the final development gate. It observes the exact installed candidate for no more than 24 hours and evaluates timing, baselines, evidence continuity, load, memory, CPU, event-loop delay, network counters, writer pressure, storage reserve, and bounded recovery evidence in one result.

Only an immutable `qualification.json` with `gate: "V7"` and `result: "PASS"` is a pass. `INITIALIZED`, `COLLECTING`, `READY_TO_FINALIZE`, healthy live monitoring, and simulation results are not passes.

## Non-negotiable input

V7 accepts only live field data from one physical SDRplay RSPdx or RSPdx R2 on the installed production chain. At initialization and on every sample, the collector verifies:

- field data domain with simulation off;
- the bound supported receiver model and model-plus-hardware-serial identity digest;
- the bound installed-chain, release, package, configuration, catalog, detector, site, and baseline fingerprints;
- SDRplay USB present, SDRconnect connected, and live RF frames flowing;
- confirmed 10 MS/s sample rate;
- synchronized host clock and active operations supervision.

Simulation, replay, synthetic RF, test-domain data, missing hardware identity, stalled frames, and a mismatched sample rate are refused. V5 evidence must be sealed FFT recordings derived from a real receiver; synthetic or test inputs cannot satisfy the V5 prerequisite. V6 must identify the same calibrated physical installed chain.

## Time bound

The server-generated observation objective is 24 hours. The five-second collector stops at the first sample at or after 23:59:45 and never accepts elapsed observation above 24:00:00. The immutable result reports the measured elapsed time. Do not extend or restart the same run to compensate for a failure; preserve it and begin a new run after the cause is fixed.

## Required signed inputs

Prepare these records for the exact candidate. Each is signed by the qualification witness named in the binding, and every referenced evidence file must exist under its stated custody root with the recorded SHA-256 digest.

| Input | When | Schema |
|---|---|---|
| V0–V6 prerequisite set | Before initialization | [`v7-prerequisites-v1.schema.json`](../config/qualification-schemas/v7-prerequisites-v1.schema.json) |
| Fault and recovery matrix | Before initialization | [`v7-fault-recovery-matrix-v1.schema.json`](../config/qualification-schemas/v7-fault-recovery-matrix-v1.schema.json) |
| Off-host backup and restore proof | During the same bounded pre-run fault phase | [`v7-backup-restore-v1.schema.json`](../config/qualification-schemas/v7-backup-restore-v1.schema.json) |
| Managed-switch before/after counters | Bracketing the V7 interval | [`v7-switch-counters-v1.schema.json`](../config/qualification-schemas/v7-switch-counters-v1.schema.json) |
| Eight-dashboard, alert-recording, and 5 MiB/s export exercise | During the V7 interval | [`v7-load-exercise-v1.schema.json`](../config/qualification-schemas/v7-load-exercise-v1.schema.json) |

The pre-run fault matrix must contain every required case and prove bounded receiver detection, recovery start, receiver restoration, visible terminal failures, zero restart loops, and zero evidence-frame loss. The backup must be off-host and independently verified with recovery point age at most one hour. The independently verified restore must complete within four hours and preserve field/test separation and evidence integrity.

## Preflight

Use the system Node runtime and check the runner before creating a run directory:

```bash
cd /opt/rf-monitor/current
/usr/bin/node --version
npm run validate:v7 -- --help
curl --fail --silent http://127.0.0.1:8080/api/health > /tmp/rf-monitor-health.json
```

Expected results:

- Node resolves to `/usr/bin/node` through the packaged script;
- help shows only the V7 runner;
- health returns schema version 2 and names the exact release and physical receiver binding;
- commissioning reports field mode, simulation false, USB present, SDRconnect connected, live frames, and 10 MS/s confirmed.

Stop if any identity, physical-path, clock, storage, evidence, or baseline check is unavailable. Do not substitute simulation or a replay.

Set paths to the exact signed inputs and custody roots:

```bash
RFQ_RUN=/var/lib/rf-monitor-qualification/v7-candidate-1
RFQ_BINDING=/var/lib/rf-monitor-qualification/inputs/site-binding.json
RFQ_PREREQUISITES=/var/lib/rf-monitor-qualification/inputs/v7-prerequisites.signed.json
RFQ_PREREQUISITE_EVIDENCE=/var/lib/rf-monitor-qualification/inputs/v7-prerequisite-evidence
RFQ_FAULTS=/var/lib/rf-monitor-qualification/inputs/v7-fault-recovery-matrix.signed.json
RFQ_FAULT_EVIDENCE=/var/lib/rf-monitor-qualification/inputs/v7-fault-evidence
RFQ_BACKUP=/var/lib/rf-monitor-qualification/inputs/v7-backup-restore.signed.json
RFQ_BACKUP_EVIDENCE=/var/lib/rf-monitor-qualification/inputs/v7-backup-evidence
RFQ_WITNESS_KEY=/var/lib/rf-monitor-qualification/inputs/site-verifier-ed25519-public.pem
```

## Initialize and collect

Capture the managed-switch counters immediately before initialization, then run:

```bash
npm run validate:v7 -- init \
  --run-dir "$RFQ_RUN" \
  --binding "$RFQ_BINDING" \
  --prerequisites "$RFQ_PREREQUISITES" \
  --prerequisite-evidence-root "$RFQ_PREREQUISITE_EVIDENCE" \
  --fault-matrix "$RFQ_FAULTS" \
  --fault-evidence-root "$RFQ_FAULT_EVIDENCE" \
  --backup-restore "$RFQ_BACKUP" \
  --backup-evidence-root "$RFQ_BACKUP_EVIDENCE" \
  --witness-public-key "$RFQ_WITNESS_KEY"

npm run validate:v7 -- collect --run-dir "$RFQ_RUN"
```

Expected initialization result: `INITIALIZED`. Expected collection result after the bounded interval: `READY_TO_FINALIZE`.

During collection, run the witnessed load exercise defined by the V7 schema:

- eight Engineer dashboards connected;
- a ninth dashboard rejected;
- alert evidence recorded at at least 4 Hz;
- one export downloading at exactly 5 MiB/s;
- no alert-evidence loss and clear-frame loss below 0.1%;
- live traffic, total application egress, diagnostic traffic, queues, spectrum rings, waterfalls, bins, chunks, sessions, and export parts within their schema limits.

The same samples must show the eight-dashboard interval and active export. A signed claim without corresponding live samples fails.

If collection is interrupted, inspect the status without changing the run:

```bash
npm run validate:v7 -- status --run-dir "$RFQ_RUN"
```

Preserve any interrupted run. Correct the fault and initialize a new directory for a new candidate run.

## Finalize

Capture managed-switch counters immediately after collection. Create the signed bracketing counter record and signed load record, then run:

```bash
RFQ_SWITCH=/var/lib/rf-monitor-qualification/inputs/v7-switch-counters.signed.json
RFQ_SWITCH_EVIDENCE=/var/lib/rf-monitor-qualification/inputs/v7-switch-evidence
RFQ_LOAD=/var/lib/rf-monitor-qualification/inputs/v7-load-exercise.signed.json
RFQ_LOAD_EVIDENCE=/var/lib/rf-monitor-qualification/inputs/v7-load-evidence

npm run validate:v7 -- finalize \
  --run-dir "$RFQ_RUN" \
  --switch-counters "$RFQ_SWITCH" \
  --switch-evidence-root "$RFQ_SWITCH_EVIDENCE" \
  --load-exercise "$RFQ_LOAD" \
  --load-evidence-root "$RFQ_LOAD_EVIDENCE"
```

Expected successful result: `PASS` followed by the absolute `qualification.json` path. The analyzer is bounded to 20,000 samples and 128 MiB of sample JSONL input.

V7 fails closed for any missing signature or custody file, identity mismatch, non-live receiver state, simulation/test input, incomplete fault case, backup/restore failure, switch error/drop/pause/reset, evidence loss, Tier-1 timing failure, optional work, baseline mismatch, load mismatch, growing queue, disk reserve breach, network counter increase, resource-limit breach, restart, clock regression, or elapsed time above 24 hours.

## Verify and retain

```bash
cd "$RFQ_RUN"
sha256sum qualification.json
grep -E '"gate"|"result"|"elapsedMs"|"findings"' qualification.json
```

Retain the complete run directory, signed inputs, custody copies, switch captures, backup/restore evidence, and witness key with the candidate release. A V7 pass applies only to the exact bound installation. It does not establish absolute RF calibration, navigation integrity, spoofing detection, transmitter identity, deliberate jamming, or intent.
