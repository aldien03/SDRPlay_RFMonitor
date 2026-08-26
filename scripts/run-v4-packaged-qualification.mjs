#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  RELEASE_PACKAGE_ROOTS,
  RELEASE_SOURCE_ROOTS,
  digestReleaseFiles,
} from "./release-digest-policy.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(SCRIPT_PATH), "..");
const nodeExecutable = "/usr/bin/node";
const serverExecutable = path.join(repositoryRoot, "dist/server-node/index.js");
const verifierExecutable = path.join(repositoryRoot, "dist/server-node/evidence-verifier.js");
const releaseMetadataPath = path.join(repositoryRoot, "dist/release.json");
const clientIndexPath = path.join(repositoryRoot, "dist/client/index.html");
const catalogPath = path.join(repositoryRoot, "config/band-catalog.example.json");
const operationalPath = path.join(repositoryRoot, "config/operational.example.json");
const MAX_CAPTURED_FRAMES = 4_096;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const CASE_TIMEOUT_MS = 135_000;
export const V4_PACKAGED_CASE_MATRIX = Object.freeze([
  { caseId: "wideband-l1", scenarioId: "wideband", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "alert" },
  { caseId: "wideband-l2", scenarioId: "wideband", targetId: "gnss-gps-l2c", expectedOutcome: "alert" },
  { caseId: "wideband-l5", scenarioId: "wideband", targetId: "gnss-l5-e5a-b2a", expectedOutcome: "alert" },
  { caseId: "wideband-g1", scenarioId: "wideband", targetId: "gnss-glonass-g1", expectedOutcome: "alert" },
  { caseId: "matched-power-neutral", scenarioId: "matched-power-spoofing", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "no-alert" },
  { caseId: "configuration-change-unknown", scenarioId: "configuration-change", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "unknown" },
  { caseId: "data-gap-unknown", scenarioId: "data-gap", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "unknown" },
]);
const CASE_MATRIX = V4_PACKAGED_CASE_MATRIX;
const V4_PACKAGED_TARGET_IDS = Object.freeze([...new Set(CASE_MATRIX.map((item) => item.targetId))].sort());
export const V4_DOWNSTREAM_DEVELOPMENT_GATES = Object.freeze({ V5: "not-run", V6: "not-run", V7: "not-run" });

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function sha256Canonical(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function safeTimestamp(value = new Date()) {
  return value.toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
}

function safeId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function validSyntheticMarker(marker) {
  const boundedIdentifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value);
  return marker && typeof marker === "object" && !Array.isArray(marker)
    && marker.synthetic === true
    && boundedIdentifier(marker.runId)
    && boundedIdentifier(marker.scenarioId)
    && boundedIdentifier(marker.scenarioVersion)
    && typeof marker.scenarioHash === "string" && /^[a-f0-9]{64}$/.test(marker.scenarioHash)
    && boundedIdentifier(marker.validationProtocolVersion)
    && boundedIdentifier(marker.generatorVersion);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function appendBounded(current, chunk, maximum = 128 * 1024) {
  const next = `${current}${chunk}`;
  return next.length <= maximum ? next : next.slice(next.length - maximum);
}

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a loopback port");
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitFor(predicate, label, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

async function writeAtomic(filePath, contents, mode = 0o640) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.partial-${process.pid}`;
  const handle = await open(partial, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(partial, filePath);
  const directory = await open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeAtomicJson(filePath, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  assertion(Buffer.byteLength(contents) <= MAX_REPORT_BYTES, `${path.basename(filePath)} exceeded the 2 MiB qualification bound`);
  await writeAtomic(filePath, contents);
}

async function hashTree(root) {
  const digest = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  async function visit(current, relative = "") {
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        digest.update(`missing\0${relative}\0`);
        return;
      }
      throw error;
    }
    entries += 1;
    assertion(entries <= MAX_TREE_ENTRIES, "Qualification tree exceeded its entry bound");
    assertion(!details.isSymbolicLink(), `Qualification tree contains a symlink: ${relative || "."}`);
    if (details.isDirectory()) {
      digest.update(`directory\0${relative}\0`);
      const children = (await readdir(current)).sort();
      for (const child of children) await visit(path.join(current, child), relative ? `${relative}/${child}` : child);
      return;
    }
    assertion(details.isFile(), `Qualification tree contains a non-file entry: ${relative}`);
    bytes += details.size;
    assertion(bytes <= MAX_TREE_BYTES, "Qualification tree exceeded its byte bound");
    const contents = await readFile(current);
    digest.update(`file\0${relative}\0${contents.byteLength}\0`);
    digest.update(contents);
  }
  await visit(root);
  return { sha256: digest.digest("hex"), entries, bytes };
}

function countBufferOccurrences(contents, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= contents.byteLength - needle.byteLength) {
    const found = contents.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.byteLength;
  }
  return count;
}

async function scanSyntheticProvenance(root, runIds) {
  const uniqueRunIds = [...new Set(runIds)].sort();
  const needles = new Map(uniqueRunIds.map((value) => [value, Buffer.from(value)]));
  const counts = new Map(uniqueRunIds.map((value) => [value, 0]));
  const markerNeedle = Buffer.from('"syntheticExercise"');
  let markerOccurrences = 0;
  let filesChecked = 0;
  let bytesChecked = 0;
  async function visit(current) {
    const details = await lstat(current);
    assertion(!details.isSymbolicLink(), "Test-domain evidence contains a symlink");
    if (details.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await visit(path.join(current, name));
      return;
    }
    assertion(details.isFile(), "Test-domain evidence contains a non-file entry");
    filesChecked += 1;
    assertion(filesChecked <= MAX_TREE_ENTRIES, "Synthetic provenance scan exceeded its file bound");
    bytesChecked += details.size;
    assertion(bytesChecked <= MAX_TREE_BYTES, "Synthetic provenance scan exceeded its byte bound");
    const contents = await readFile(current);
    markerOccurrences += countBufferOccurrences(contents, markerNeedle);
    for (const [runId, needle] of needles) counts.set(runId, counts.get(runId) + countBufferOccurrences(contents, needle));
  }
  await visit(root);
  return {
    filesChecked,
    bytesChecked,
    markerOccurrences,
    runIds: uniqueRunIds.map((runId) => ({ runId, occurrences: counts.get(runId) })),
  };
}

async function spawnCapture(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString()); });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function exactReleaseIdentity() {
  for (const required of [nodeExecutable, serverExecutable, verifierExecutable, releaseMetadataPath, clientIndexPath, catalogPath, operationalPath]) {
    const details = await stat(required).catch(() => undefined);
    assertion(details?.isFile(), `Packaged V4 prerequisite is missing: ${required}. Run npm run build first.`);
  }
  assertion(process.execPath === nodeExecutable, `Packaged V4 qualification requires ${nodeExecutable}; current executable is ${process.execPath}`);
  const release = JSON.parse(await readFile(releaseMetadataPath, "utf8"));
  assertion(release.schemaVersion === 1 && release.product === "rf-monitor", "Release metadata schema is invalid");
  const [sourceDigest, packageDigest, dependencyLockDigest] = await Promise.all([
    digestReleaseFiles(repositoryRoot, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(repositoryRoot, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable"),
    digestReleaseFiles(repositoryRoot, ["package-lock.json"], "rf-monitor-lock-unavailable"),
  ]);
  assertion(release.sourceDigest === sourceDigest, "Current source differs from the packaged V4 candidate");
  assertion(release.packageDigest === packageDigest, "Current package differs from the packaged V4 candidate");
  assertion(release.dependencyLockDigest === dependencyLockDigest, "Dependency lock differs from the packaged V4 candidate");
  const clientIndex = await readFile(clientIndexPath, "utf8");
  const clientBuildIds = [...clientIndex.matchAll(/<meta name="rf-monitor-client-build-id" content="([^"]+)"\s*\/?\s*>/g)].map((match) => match[1]);
  assertion(clientBuildIds.length === 1 && clientBuildIds[0] === release.buildId, "Packaged client build identity does not match the V4 release");
  return {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: release.releaseVersion,
    buildId: safeId(release.buildId, "Release build ID"),
    sourceDigest,
    packageDigest,
    dependencyLockDigest,
  };
}

function startMonitor({ sandbox, port }) {
  const child = spawn(nodeExecutable, [serverExecutable], {
    cwd: sandbox,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NODE_OPTIONS: "--max-old-space-size=384",
      RF_MONITOR_SIMULATION: "on",
      RF_MONITOR_SYNTHETIC_EXERCISES: "true",
      RF_MONITOR_HOST: "127.0.0.1",
      RF_MONITOR_PORT: String(port),
      RF_MONITOR_STORAGE: path.join(sandbox, "control"),
      RF_MONITOR_FIELD_DATA_ROOT: path.join(sandbox, "field"),
      RF_MONITOR_TEST_DATA_ROOT: path.join(sandbox, "test"),
      RF_MONITOR_CATALOG_FILE: catalogPath,
      RF_MONITOR_OPERATIONAL_FILE: operationalPath,
      RF_MONITOR_MIN_FREE_BYTES: "0",
      RF_MONITOR_STORAGE_MAX_BYTES: "268435456",
      RF_MONITOR_SESSION_MAX_BYTES: "134217728",
      RF_MONITOR_MAINTENANCE_INTERVAL_MS: "600000",
      RF_MONITOR_RECOVERY_REQUEST: path.join(sandbox, "run", "recover-sdrconnect"),
      RF_MONITOR_APPLICATION_RESTART_REQUEST: path.join(sandbox, "run", "restart-application"),
      RFMON_RECOVERY_STATUS_FILE: path.join(sandbox, "run", "receiver-status.json"),
      RFMON_APPLICATION_RECOVERY_STATUS_FILE: path.join(sandbox, "run", "application-status.json"),
      SDRCONNECT_URL: "ws://127.0.0.1:9/",
      SDRCONNECT_SAMPLE_RATE_HZ: "10000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout = appendBounded(output.stdout, chunk.toString()); });
  child.stderr.on("data", (chunk) => { output.stderr = appendBounded(output.stderr, chunk.toString()); });
  return { child, output };
}

function expectedRuntimeIdentity(release, settingsResponse) {
  const catalog = settingsResponse?.catalog;
  const operational = settingsResponse?.settings;
  assertion(settingsResponse?.configurationHash && catalog?.schemaVersion === 3
    && operational?.schemaVersion === 3 && operational?.detection && typeof operational.detection === "object",
  "Packaged V4 validated runtime configuration is invalid");
  return {
    release,
    clientBuildId: release.buildId,
    configurationSha256: settingsResponse.configurationHash,
    catalogVersion: catalog.catalogVersion,
    catalogSha256: sha256Canonical(catalog),
    detectorRuleSetId: operational.detection.ruleSetId,
    detectorRuleSha256: sha256Canonical(operational.detection),
    expectedSampleRateHz: 10_000_000,
  };
}

async function precommitRuntimeIdentity(release, rawCatalog, rawOperational) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v4-identity-"));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const processState = startMonitor({ sandbox, port });
  try {
    await waitForServer(processState, origin);
    const [health, settings] = await Promise.all([getJson(origin, "/api/health"), getJson(origin, "/api/settings")]);
    const expected = expectedRuntimeIdentity(release, settings);
    const runtime = runtimeIdentityFromHealth(health);
    assertion(sameCanonical(runtime, {
      release: expected.release,
      clientBuildId: expected.clientBuildId,
      configurationSha256: expected.configurationSha256,
      catalogVersion: expected.catalogVersion,
      detectorRuleSetId: expected.detectorRuleSetId,
      expectedSampleRateHz: expected.expectedSampleRateHz,
    }), "Packaged V4 identity preflight did not load the validated configuration");
    assertion(settings.catalog?.catalogVersion === rawCatalog.catalogVersion
      && sha256Canonical({ catalogVersion: settings.catalog.catalogVersion, settings: settings.settings }) === settings.configurationHash
      && sha256Canonical(settings.settings) === sha256Canonical(rawOperational),
    "Packaged V4 identity preflight changed the supplied catalog or operational configuration");
    return expected;
  } finally {
    try {
      await gracefulStop(processState);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
}

function runtimeIdentityFromHealth(health) {
  const identity = health?.identity;
  assertion(identity?.schemaVersion === 1 && identity.release?.integrity === "release-metadata", "Packaged V4 runtime identity is unavailable");
  return {
    release: {
      schemaVersion: 1,
      product: "rf-monitor",
      releaseVersion: identity.release.releaseVersion,
      buildId: identity.release.buildId,
      sourceDigest: identity.release.sourceDigest,
      packageDigest: identity.release.packageDigest,
      dependencyLockDigest: identity.release.dependencyLockDigest,
    },
    clientBuildId: identity.release.clientBuildId,
    configurationSha256: identity.configuration?.configurationHash,
    catalogVersion: identity.configuration?.catalogVersion,
    detectorRuleSetId: identity.configuration?.detectorRuleSetId,
    expectedSampleRateHz: identity.configuration?.expectedSampleRateHz,
  };
}

function validQualificationIdentity(identity) {
  return identity && typeof identity === "object"
    && identity.release?.schemaVersion === 1 && identity.release?.product === "rf-monitor"
    && typeof identity.clientBuildId === "string" && identity.clientBuildId === identity.release.buildId
    && [identity.configurationSha256, identity.catalogSha256, identity.detectorRuleSha256,
      identity.release.sourceDigest, identity.release.packageDigest, identity.release.dependencyLockDigest]
      .every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    && typeof identity.catalogVersion === "string" && identity.catalogVersion.length > 0
    && typeof identity.detectorRuleSetId === "string" && identity.detectorRuleSetId.length > 0
    && identity.expectedSampleRateHz === 10_000_000;
}

async function waitForServer(processState, origin) {
  await waitFor(async () => {
    if (processState.child.exitCode !== null || processState.child.signalCode !== null) {
      throw new Error(`Packaged server exited early: ${processState.output.stderr}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }, "packaged V4 server startup", 30_000, 100);
}

