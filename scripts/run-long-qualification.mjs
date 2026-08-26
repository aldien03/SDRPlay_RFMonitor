#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  CHUNK_MAX_BYTES,
  EVENT_MAX_BYTES,
  GATE_POLICY,
  MAX_SAMPLES,
  MAX_TOTAL_SAMPLE_BYTES,
  MAX_SAMPLE_GAP_MS,
  QualificationRunStore,
  RECORD_MAX_BYTES,
  SAMPLE_INTERVAL_MS,
  analyzeLongQualification,
  assertV7PhysicalSnapshot,
  assertQualificationSampleProgress,
  buildLongQualificationFailure,
  collectorBootIdentity,
  identityDigest,
  loadJsonInput,
  projectHealthSnapshot,
  validateQualificationBinding,
  validateV7BackupRestore,
  validateV7FaultRecoveryMatrix,
  validateV7LoadExercise,
  validateV7Prerequisites,
  validateV7SwitchCounters,
  witnessPublicKeyDigest,
} from "./lib/long-qualification.mjs";
import { verifyHashedEnvelope } from "../deploy/ops-supervisor.mjs";

const SYSTEM_NODE = "/usr/bin/node";
const MAX_HEALTH_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 4_000;

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function value(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name}-required`);
    return undefined;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name}-value-required`);
  return next;
}

function absolute(name) {
  const result = value(name);
  assertion(path.isAbsolute(result), `${name}-must-be-absolute`);
  return path.resolve(result);
}

function healthUrl() {
  const parsed = new URL(value("--health-url", false) ?? "http://127.0.0.1:8080/api/health");
  assertion(["http:", "https:"].includes(parsed.protocol), "health-url-protocol-invalid");
  assertion(["127.0.0.1", "::1", "localhost"].includes(parsed.hostname), "health-url-must-be-loopback");
  assertion(parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "", "health-url-credentials-or-query-refused");
  assertion(parsed.pathname === "/api/health", "health-url-path-invalid");
  return parsed.toString();
}

function opsStatusPath() {
  const candidate = value("--ops-status-file", false) ?? "/var/lib/rf-monitor-ops/status.json";
  assertion(path.isAbsolute(candidate), "ops-status-file-must-be-absolute");
  return path.resolve(candidate);
}

function usage() {
  process.stdout.write([
    "RF Monitor bounded V7 installed-chain qualification",
    "",
    "Commands:",
    "  npm run validate:v7 -- init --run-dir ABS --binding ABS --prerequisites ABS --prerequisite-evidence-root ABS --fault-matrix ABS --fault-evidence-root ABS --backup-restore ABS --backup-evidence-root ABS --witness-public-key ABS [--health-url LOOPBACK_URL] [--ops-status-file ABS]",
    "  npm run validate:v7 -- collect --run-dir ABS [--health-url LOOPBACK_URL] [--ops-status-file ABS]",
    "  npm run validate:v7 -- status --run-dir ABS",
    "  npm run validate:v7 -- finalize --run-dir ABS --switch-counters ABS --switch-evidence-root ABS --load-exercise ABS --load-evidence-root ABS",
    "",
    "V7 is the final required development gate. It cannot exceed 24 server-timestamped hours.",
    "Simulation, replay, test-domain data, and a non-live receiver path are refused.",
  ].join("\n") + "\n");
}