async function getJson(origin, pathname) {
  const response = await fetch(`${origin}${pathname}`, { signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  assertion(response.ok, `${pathname} returned ${response.status}: ${text.slice(0, 512)}`);
  return JSON.parse(text);
}

function decodeSpectrumMetadata(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  assertion(bytes.byteLength >= 6 && bytes.subarray(0, 4).toString("utf8") === "RFM1", "Live stream returned an unsupported binary frame");
  const metadataBytes = bytes.readUInt16BE(4);
  assertion(6 + metadataBytes <= bytes.byteLength, "Live stream returned incomplete spectrum metadata");
  return JSON.parse(bytes.subarray(6, 6 + metadataBytes).toString("utf8"));
}

function emptyCapture(runId) {
  return {
    runId,
    phases: new Set(),
    operatorStates: new Set(),
    affectedTargetIds: new Set(),
    incidentTargetIds: new Set(),
    qualificationStates: new Set(),
    frames: [],
    controls: 0,
    httpControls: 0,
    websocketControls: 0,
    activeFrameStates: 0,
    recoveringFrameStates: 0,
  };
}

class LiveCapture {
  constructor(origin) {
    this.origin = origin;
    this.socket = new WebSocket(origin.replace(/^http/, "ws") + "/live", { headers: { Origin: origin } });
    this.captures = new Map();
    this.protocolErrors = [];
    this.lastControlSequence = 0;
    this.bootstrap = undefined;
    this.socket.on("message", (data, binary) => this.onMessage(data, binary));
  }

  async open() {
    await Promise.race([
      once(this.socket, "open"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Live WebSocket did not open")), 10_000)),
    ]);
    await waitFor(() => this.bootstrap, "live bootstrap", 10_000, 25);
  }

  subscribe(targetIds) {
    this.socket.send(JSON.stringify({
      type: "subscribe",
      protocolVersion: 2,
      rateHz: 2,
      engineer: false,
      visibleTargetIds: targetIds,
      detailTargetIds: targetIds,
      visibleFeedIds: [],
      detailFeedIds: [],
    }));
  }

  begin(runId, initialPlayback) {
    const capture = emptyCapture(runId);
    this.captures.set(runId, capture);
    this.notePlayback(capture, initialPlayback, "http");
    return capture;
  }

  noteSnapshot(capture, snapshot, transport = "http") {
    const playback = snapshot?.syntheticExercise;
    if (!playback || playback.runId !== capture.runId) return;
    this.notePlayback(capture, playback, transport);
    const summary = snapshot.operatorSummary;
    if (!summary) return;
    capture.operatorStates.add(summary.monitoring?.state);
    for (const target of summary.affectedTargets ?? []) capture.affectedTargetIds.add(target.id);
    if (summary.incident?.synthetic) {
      for (const target of summary.affectedTargets ?? []) capture.incidentTargetIds.add(target.id);
    }
    capture.qualificationStates.add(`${summary.productionQualification?.state}:${Boolean(summary.productionQualification?.ready)}`);
  }

  notePlayback(capture, playback, transport) {
    capture.controls += 1;
    if (transport === "http") capture.httpControls += 1;
    else capture.websocketControls += 1;
    if (playback.phase) capture.phases.add(playback.phase);
    capture.finalPlayback = { ...playback };
  }

  onMessage(data, binary) {
    try {
      if (binary) {
        const metadata = decodeSpectrumMetadata(data);
        const marker = metadata.frame?.syntheticExercise;
        if (!marker?.runId) return;
        const capture = this.captures.get(marker.runId);
        if (!capture) return;
        if (capture.frames.length >= MAX_CAPTURED_FRAMES) throw new Error("Live V4 frame capture exceeded its bound");
        capture.frames.push(metadata);
        if (metadata.targetState?.lifecycle === "active") capture.activeFrameStates += 1;
        if (metadata.targetState?.lifecycle === "recovering") capture.recoveringFrameStates += 1;
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type !== "snapshot" && message.type !== "state-delta") return;
      const sequence = Number(message.controlSequence);
      if (!Number.isSafeInteger(sequence) || sequence <= this.lastControlSequence) {
        this.protocolErrors.push(`non-monotonic-control-sequence:${String(message.controlSequence)}`);
      } else this.lastControlSequence = sequence;
      if (message.type === "snapshot" && !this.bootstrap) this.bootstrap = message.payload;
      const runId = message.payload?.syntheticExercise?.runId;
      const capture = runId ? this.captures.get(runId) : undefined;
      if (capture) this.noteSnapshot(capture, message.payload, "websocket");
    } catch (error) {
      this.protocolErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await Promise.race([once(this.socket, "close"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

export function evaluateV4PackagedCase(commitment, capture, expectedCenterHz) {
  const playback = capture.finalPlayback;
  assertion(playback?.runId === capture.runId, `${commitment.caseId} did not preserve its run identity`);
  assertion(playback.targetId === commitment.targetId && playback.centerHz === expectedCenterHz, `${commitment.caseId} returned the wrong physical target`);
  assertion(playback.phase === "complete", `${commitment.caseId} did not complete`);
  assertion(playback.observedOutcome === commitment.expectedOutcome, `${commitment.caseId} expected ${commitment.expectedOutcome}, observed ${playback.observedOutcome ?? "missing"}`);
  assertion(capture.httpControls > 0 && capture.websocketControls > 0, `${commitment.caseId} did not traverse both HTTP and live-control state`);
  assertion(capture.qualificationStates.has("simulation:false"), `${commitment.caseId} did not remain visibly unqualified Simulation/Test`);
  assertion(capture.frames.length > 0, `${commitment.caseId} emitted no UI-facing spectrum frame`);
  const visitIds = new Set();
  const epochTriples = new Set();
  for (const metadata of capture.frames) {
    const frame = metadata.frame;
    assertion(frame?.syntheticExercise?.runId === capture.runId, `${commitment.caseId} frame lost its synthetic provenance`);
    assertion(frame.dataDomain === "test" && frame.source === "simulation", `${commitment.caseId} frame escaped the test domain`);
    assertion(frame.targetId === commitment.targetId, `${commitment.caseId} frame was attributed to ${frame.targetId}`);
    assertion(frame.requestedCenterHz === expectedCenterHz && frame.confirmedCenterHz === expectedCenterHz, `${commitment.caseId} frame has old-frequency attribution`);
    assertion(frame.confirmedSampleRateHz === 10_000_000, `${commitment.caseId} frame has the wrong sample rate`);
    assertion(Number.isSafeInteger(frame.configurationEpoch) && frame.configurationEpoch > 0
      && Number.isSafeInteger(frame.tuneEpoch) && frame.tuneEpoch > 0
      && Number.isSafeInteger(frame.visitEpoch) && frame.visitEpoch > 0
      && typeof frame.visitId === "string" && frame.visitId, `${commitment.caseId} frame lacks immutable scheduler epochs`);
    visitIds.add(frame.visitId);
    epochTriples.add(`${frame.configurationEpoch}:${frame.tuneEpoch}:${frame.visitEpoch}`);
  }
  assertion(visitIds.size >= 2 && epochTriples.size >= 2, `${commitment.caseId} did not traverse repeated scheduled visits`);
  const phases = [...capture.phases];
  const operatorStates = [...capture.operatorStates];
  if (commitment.expectedOutcome === "alert") {
    for (const phase of ["alert", "recovering", "complete"]) assertion(capture.phases.has(phase), `${commitment.caseId} missed ${phase} playback state`);
    assertion(capture.operatorStates.has("alert") && capture.operatorStates.has("recovering"), `${commitment.caseId} missed canonical alert/recovery state`);
    assertion(capture.incidentTargetIds.has(commitment.targetId) && capture.affectedTargetIds.has(commitment.targetId), `${commitment.caseId} canonical incident targeted the wrong feed`);
    assertion(capture.activeFrameStates > 0 && capture.recoveringFrameStates > 0, `${commitment.caseId} graph frames missed alert/recovery state`);
    assertion(playback.verdict === "Suspected RF interference", `${commitment.caseId} returned an unsafe or missed operational verdict`);
  } else {
    assertion(!capture.phases.has("alert") && !capture.phases.has("recovering"), `${commitment.caseId} produced a false alert phase`);
    assertion(!capture.operatorStates.has("alert") && !capture.operatorStates.has("recovering"), `${commitment.caseId} produced a false canonical alert`);
    assertion(capture.activeFrameStates === 0 && capture.recoveringFrameStates === 0 && capture.incidentTargetIds.size === 0, `${commitment.caseId} produced a false incident`);
    if (commitment.expectedOutcome === "unknown") assertion(playback.verdict === "Test inconclusive", `${commitment.caseId} did not fail closed as inconclusive`);
    else assertion(playback.verdict === "No RF change detected", `${commitment.caseId} did not keep the matched-power control neutral`);
  }
  return {
    caseId: commitment.caseId,
    scenarioId: commitment.scenarioId,
    targetId: commitment.targetId,
    runId: capture.runId,
    scenarioVersion: playback.scenarioVersion,
    scenarioHash: playback.scenarioHash,
    expectedOutcome: commitment.expectedOutcome,
    observedOutcome: playback.observedOutcome,
    verdict: playback.verdict,
    phases,
    operatorStates,
    affectedTargetIds: [...capture.affectedTargetIds],
    syntheticFrames: capture.frames.length,
    scheduledVisitsObserved: visitIds.size,
    immutableEpochsObserved: epochTriples.size,
    result: "PASS",
  };
}

export function verifyPersistedFrameAttribution(frames, targetCenters) {
  let oldFrequencyMisattribution = 0;
  let syntheticFramesPersisted = 0;
  const targetIds = new Set();
  const visitIds = new Set();
  const syntheticRunIds = new Set();
  for (const frame of frames) {
    const center = targetCenters.get(frame.targetId);
    if (frame.syntheticExercise !== undefined) {
      assertion(validSyntheticMarker(frame.syntheticExercise), "Persisted V4 evidence contains an invalid synthetic marker");
      assertion(frame.source === "simulation", "Persisted synthetic V4 evidence has a non-simulation source");
      syntheticFramesPersisted += 1;
      syntheticRunIds.add(frame.syntheticExercise.runId);
    }
    if (center === undefined || frame.requestedCenterHz !== center || frame.confirmedCenterHz !== center) oldFrequencyMisattribution += 1;
    assertion(frame.dataDomain === "test", "Persisted V4 evidence escaped the test domain");
    assertion(Number.isSafeInteger(frame.configurationEpoch) && Number.isSafeInteger(frame.tuneEpoch)
      && Number.isSafeInteger(frame.visitEpoch) && typeof frame.visitId === "string" && frame.visitId,
    "Persisted V4 evidence lacks scheduler provenance");
    targetIds.add(frame.targetId);
    visitIds.add(frame.visitId);
  }
  assertion(frames.length > 0, "V4 produced no persisted evidence frames");
  assertion(oldFrequencyMisattribution === 0, `Persisted V4 evidence contains ${oldFrequencyMisattribution} old-frequency attribution(s)`);
  assertion(syntheticFramesPersisted > 0, "V4 produced no isolated synthetic test-evidence frames");
  return {
    framesChecked: frames.length,
    targetIds: [...targetIds].sort(),
    visitsChecked: visitIds.size,
    oldFrequencyMisattribution,
    syntheticFramesPersisted,
    syntheticRunIds: [...syntheticRunIds].sort(),
  };
}

async function runCase(origin, live, commitment, targetCenters) {
  const response = await fetch(`${origin}/api/validation/playback`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId: commitment.scenarioId, targetId: commitment.targetId }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  assertion(response.status === 202, `${commitment.caseId} start returned ${response.status}: ${body.slice(0, 512)}`);
  const started = JSON.parse(body).playback;
  const capture = live.begin(started.runId, started);
  const finalPlayback = await waitFor(async () => {
    const snapshot = await getJson(origin, "/api/snapshot");
    live.noteSnapshot(capture, snapshot, "http");
    const playback = snapshot.syntheticExercise;
    if (playback?.runId !== started.runId) return false;
    return playback.phase === "complete" ? playback : false;
  }, `${commitment.caseId} completion`, CASE_TIMEOUT_MS, 1_000);
  live.notePlayback(capture, finalPlayback, "http");
  await waitFor(() => capture.phases.has("complete") && capture.websocketControls > 0, `${commitment.caseId} live completion`, 5_000, 50);
  assertion(live.protocolErrors.length === 0, `Live protocol error: ${live.protocolErrors[0]}`);
  const result = evaluateV4PackagedCase(commitment, capture, targetCenters.get(commitment.targetId));
  const stop = await fetch(`${origin}/api/validation/playback`, { method: "DELETE", headers: { Origin: origin }, signal: AbortSignal.timeout(5_000) });
  assertion(stop.ok, `${commitment.caseId} cleanup returned ${stop.status}`);
  await waitFor(async () => (await getJson(origin, "/api/validation/playback")).playback === null, `${commitment.caseId} cleanup`, 5_000, 100);
  return result;
}

async function gracefulStop(processState) {
  if (!processState || processState.child.exitCode !== null || processState.child.signalCode !== null) return;
  processState.child.kill("SIGTERM");
  await Promise.race([
    once(processState.child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Packaged V4 server did not stop: ${processState.output.stderr}`)), 35_000)),
  ]);
  assertion(processState.child.exitCode === 0 && processState.child.signalCode === null, `Packaged V4 server exited with ${processState.child.exitCode ?? processState.child.signalCode}`);
}

async function verifierResult(sessionPath) {
  const result = await spawnCapture(nodeExecutable, [verifierExecutable, "--json", sessionPath]);
  assertion(result.signal === null, `Evidence verifier was interrupted for ${path.basename(sessionPath)}`);
  const parsed = JSON.parse(result.stdout);
  const verification = parsed.results?.[0];
  assertion(verification && result.code === (verification.outcome === "PASS" ? 0 : verification.outcome === "INCOMPLETE" ? 2 : 1), "Evidence verifier exit code disagreed with its outcome");
  return { exitCode: result.code, ...verification };
}

async function readJsonlRecords(filePath) {
  let contents = "";
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return contents.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function verifyTestEvidence(evidenceRoot, targetCenters, caseResults) {
  const entries = (await readdir(evidenceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
    .sort((left, right) => left.name.localeCompare(right.name));
  assertion(entries.length > 0, "Packaged V4 run produced no test-domain evidence session");
  const sessions = [];
  const frames = [];
  const events = [];
  const operations = [];
  for (const entry of entries) {
    const sessionPath = path.join(evidenceRoot, entry.name);
    const descriptor = JSON.parse(await readFile(path.join(sessionPath, "session.json"), "utf8"));
    const verification = await verifierResult(sessionPath);
    assertion(descriptor.dataDomain === "test", `${entry.name} escaped the test domain`);
    assertion(descriptor.lifecycle === "Complete" && verification.outcome === "PASS", `${entry.name} was not durably Complete/PASS`);
    frames.push(...(await readJsonlRecords(path.join(sessionPath, "spectrum", "frames.jsonl"))).map((record) => record.frame));
    events.push(...await readJsonlRecords(path.join(sessionPath, "events", "events.jsonl")));
    operations.push(...await readJsonlRecords(path.join(sessionPath, "operations.jsonl")));
    sessions.push({
      sessionId: entry.name,
      lifecycle: descriptor.lifecycle,
      verifierOutcome: verification.outcome,
      manifestSchemaVersion: verification.manifestSchemaVersion,
      filesVerified: verification.filesVerified,
      bytesVerified: verification.bytesVerified,
    });
  }
  const attribution = verifyPersistedFrameAttribution(frames, targetCenters);
  for (const record of [...events, ...operations]) {
    if (record.syntheticExercise === undefined) continue;
    assertion(validSyntheticMarker(record.syntheticExercise), "Persisted V4 event/operation contains an invalid synthetic marker");
    assertion(record.dataDomain === "test", "Persisted V4 event/operation escaped the test domain");
  }
  const syntheticProvenance = caseResults.map((result) => {
    const runFrames = frames.filter((frame) => frame.syntheticExercise?.runId === result.runId);
    const runEvents = events.filter((event) => event.syntheticExercise?.runId === result.runId);
    const runOperations = operations.filter((operation) => operation.syntheticExercise?.runId === result.runId);
    assertion(runFrames.length > 0, `${result.caseId} has no persisted synthetic test frame`);
    assertion(runOperations.length > 0, `${result.caseId} has no persisted synthetic visit record`);
    for (const record of [...runFrames, ...runEvents, ...runOperations]) {
      assertion(record.syntheticExercise.scenarioId === result.scenarioId, `${result.caseId} persisted the wrong scenario provenance`);
    }
    assertion(runFrames.every((frame) => frame.targetId === result.targetId), `${result.caseId} persisted a frame against the wrong target`);
    assertion(runEvents.every((event) => event.targetId === result.targetId
      && typeof event.sessionId === "string" && !event.sessionId.startsWith("synthetic:")), `${result.caseId} persisted an event against a synthetic or wrong session`);
    assertion(runOperations.every((operation) => operation.visit?.targetId === result.targetId), `${result.caseId} persisted a visit against the wrong target`);
    const completedVisits = runOperations.filter((operation) => operation.type === "synthetic-target-visit-completed").length;
    const unknownVisits = runOperations.filter((operation) => operation.type === "synthetic-target-visit-unknown").length;
    if (result.expectedOutcome === "alert") {
      assertion(runEvents.some((event) => event.lifecycle === "active")
        && runEvents.some((event) => event.lifecycle === "cleared"), `${result.caseId} lacks the persisted alert/recovery event lifecycle`);
    } else {
      assertion(runEvents.length === 0, `${result.caseId} persisted a false incident`);
    }
    if (result.expectedOutcome === "unknown") assertion(unknownVisits > 0, `${result.caseId} lacks a persisted Unknown gap`);
    else assertion(completedVisits > 0, `${result.caseId} lacks a persisted completed visit`);
    return {
      caseId: result.caseId,
      runId: result.runId,
      scenarioId: result.scenarioId,
      targetId: result.targetId,
      frames: runFrames.length,
      events: runEvents.length,
      completedVisits,
      unknownVisits,
    };
  });
  return {
    sessions,
    attribution,
    syntheticProvenance,
    recordsChecked: { frames: frames.length, events: events.length, operations: operations.length },
  };
}

async function finalizeBundle(partialPath, finalPath, manifest, report) {
  await writeAtomicJson(path.join(partialPath, "report.json"), report);
  const manifestContents = await readFile(path.join(partialPath, "manifest.json"));
  const reportContents = await readFile(path.join(partialPath, "report.json"));
  const sums = `${sha256(manifestContents)}  manifest.json\n${sha256(reportContents)}  report.json\n`;
  await writeAtomic(path.join(partialPath, "SHA256SUMS"), sums);
  await rename(partialPath, finalPath);
  const directory = await open(path.dirname(finalPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function verifyV4PackagedBundle(bundlePath) {
  const root = path.resolve(bundlePath);
  const rootDetails = await lstat(root);
  assertion(rootDetails.isDirectory() && !rootDetails.isSymbolicLink(), "V4 packaged bundle root is not a regular directory");
  const entries = await readdir(root, { withFileTypes: true });
  const expectedNames = ["SHA256SUMS", "manifest.json", "report.json"];
  assertion(entries.length === expectedNames.length
    && entries.map((entry) => entry.name).sort().every((name, index) => name === expectedNames[index]),
  "V4 packaged bundle contains a missing or unexpected entry");
  for (const entry of entries) assertion(entry.isFile() && !entry.isSymbolicLink(), `V4 packaged bundle entry ${entry.name} is not a regular file`);
  const sums = await readFile(path.join(root, "SHA256SUMS"), "utf8");
  assertion(Buffer.byteLength(sums) <= 1_024 && sums.endsWith("\n"), "V4 packaged SHA256SUMS is invalid");
  const committed = new Map();
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (manifest\.json|report\.json)$/.exec(line);
    assertion(match && !committed.has(match[2]), "V4 packaged SHA256SUMS contains an invalid or duplicate entry");
    committed.set(match[2], match[1]);
  }
  assertion(committed.size === 2, "V4 packaged SHA256SUMS coverage is incomplete");
  const manifestBuffer = await readFile(path.join(root, "manifest.json"));
  const reportBuffer = await readFile(path.join(root, "report.json"));
  assertion(manifestBuffer.byteLength <= MAX_REPORT_BYTES && reportBuffer.byteLength <= MAX_REPORT_BYTES, "V4 packaged bundle JSON exceeds its bound");
  assertion(sha256(manifestBuffer) === committed.get("manifest.json") && sha256(reportBuffer) === committed.get("report.json"), "V4 packaged bundle hash mismatch");
  const manifest = JSON.parse(manifestBuffer.toString("utf8"));
  const report = JSON.parse(reportBuffer.toString("utf8"));
  assertion(manifest.schemaVersion === 1 && manifest.recordType === "rf-monitor-v4-packaged-end-to-end-manifest"
    && manifest.writtenBeforeScenarioExecution === true && manifest.casesHash === sha256Canonical(CASE_MATRIX)
    && Array.isArray(manifest.cases) && manifest.cases.length === CASE_MATRIX.length
    && Array.isArray(manifest.targetIds) && sha256Canonical([...manifest.targetIds].sort()) === sha256Canonical(V4_PACKAGED_TARGET_IDS)
    && validQualificationIdentity(manifest.identity)
    && sha256Canonical(manifest.identity.release) === sha256Canonical(manifest.release)
    && manifest.identity.catalogVersion === manifest.catalogVersion,
  "V4 packaged manifest semantics are invalid");
  assertion(report.schemaVersion === 1 && report.recordType === "rf-monitor-v4-packaged-end-to-end-result"
    && report.campaignId === manifest.campaignId && report.manifestHash === sha256(manifestBuffer)
    && ["passed", "failed"].includes(report.result?.packagedEndToEndSubGate)
    && report.result?.overallV4 === "not-passed" && report.result?.productionReady === false
    && sha256Canonical(report.downstreamGates) === sha256Canonical(V4_DOWNSTREAM_DEVELOPMENT_GATES),
  "V4 packaged report semantics are invalid");
  const expectedCases = manifest.cases.map(({ schemaVersion: _schemaVersion, order: _order, ...item }) => item);
  assertion(sha256Canonical(expectedCases) === sha256Canonical(CASE_MATRIX), "V4 packaged case commitments were changed");
  const subGatePassed = report.result.packagedEndToEndSubGate === "passed";
  if (subGatePassed) {
    assertion(sha256Canonical(report.qualificationIdentity) === sha256Canonical(manifest.identity)
      && report.runtimeIdentity?.unchanged === true
      && report.loadedQualificationIdentity?.unchanged === true
      && sha256Canonical(report.loadedQualificationIdentity.before) === sha256Canonical(manifest.identity)
      && sha256Canonical(report.loadedQualificationIdentity.after) === sha256Canonical(manifest.identity)
      && sha256Canonical(report.runtimeIdentity.before) === sha256Canonical(report.runtimeIdentity.after)
      && sha256Canonical(report.runtimeIdentity.before) === sha256Canonical({
        release: manifest.identity.release,
        clientBuildId: manifest.identity.clientBuildId,
        configurationSha256: manifest.identity.configurationSha256,
        catalogVersion: manifest.identity.catalogVersion,
        detectorRuleSetId: manifest.identity.detectorRuleSetId,
        expectedSampleRateHz: manifest.identity.expectedSampleRateHz,
      }), "V4 packaged passing report lacks the exact runtime configuration binding");
    assertion(report.cases.length === CASE_MATRIX.length && report.cases.every((item, index) => {
      const expected = CASE_MATRIX[index];
      if (item.result !== "PASS" || item.caseId !== expected.caseId || item.scenarioId !== expected.scenarioId
        || item.targetId !== expected.targetId || item.expectedOutcome !== expected.expectedOutcome
        || item.observedOutcome !== expected.expectedOutcome) return false;
      if (expected.expectedOutcome === "alert") {
        return item.verdict === "Suspected RF interference"
          && ["alert", "recovering", "complete"].every((phase) => item.phases.includes(phase))
          && ["alert", "recovering"].every((state) => item.operatorStates.includes(state));
      }
      return !item.phases.includes("alert") && !item.phases.includes("recovering")
        && !item.operatorStates.includes("alert") && !item.operatorStates.includes("recovering")
        && (expected.expectedOutcome === "unknown" ? item.verdict === "Test inconclusive" : item.verdict === "No RF change detected");
    }), "V4 packaged passing report has incomplete or semantically invalid cases");
    const reportedRunIds = report.cases.map((item) => item.runId);
    assertion(reportedRunIds.every((runId) => typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(runId))
      && new Set(reportedRunIds).size === CASE_MATRIX.length, "V4 packaged passing report has invalid or repeated run IDs");
    assertion(report.release?.unchanged === true && report.isolation?.fieldUnchanged === true && report.isolation?.testChanged === true,
      "V4 packaged passing report did not preserve candidate/domain isolation");
    assertion(report.evidence?.attribution?.oldFrequencyMisattribution === 0
      && report.evidence?.attribution?.syntheticFramesPersisted > 0
      && Array.isArray(report.evidence?.attribution?.syntheticRunIds)
      && reportedRunIds.every((runId) => report.evidence.attribution.syntheticRunIds.includes(runId))
      && manifest.targetIds.every((targetId) => report.evidence.attribution.targetIds.includes(targetId))
      && report.evidence?.sessions?.every((session) => session.lifecycle === "Complete" && session.verifierOutcome === "PASS"),
    "V4 packaged passing report has invalid evidence lifecycle or attribution");
    assertion(Array.isArray(report.evidence?.syntheticProvenance)
      && report.evidence.syntheticProvenance.length === CASE_MATRIX.length
      && report.evidence.syntheticProvenance.every((record, index) => record.caseId === CASE_MATRIX[index].caseId
        && record.runId === reportedRunIds[index]
        && record.scenarioId === CASE_MATRIX[index].scenarioId
        && record.targetId === CASE_MATRIX[index].targetId
        && record.frames > 0 && record.completedVisits + record.unknownVisits > 0
        && (CASE_MATRIX[index].expectedOutcome === "alert" ? record.events >= 2 : record.events === 0)
        && (CASE_MATRIX[index].expectedOutcome === "unknown" ? record.unknownVisits > 0 : record.completedVisits > 0)),
    "V4 packaged passing report has incomplete synthetic test-evidence provenance");
    const testPersistence = report.isolation?.syntheticPersistence?.test;
    const fieldPersistence = report.isolation?.syntheticPersistence?.field;
    assertion(testPersistence?.markerOccurrences > 0
      && Array.isArray(testPersistence.runIds)
      && reportedRunIds.every((runId) => testPersistence.runIds.some((entry) => entry.runId === runId && entry.occurrences > 0))
      && fieldPersistence?.markerOccurrences === 0
      && Array.isArray(fieldPersistence.runIds)
      && fieldPersistence.runIds.every((entry) => reportedRunIds.includes(entry.runId) && entry.occurrences === 0),
    "V4 packaged passing report did not prove run IDs exist only under isolated test evidence");
  }
  return { valid: true, campaignId: manifest.campaignId, packagedEndToEndSubGate: report.result.packagedEndToEndSubGate };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run validate:v4:packaged -- [--output-root PATH] [--campaign-id ID] [--keep-temp] [--verify-bundle PATH]\n");
    process.stdout.write("Runs the bounded packaged V4 scheduler/detector/recovery/evidence/live-control sub-gate. Overall V4 remains not passed until the exact-candidate detector campaign is also complete.\n");
    return;
  }
  const verifyBundle = optionValue("--verify-bundle");
  if (verifyBundle) {
    const verification = await verifyV4PackagedBundle(verifyBundle);
    process.stdout.write(`PASS ${JSON.stringify(verification)}\n`);
    return;
  }
  const unknown = process.argv.slice(2).filter((value, index, all) => !["--output-root", "--campaign-id", "--keep-temp", "--verify-bundle"].includes(value)
    && !(["--output-root", "--campaign-id", "--verify-bundle"].includes(all[index - 1])));
  if (unknown.length) throw new Error(`Unknown V4 packaged option ${unknown[0]}`);
  const releaseBefore = await exactReleaseIdentity();
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const operational = JSON.parse(await readFile(operationalPath, "utf8"));
  const qualificationIdentity = await precommitRuntimeIdentity(releaseBefore, catalog, operational);
  const targets = catalog.captureTargets.filter((target) => target.tier === "tier1" && target.defaultEnabled);
  assertion(targets.length === 4, "V4 requires exactly four default Tier-1 physical targets");
  const targetCenters = new Map(targets.map((target) => [target.id, Number(target.centerHz)]));
  assertion(CASE_MATRIX.every((item) => targetCenters.has(item.targetId)), "V4 case matrix is not covered by the active Tier-1 catalog");
  const campaignId = safeId(optionValue("--campaign-id") ?? `${safeTimestamp()}-${releaseBefore.buildId}`, "Campaign ID");
  const outputRoot = path.resolve(optionValue("--output-root") ?? path.join(repositoryRoot, "artifacts/validation/v4-packaged"));
  assertion(outputRoot !== path.parse(outputRoot).root && outputRoot !== repositoryRoot, "V4 output root is too broad");
  await mkdir(outputRoot, { recursive: true });
  const finalPath = path.join(outputRoot, campaignId);
  const partialPath = path.join(outputRoot, `.partial-${campaignId}`);
  assertion(!await stat(finalPath).catch(() => undefined) && !await stat(partialPath).catch(() => undefined), "V4 output campaign already exists");
  await mkdir(partialPath, { mode: 0o750 });
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v4-packaged-"));
  const fieldRoot = path.join(sandbox, "field");
  const testRoot = path.join(sandbox, "test");
  await Promise.all([mkdir(fieldRoot, { recursive: true }), mkdir(testRoot, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(fieldRoot, "qualification-sentinel.txt"), "field-domain-must-remain-byte-identical\n", { flag: "wx", mode: 0o600 }),
    writeFile(path.join(testRoot, "qualification-sentinel.txt"), "test-domain-start\n", { flag: "wx", mode: 0o600 }),
  ]);
  const fieldBefore = await hashTree(fieldRoot);
  const testBefore = await hashTree(testRoot);
  const startedAt = new Date().toISOString();
  let processState;
  let live;
  let healthBefore;
  let healthAfter;
  let loadedIdentityBefore;
  let loadedIdentityAfter;
  let testEvidence;
  let syntheticPersistence;
  let liveProtocolErrors = [];
  let fieldAfter = fieldBefore;
  let testAfter = testBefore;
  let releaseAfter = releaseBefore;
  let failure;
  const cases = [];
  const runIds = [];
  const commitment = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-packaged-end-to-end-manifest",
    campaignId,
    createdAt: startedAt,
    release: releaseBefore,
    identity: qualificationIdentity,
    catalogVersion: catalog.catalogVersion,
    targetIds: targets.map((target) => target.id),
    executionPath: "packaged server -> one-tuner DeadlineScheduler -> immutable tune/visit epochs -> synthetic FFT playback -> DetectionEngine -> recovery -> test evidence lifecycle -> canonical live control",
    cases: CASE_MATRIX.map((item, order) => ({ schemaVersion: 1, order, ...item })),
    casesHash: sha256Canonical(CASE_MATRIX),
    writtenBeforeScenarioExecution: true,
    bounds: { cases: CASE_MATRIX.length, caseTimeoutMs: CASE_TIMEOUT_MS, capturedFrames: MAX_CAPTURED_FRAMES, treeEntries: MAX_TREE_ENTRIES, treeBytes: MAX_TREE_BYTES },
  };
  await writeAtomicJson(path.join(partialPath, "manifest.json"), commitment);
  try {
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    processState = startMonitor({ sandbox, port });
    await waitForServer(processState, origin);
    healthBefore = await getJson(origin, "/api/health");
    const settingsBefore = await getJson(origin, "/api/settings");
    assertion(healthBefore.schemaVersion === 2 && healthBefore.dataDomain?.active === "test", "Packaged V4 server did not enter the test trust domain");
    assertion(healthBefore.identity?.release?.integrity === "release-metadata" && healthBefore.identity.release.buildId === releaseBefore.buildId, "Packaged V4 server identity does not match the release metadata");
    const runtimeBefore = runtimeIdentityFromHealth(healthBefore);
    loadedIdentityBefore = expectedRuntimeIdentity(releaseBefore, settingsBefore);
    assertion(sameCanonical(loadedIdentityBefore, qualificationIdentity), "Packaged V4 server loaded a different catalog, detector, or operational configuration");
    assertion(sameCanonical(runtimeBefore, {
      release: qualificationIdentity.release,
      clientBuildId: qualificationIdentity.clientBuildId,
      configurationSha256: qualificationIdentity.configurationSha256,
      catalogVersion: qualificationIdentity.catalogVersion,
      detectorRuleSetId: qualificationIdentity.detectorRuleSetId,
      expectedSampleRateHz: qualificationIdentity.expectedSampleRateHz,
    }), "Packaged V4 server did not load the precommitted release/configuration/catalog/detector identity");
    assertion(healthBefore.productionReady === false && healthBefore.operatorSummary?.dataMode === "simulation"
      && healthBefore.operatorSummary?.productionQualification?.ready === false, "Simulation was presented as production ready");
    live = new LiveCapture(origin);
    await live.open();
    assertion(live.bootstrap?.dataDomain === "test" && live.bootstrap?.operatorSummary?.dataMode === "simulation", "Live bootstrap did not identify Simulation/Test");
    live.subscribe(targets.map((target) => target.id));
    for (const item of CASE_MATRIX) {
      process.stdout.write(`V4 packaged ${item.caseId} ... `);
      const result = await runCase(origin, live, item, targetCenters);
      cases.push(result);
      runIds.push(result.runId);
      process.stdout.write("PASS\n");
    }
    [healthAfter, loadedIdentityAfter] = await Promise.all([
      getJson(origin, "/api/health"),
      getJson(origin, "/api/settings").then((settings) => expectedRuntimeIdentity(releaseBefore, settings)),
    ]);
    assertion(sameCanonical(loadedIdentityAfter, qualificationIdentity), "Packaged V4 loaded configuration changed during scenario execution");
    const runtimeAfter = runtimeIdentityFromHealth(healthAfter);
    assertion(sameCanonical(runtimeAfter, runtimeBefore), "Packaged V4 runtime identity changed during scenario execution");
    assertion(Number(healthAfter.dataContinuity?.evidenceFramesLost?.total ?? 0) === 0, "Packaged V4 run lost evidence frames");
    assertion(healthAfter.evidence?.healthy === true && healthAfter.evidence?.writerQueueItems <= 64
      && healthAfter.evidence?.writerQueueBytes <= 2 * 1024 * 1024, "Packaged V4 evidence writer breached its bound");
    assertion(healthAfter.network?.queuedBytes <= 256 * 1024, "Packaged V4 live client queue breached 256 KiB");
    assertion(healthAfter.software?.rssBytes < 768 * 1024 * 1024, "Packaged V4 server breached the 768 MiB maximum");
    liveProtocolErrors = [...live.protocolErrors];
    await live.close();
    live = undefined;
    await gracefulStop(processState);
    processState = undefined;
    testEvidence = await verifyTestEvidence(path.join(testRoot, "evidence"), targetCenters, cases);
    assertion(targets.every((target) => testEvidence.attribution.targetIds.includes(target.id)), "Persisted evidence did not traverse every Tier-1 target");
    fieldAfter = await hashTree(fieldRoot);
    testAfter = await hashTree(testRoot);
    assertion(fieldAfter.sha256 === fieldBefore.sha256, "Packaged V4 run mutated the protected field tree");
    assertion(testAfter.sha256 !== testBefore.sha256, "Packaged V4 run produced no isolated test-domain writes");
    syntheticPersistence = {
      test: await scanSyntheticProvenance(testRoot, runIds),
      field: await scanSyntheticProvenance(fieldRoot, runIds),
    };
    assertion(syntheticPersistence.test.markerOccurrences > 0
      && syntheticPersistence.test.runIds.every((entry) => entry.occurrences > 0), "One or more synthetic run IDs are missing from isolated test evidence");
    assertion(syntheticPersistence.field.markerOccurrences === 0
      && syntheticPersistence.field.runIds.every((entry) => entry.occurrences === 0), "Synthetic provenance entered the protected field tree");
    releaseAfter = await exactReleaseIdentity();
    assertion(sha256Canonical(releaseAfter) === sha256Canonical(releaseBefore), "Source/package identity changed during packaged V4 execution");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    process.stdout.write(`FAIL — ${failure}\n`);
  } finally {
    if (live) await live.close().catch(() => undefined);
    if (live) liveProtocolErrors = [...live.protocolErrors];
    if (processState) {
      await gracefulStop(processState).catch((error) => { failure ??= error instanceof Error ? error.message : String(error); });
    }
    fieldAfter = await hashTree(fieldRoot).catch(() => fieldAfter);
    testAfter = await hashTree(testRoot).catch(() => testAfter);
    releaseAfter = await exactReleaseIdentity().catch(() => releaseAfter);
  }
  const subGatePassed = !failure
    && cases.length === CASE_MATRIX.length
    && fieldAfter.sha256 === fieldBefore.sha256
    && testAfter.sha256 !== testBefore.sha256
    && sha256Canonical(releaseAfter) === sha256Canonical(releaseBefore);
  const report = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-packaged-end-to-end-result",
    campaignId,
    startedAt,
    completedAt: new Date().toISOString(),
    manifestHash: sha256(await readFile(path.join(partialPath, "manifest.json"))),
    release: { before: releaseBefore, after: releaseAfter, unchanged: sha256Canonical(releaseAfter) === sha256Canonical(releaseBefore) },
    runtime: { executable: nodeExecutable, server: "dist/server-node/index.js", packaged: true, simulation: true, physicalReceiver: "not-run" },
    qualificationIdentity,
    runtimeIdentity: {
      before: healthBefore ? runtimeIdentityFromHealth(healthBefore) : undefined,
      after: healthAfter ? runtimeIdentityFromHealth(healthAfter) : undefined,
      unchanged: Boolean(healthBefore && healthAfter && sameCanonical(runtimeIdentityFromHealth(healthBefore), runtimeIdentityFromHealth(healthAfter))),
    },
    loadedQualificationIdentity: {
      before: loadedIdentityBefore,
      after: loadedIdentityAfter,
      unchanged: Boolean(loadedIdentityBefore && loadedIdentityAfter && sameCanonical(loadedIdentityBefore, loadedIdentityAfter)),
    },
    cases,
    evidence: testEvidence,
    liveProtocol: { protocolVersion: 2, errors: liveProtocolErrors, canonicalStateExercised: cases.length > 0 },
    resourceSnapshot: healthAfter ? {
      rssBytes: healthAfter.software?.rssBytes,
      writerQueueItems: healthAfter.evidence?.writerQueueItems,
      writerQueueBytes: healthAfter.evidence?.writerQueueBytes,
      liveQueuedBytes: healthAfter.network?.queuedBytes,
      evidenceFramesLost: healthAfter.dataContinuity?.evidenceFramesLost?.total,
    } : undefined,
    isolation: {
      executionDomain: "test",
      fieldBefore,
      fieldAfter,
      fieldUnchanged: fieldAfter.sha256 === fieldBefore.sha256,
      testBefore,
      testAfter,
      testChanged: testAfter.sha256 !== testBefore.sha256,
      syntheticPersistence,
    },
    result: {
      packagedEndToEndSubGate: subGatePassed ? "passed" : "failed",
      overallV4: "not-passed",
      productionReady: false,
    },
    remainingV4Blockers: [
      "Exact-candidate 16,040-case conditional detector statistical sub-gate not combined with this artifact",
    ],
    downstreamGates: V4_DOWNSTREAM_DEVELOPMENT_GATES,
    limitations: [
      "This gate qualifies packaged software behavior with generated normalized FFT input; it does not qualify the installed RSPdx/RSPdx R2, SDRconnect, antenna, RF chain, or site.",
      "Simulation cannot establish sensitivity, calibration, absolute power, spoofing detection, navigation integrity, or deliberate intent.",
      "Overall V4 remains not passed until the exact same packaged candidate also passes the precommitted conditional detector campaign.",
    ],
    ...(failure ? { failure } : {}),
  };
  await finalizeBundle(partialPath, finalPath, commitment, report);
  const bundleVerification = await verifyV4PackagedBundle(finalPath);
  if (!process.argv.includes("--keep-temp")) await rm(sandbox, { recursive: true, force: true });
  else process.stdout.write(`Sandbox retained: ${sandbox}\n`);
  process.stdout.write(`${subGatePassed ? "PASS" : "FAIL"} ${path.join(finalPath, "report.json")}\n`);
  process.stdout.write(`Bundle verification PASS (${bundleVerification.campaignId})\n`);
  process.stdout.write("Overall V4 NOT-PASSED (exact-candidate detector campaign remains separate).\n");
  if (!subGatePassed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) await main();