async function fetchHealth(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  assertion(response.ok, `health-http-${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  assertion(!declared || declared <= MAX_HEALTH_BYTES, "health-response-too-large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertion(bytes.byteLength <= MAX_HEALTH_BYTES, "health-response-too-large");
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readOpsStatus(filePath, serverGeneratedAt) {
  const status = await loadJsonInput(filePath);
  assertion(verifyHashedEnvelope(status), "ops-supervisor-status-invalid");
  assertion(status.kind === "probe" || status.kind === "daily", "ops-supervisor-probe-or-daily-required");
  const checks = status.payload?.checks;
  assertion(checks && typeof checks === "object", "ops-supervisor-checks-required");
  assertion(Math.abs(Date.parse(serverGeneratedAt) - Date.parse(status.generatedAt)) <= 120_000, "ops-supervisor-status-stale");
  return {
    verified: true,
    generatedAt: status.generatedAt,
    recordSha256: status.recordSha256,
    clockSynchronized: checks.clockSynchronized === true,
    serviceActive: checks.serviceActive === true,
    serviceRestarts: Number(checks.restartCount),
  };
}

async function readPublicKey(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    assertion(details.isFile() && details.size > 0 && details.size <= 64 * 1024, "witness-public-key-file-invalid");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function appendEvent(store, event, existingAppender) {
  let appender = existingAppender;
  const required = Buffer.byteLength(`${JSON.stringify(event)}\n`);
  if (!appender || appender.bytes() + required > CHUNK_MAX_BYTES) {
    if (appender) await appender.close();
    appender = await store.createAppender("events");
  }
  assertion(required <= EVENT_MAX_BYTES, "qualification-event-too-large");
  await appender.append(event);
  return appender;
}

async function initialize(gate, store) {
  const binding = validateQualificationBinding(await loadJsonInput(absolute("--binding")));
  const witnessPublicKeyPath = absolute("--witness-public-key");
  const witnessPublicKeyPem = await readPublicKey(witnessPublicKeyPath);
  assertion(witnessPublicKeyDigest(witnessPublicKeyPem) === binding.qualificationWitnessPublicKeySha256, "binding-witness-public-key-mismatch");
  const raw = await fetchHealth(healthUrl());
  const opsStatus = await readOpsStatus(opsStatusPath(), raw.generatedAt);
  // Sequence/time values are throwaway validation fields at init. Collection
  // allocates the first authoritative sample only after the run exists.
  const initialSnapshot = projectHealthSnapshot(raw, binding, {
    sequence: 1,
    collectorBootId: collectorBootIdentity(),
    collectorMonotonicMs: 0,
    capturedAt: new Date().toISOString(),
    opsStatus,
  });
  assertV7PhysicalSnapshot(initialSnapshot);
  const prerequisites = validateV7Prerequisites(await loadJsonInput(absolute("--prerequisites")), binding, witnessPublicKeyPem);
  assertion(Date.parse(prerequisites.completedAt) <= Date.parse(raw.generatedAt), "v7-prerequisites-must-precede-init");
  const faultMatrix = validateV7FaultRecoveryMatrix(await loadJsonInput(absolute("--fault-matrix")), binding, witnessPublicKeyPem);
  assertion(Date.parse(faultMatrix.completedAt) <= Date.parse(raw.generatedAt), "v7-fault-matrix-must-precede-init");
  const backupRestore = validateV7BackupRestore(await loadJsonInput(absolute("--backup-restore")), binding, witnessPublicKeyPem, Date.parse(raw.generatedAt), faultMatrix);
  await store.initialize({ gate, binding });
  await store.installArtifact("witness-public-key", witnessPublicKeyPath, 64 * 1024);
  await store.installInput("prerequisites", prerequisites);
  await store.installCustody("prerequisites", prerequisites, absolute("--prerequisite-evidence-root"));
  await store.installInput("fault-matrix", faultMatrix);
  await store.installCustody("fault-matrix", faultMatrix, absolute("--fault-evidence-root"));
  await store.installInput("backup-restore", backupRestore);
  await store.installCustody("backup-restore", backupRestore, absolute("--backup-evidence-root"));
  process.stdout.write(`INITIALIZED ${store.runDirectory}\n`);
}

function blockingEvent(type, detail = {}) {
  return { schemaVersion: 1, type, severity: "blocking", at: new Date().toISOString(), ...detail };
}

async function collect(gate, store) {
  const { run, binding, checkpoint } = await store.load();
  assertion(run.gate === GATE_POLICY[gate].gate, "qualification-run-gate-mismatch");
  assertion(!checkpoint.finalized, "qualification-run-already-finalized");
  const recovered = await store.readSampleSummary();
  let sampleCount = recovered.samples;
  let firstSample = recovered.first;
  let lastSample = recovered.last;
  let events = await store.readEvents();
  let sampleAppender;
  let eventAppender;
  for (const event of recovered.recoveryEvents) {
    eventAppender = await appendEvent(store, event, eventAppender);
    events.push(event);
  }
  if (events.some((event) => event.severity === "blocking")) {
    if (eventAppender) await eventAppender.close();
    await store.checkpoint({
      samples: sampleCount,
      events: events.length,
      status: "interrupted",
      firstServerGeneratedAt: firstSample?.serverGeneratedAt,
      lastServerGeneratedAt: lastSample?.serverGeneratedAt,
    });
    process.stdout.write(`INTERRUPTED samples=${sampleCount} run=${store.runDirectory}\n`);
    process.exitCode = 1;
    return;
  }
  const collectorBootId = collectorBootIdentity();
  const processMonotonicStart = process.hrtime.bigint();
  let stopping = false;
  let nextAt = Date.now();
  let fetchFailureStartedAt;
  let fetchFailureNoticeOpen = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!stopping) {
      const delay = nextAt - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 1_000)));
      if (Date.now() < nextAt || stopping) continue;
      nextAt += SAMPLE_INTERVAL_MS;
      let raw;
      try {
        raw = await fetchHealth(healthUrl());
        raw.__qualificationOpsStatus = await readOpsStatus(opsStatusPath(), raw.generatedAt);
      } catch (error) {
        fetchFailureStartedAt ??= Date.now();
        if (!fetchFailureNoticeOpen) {
          const notice = { schemaVersion: 1, type: "health-request-failed", severity: "notice", at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
          eventAppender = await appendEvent(store, notice, eventAppender);
          events.push(notice);
          fetchFailureNoticeOpen = true;
        }
        if (Date.now() - fetchFailureStartedAt > MAX_SAMPLE_GAP_MS - SAMPLE_INTERVAL_MS) {
          const event = blockingEvent("health-collection-gap", { message: error instanceof Error ? error.message : String(error), gapMs: Date.now() - fetchFailureStartedAt });
          eventAppender = await appendEvent(store, event, eventAppender);
          events.push(event);
          break;
        }
        continue;
      }
      if (fetchFailureNoticeOpen) {
        const notice = { schemaVersion: 1, type: "health-request-recovered", severity: "notice", at: new Date().toISOString(), gapMs: Date.now() - fetchFailureStartedAt };
        eventAppender = await appendEvent(store, notice, eventAppender);
        events.push(notice);
        fetchFailureNoticeOpen = false;
      }
      fetchFailureStartedAt = undefined;
      let sample;
      const previous = lastSample;
      try {
        sample = projectHealthSnapshot(raw, binding, {
          sequence: sampleCount + 1,
          collectorBootId,
          collectorMonotonicMs: Number(process.hrtime.bigint() - processMonotonicStart) / 1_000_000,
          capturedAt: new Date().toISOString(),
          opsStatus: raw.__qualificationOpsStatus,
        });
        assertV7PhysicalSnapshot(sample);
        if (previous) assertQualificationSampleProgress(previous, sample);
      } catch (error) {
        const event = blockingEvent("health-contract-or-identity-failure", { message: error instanceof Error ? error.message : String(error) });
        eventAppender = await appendEvent(store, event, eventAppender);
        events.push(event);
        break;
      }
      if (previous) {
        const serverGapMs = Date.parse(sample.serverGeneratedAt) - Date.parse(previous.serverGeneratedAt);
        if (serverGapMs <= 0 || serverGapMs > MAX_SAMPLE_GAP_MS) {
          const event = blockingEvent(serverGapMs <= 0 ? "server-clock-backward" : "health-collection-gap", { serverGapMs });
          eventAppender = await appendEvent(store, event, eventAppender);
          events.push(event);
        }
        if (sample.serviceBootId !== previous.serviceBootId || sample.commissioningEpochId !== previous.commissioningEpochId || sample.configurationEpoch !== previous.configurationEpoch) {
          const event = blockingEvent("clean-qualification-epoch-interrupted", {
            priorServiceBootId: previous.serviceBootId,
            serviceBootId: sample.serviceBootId,
            priorCommissioningEpochId: previous.commissioningEpochId,
            commissioningEpochId: sample.commissioningEpochId,
          });
          eventAppender = await appendEvent(store, event, eventAppender);
          events.push(event);
        }
      }
      const sampleLineBytes = Buffer.byteLength(`${JSON.stringify(sample)}\n`);
      assertion(sampleLineBytes <= RECORD_MAX_BYTES, "qualification-sample-too-large");
      if (!sampleAppender || sampleAppender.bytes() + sampleLineBytes > CHUNK_MAX_BYTES) {
        if (sampleAppender) await sampleAppender.close();
        sampleAppender = await store.createAppender("samples");
      }
      await sampleAppender.append(sample);
      firstSample ??= sample;
      lastSample = sample;
      sampleCount += 1;
      await store.checkpoint({ samples: sampleCount, events: events.length, status: events.some((event) => event.severity === "blocking") ? "interrupted" : "collecting", firstServerGeneratedAt: firstSample.serverGeneratedAt, lastServerGeneratedAt: sample.serverGeneratedAt });
      if (events.some((event) => event.severity === "blocking")) break;
      const startedAtMs = Date.parse(firstSample.serverGeneratedAt);
      const elapsedMs = Date.parse(sample.serverGeneratedAt) - startedAtMs;
      const readyAt = startedAtMs + GATE_POLICY[gate].minimumAcceptedElapsedMs;
      if (Date.parse(sample.serverGeneratedAt) >= readyAt || elapsedMs >= GATE_POLICY[gate].maximumElapsedMs) break;
    }
  } finally {
    if (sampleAppender) await sampleAppender.close();
    if (eventAppender) await eventAppender.close();
    const status = events.some((event) => event.severity === "blocking") ? "interrupted" : stopping ? "paused" : "ready-to-finalize";
    await store.checkpoint({ samples: sampleCount, events: events.length, status, firstServerGeneratedAt: firstSample?.serverGeneratedAt, lastServerGeneratedAt: lastSample?.serverGeneratedAt });
  }
  const state = events.some((event) => event.severity === "blocking") ? "INTERRUPTED" : stopping ? "PAUSED" : "READY_TO_FINALIZE";
  process.stdout.write(`${state} samples=${sampleCount} run=${store.runDirectory}\n`);
  if (state === "INTERRUPTED") process.exitCode = 1;
}

async function status(gate, store) {
  const { run, binding, checkpoint } = await store.load();
  assertion(run.gate === GATE_POLICY[gate].gate, "qualification-run-gate-mismatch");
  if (!checkpoint.finalized && checkpoint.status === "collecting") {
    const elapsedMs = checkpoint.firstServerGeneratedAt && checkpoint.lastServerGeneratedAt
      ? Date.parse(checkpoint.lastServerGeneratedAt) - Date.parse(checkpoint.firstServerGeneratedAt)
      : 0;
    process.stdout.write(`COLLECTING_UNVERIFIED gate=${run.gate} samples=${checkpoint.samples ?? 0} elapsedMs=${elapsedMs} requiredMs=${GATE_POLICY[gate].requiredElapsedMs} run=${store.runDirectory}\n`);
    return;
  }
  const summary = await store.readSampleSummary();
  const events = [...await store.readEvents(), ...summary.recoveryEvents];
  const elapsedMs = summary.samples > 1 ? Date.parse(summary.last.serverGeneratedAt) - Date.parse(summary.first.serverGeneratedAt) : 0;
  let state = checkpoint.finalized ? String(checkpoint.status).toUpperCase() : events.some((event) => event.severity === "blocking") ? "INTERRUPTED" : elapsedMs < GATE_POLICY[gate].minimumAcceptedElapsedMs ? "COLLECTING" : "READY_TO_FINALIZE";
  if (elapsedMs >= GATE_POLICY[gate].minimumAcceptedElapsedMs && !checkpoint.finalized) state = "READY_FOR_OFFLINE_ANALYSIS";
  process.stdout.write(`${state} gate=${run.gate} samples=${summary.samples} elapsedMs=${elapsedMs} requiredMs=${GATE_POLICY[gate].requiredElapsedMs} run=${store.runDirectory}\n`);
}

async function finalize(gate, store) {
  const { run, binding, checkpoint } = await store.load();
  assertion(run.gate === GATE_POLICY[gate].gate, "qualification-run-gate-mismatch");
  assertion(!checkpoint.finalized, "qualification-run-already-finalized");
  const harnessStarted = process.memoryUsage();
  const harnessMaxRssBeforeBytes = process.resourceUsage().maxRSS * 1024;
  let samples = [];
  let events = [];
  let inputBytes = 0;
  let analyzerMemory = {};
  let external = {};
  let externalRecords = {};
  let result;
  try {
    const readResult = await store.readSamples();
    samples = readResult.samples;
    inputBytes = readResult.inputBytes;
    analyzerMemory = readResult.analyzerMemory;
    events = [...await store.readEvents(), ...readResult.recoveryEvents];
    const witnessPublicKeyPem = await store.readArtifact("witness-public-key", "utf8");
    const prerequisites = validateV7Prerequisites(await store.loadInstalledInput("prerequisites"), binding, witnessPublicKeyPem);
    await store.verifyCustody("prerequisites", prerequisites);
    const faultMatrix = validateV7FaultRecoveryMatrix(await store.loadInstalledInput("fault-matrix"), binding, witnessPublicKeyPem);
    await store.verifyCustody("fault-matrix", faultMatrix);
    const backupRestore = validateV7BackupRestore(
      await store.loadInstalledInput("backup-restore"),
      binding,
      witnessPublicKeyPem,
      Date.parse(samples[0]?.serverGeneratedAt),
      faultMatrix,
    );
    await store.verifyCustody("backup-restore", backupRestore);
    const runStartMs = Date.parse(samples[0]?.serverGeneratedAt);
    const runEndMs = Date.parse(samples.at(-1)?.serverGeneratedAt);
    const switchCountersInput = await loadJsonInput(absolute("--switch-counters"));
    await store.installInput("switch-counters", switchCountersInput);
    const switchCounters = validateV7SwitchCounters(switchCountersInput, binding, witnessPublicKeyPem, runStartMs, runEndMs);
    await store.installCustody("switch-counters", switchCounters, absolute("--switch-evidence-root"));
    const loadExerciseInput = await loadJsonInput(absolute("--load-exercise"));
    await store.installInput("load-exercise", loadExerciseInput);
    const loadExercise = validateV7LoadExercise(loadExerciseInput, binding, witnessPublicKeyPem, runStartMs, runEndMs);
    await store.installCustody("load-exercise", loadExercise, absolute("--load-evidence-root"));
    external = { prerequisites, faultMatrix, backupRestore, switchCounters, loadExercise, witnessPublicKeyPem };
    externalRecords = { prerequisites, "fault-matrix": faultMatrix, "backup-restore": backupRestore, "switch-counters": switchCounters, "load-exercise": loadExercise };
    result = analyzeLongQualification({ gate, binding, samples, events, external });
    if (result.result === "NOT_READY") throw new Error(`qualification-minimum-not-complete:${result.elapsedMs}/${result.requiredElapsedMs}`);
  } catch (error) {
    result = buildLongQualificationFailure({ gate, binding, samples, events, error });
  }
  const harnessEnded = process.memoryUsage();
  result.qualificationHarness = {
    sampleLimit: MAX_SAMPLES,
    sampleBytesLimit: MAX_TOTAL_SAMPLE_BYTES,
    inputBytes,
    rssBeforeReadBytes: analyzerMemory.rssBeforeReadBytes ?? harnessStarted.rss,
    rssAfterReadBytes: analyzerMemory.rssAfterReadBytes,
    rssAfterAnalysisBytes: harnessEnded.rss,
    heapUsedBeforeReadBytes: analyzerMemory.heapUsedBeforeReadBytes ?? harnessStarted.heapUsed,
    heapUsedAfterReadBytes: analyzerMemory.heapUsedAfterReadBytes,
    heapUsedAfterAnalysisBytes: harnessEnded.heapUsed,
    processMaxRssBeforeBytes: analyzerMemory.processMaxRssBeforeReadBytes ?? harnessMaxRssBeforeBytes,
    processMaxRssAfterBytes: process.resourceUsage().maxRSS * 1024,
  };
  const resultPath = await store.finalize(result, externalRecords);
  process.stdout.write(`${result.result} ${resultPath}\n`);
  if (result.result !== "PASS") process.exitCode = 1;
}

async function main() {
  assertion(process.execPath === SYSTEM_NODE, `qualification-requires-system-node:${SYSTEM_NODE}`);
  const gate = String(process.argv[2] ?? "").toLowerCase();
  const command = String(process.argv[3] ?? "").toLowerCase();
  if (gate !== "v7" || !["init", "collect", "status", "finalize"].includes(command) || process.argv.includes("--help")) {
    usage();
    if (!process.argv.includes("--help")) process.exitCode = 2;
    return;
  }
  const runDirectory = absolute("--run-dir");
  const store = new QualificationRunStore(runDirectory);
  if (command === "init") await initialize(gate, store);
  if (command === "collect") await collect(gate, store);
  if (command === "status") await status(gate, store);
  if (command === "finalize") await finalize(gate, store);
}

main().catch((error) => {
  process.stderr.write(`REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
