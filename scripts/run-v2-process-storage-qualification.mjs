#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
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
import { WebSocket, WebSocketServer } from "ws";
import { validateReleasePackage } from "./validate-release-package.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const serverExecutable = path.join(repositoryRoot, "dist/server-node/index.js");
const verifierExecutable = path.join(repositoryRoot, "dist/server-node/evidence-verifier.js");
const credentialExecutable = path.join(repositoryRoot, "dist/server-node/admin-credential.js");
const releaseMetadataPath = path.join(repositoryRoot, "dist/release.json");
const nodeExecutable = "/usr/bin/node";
const cataloguePath = path.join(repositoryRoot, "config/band-catalog.example.json");
const faultAcknowledgement = "v2-qualification-only";
const password = "V2 packaged qualification only";
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_WRITER_ITEMS = 64;
const MAX_WRITER_BYTES = 2 * 1024 * 1024;
const MAX_CLIENT_QUEUE_BYTES = 256 * 1024;
const MAX_RSS_BYTES = 768 * 1024 * 1024;
const MAX_RING_BYTES_ONE_RECEIVER = 1024 * 1024;
const faultPoints = [
  "frame-after-raw-append",
  "frame-after-index-append",
  "rotation-after-finalizing-checkpoint",
  "rotation-after-next-session",
  "finalization-rename",
  "finalization-fsync",
];
const bundleFiles = ["qualification.json", "summary.json"];
const releaseIdentityFields = ["schemaVersion", "product", "releaseVersion", "buildId", "sourceDigest", "packageDigest", "dependencyLockDigest"];
const activeScenarioCleanups = new Set();

export const V2_HELP = `Usage:\n  npm run validate:v2 -- [--output DIRECTORY] [--keep-temp]\n  npm run validate:v2 -- --verify-bundle DIRECTORY\n  npm run validate:v2 -- --help\n\nOptions:\n  --output DIRECTORY       Publish the immutable V2 bundle at DIRECTORY.\n  --keep-temp              Retain isolated test sandboxes after the run.\n  --verify-bundle DIRECTORY  Mechanically verify an existing V2 bundle.\n  -h, --help               Show this help without running qualification.\n`;

export function parseV2Arguments(arguments_) {
  const parsed = { help: false, keepTemp: false, output: undefined, verifyBundle: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      if (parsed.help) throw new Error(`Duplicate argument: ${argument}`);
      parsed.help = true;
      continue;
    }
    if (argument === "--keep-temp") {
      if (parsed.keepTemp) throw new Error("Duplicate argument: --keep-temp");
      parsed.keepTemp = true;
      continue;
    }
    if (argument === "--output" || argument === "--verify-bundle") {
      const field = argument === "--output" ? "output" : "verifyBundle";
      if (parsed[field] !== undefined) throw new Error(`Duplicate argument: ${argument}`);
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
      parsed[field] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (parsed.help && arguments_.length !== 1) throw new Error("--help cannot be combined with other arguments");
  if (parsed.verifyBundle && (parsed.output || parsed.keepTemp)) throw new Error("--verify-bundle cannot be combined with run options");
  return parsed;
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function safeTimestamp(value = new Date()) {
  return value.toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
}

function markerForCenter(centerHz, centers) {
  const index = centers.indexOf(Number(centerHz));
  return index < 0 ? 7 : 31 + index * 37;
}

function appendBounded(current, chunk, maximum = 64 * 1024) {
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

async function waitFor(predicate, label, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

async function hashTree(root) {
  const hash = createHash("sha256");
  async function visit(current, relative = "") {
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update(`missing\0${relative}\0`);
        return;
      }
      throw error;
    }
    if (details.isSymbolicLink()) {
      throw new Error(`Qualification trust-domain tree contains an unsupported symlink: ${relative}`);
    }
    if (details.isDirectory()) {
      hash.update(`directory\0${relative}\0`);
      const entries = (await readdir(current)).sort();
      for (const entry of entries) await visit(path.join(current, entry), relative ? `${relative}/${entry}` : entry);
      return;
    }
    assertion(details.isFile(), `Qualification trust-domain tree contains a non-file entry: ${relative}`);
    const contents = await readFile(current);
    hash.update(`file\0${relative}\0${contents.byteLength}\0`);
    hash.update(contents);
  }
  await visit(root);
  return hash.digest("hex");
}

class FakeSdrconnect {
  constructor(centers) {
    this.centers = centers;
    this.httpServer = createServer();
    this.webSocketServer = new WebSocketServer({ server: this.httpServer, perMessageDeflate: false });
    this.currentCenterHz = centers.at(-1);
    this.sampleRateHz = 10_000_000;
    this.emitting = true;
    this.staleFramesInjected = 0;
    this.differentCenterStaleFramesInjected = 0;
    this.spectrumFramesSent = 0;
    this.connections = 0;
    this.webSocketServer.on("connection", (socket) => this.handleConnection(socket));
  }

  async start() {
    this.httpServer.listen(0, "127.0.0.1");
    await once(this.httpServer, "listening");
    const address = this.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Fake SDRconnect did not bind to loopback");
    this.url = `ws://127.0.0.1:${address.port}/`;
    this.frameTimer = setInterval(() => {
      if (!this.emitting) return;
      for (const socket of this.webSocketServer.clients) this.sendSpectrum(socket, this.currentCenterHz);
    }, 50);
  }

  setEmitting(enabled) {
    this.emitting = enabled;
  }

  propertyValue(property) {
    return ({
      api_version: "1.0.3",
      valid_devices: "RSPdx",
      active_device: "RSPdx",
      device_serial: "V2-PACKAGED-FIXTURE",
      device_center_frequency: String(this.currentCenterHz),
      device_sample_rate: String(this.sampleRateHz),
      started: "true",
      can_control: "true",
      active_antenna: "A",
      lna_state: "0",
      spectrum_ref_level: "0",
      spectrum_base: "0",
      signal_power: "64",
      signal_snr: "0",
      overload: "false",
    })[property] ?? "";
  }

  sendProperty(socket, eventType, property, value = this.propertyValue(property)) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event_type: eventType, property, value: String(value) }));
    }
  }

  sendSpectrum(socket, centerHz) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const marker = markerForCenter(centerHz, this.centers);
    const payload = Buffer.alloc(514, marker);
    payload.writeUInt16LE(3, 0);
    socket.send(payload);
    this.spectrumFramesSent += 1;
  }

  handleConnection(socket) {
    this.connections += 1;
    socket.on("message", (raw, binary) => {
      if (binary) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const property = String(message.property ?? "");
      if (message.event_type === "get_property") {
        this.sendProperty(socket, "get_property_response", property);
        return;
      }
      if (message.event_type === "selected_device") {
        this.sendProperty(socket, "property_changed", "active_device", "RSPdx");
        return;
      }
      if (message.event_type !== "set_property") return;
      if (property === "device_center_frequency") {
        const requestedCenter = Number(message.value);
        const priorCenter = this.currentCenterHz;
        this.sendSpectrum(socket, priorCenter);
        this.staleFramesInjected += 1;
        if (priorCenter !== requestedCenter) this.differentCenterStaleFramesInjected += 1;
        setTimeout(() => {
          this.currentCenterHz = requestedCenter;
          this.sendProperty(socket, "property_changed", property, requestedCenter);
        }, 15);
        return;
      }
      if (property === "device_sample_rate") {
        this.sampleRateHz = Number(message.value);
        this.sendProperty(socket, "property_changed", property, this.sampleRateHz);
      }
    });
  }

  async stop() {
    if (this.frameTimer) clearInterval(this.frameTimer);
    for (const socket of this.webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => this.webSocketServer.close(resolve));
    await new Promise((resolve) => this.httpServer.close(resolve));
  }
}

async function spawnWithInput(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk.toString(), 4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk.toString(), 4 * 1024 * 1024); });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function createAdminCredential() {
  const result = await spawnWithInput(nodeExecutable, [credentialExecutable], { input: `${password}\n` });
  assertion(result.code === 0 && result.signal === null, `Admin credential fixture failed: ${result.stderr}`);
  const credential = JSON.parse(result.stdout);
  assertion(credential.schemaVersion === 1 && credential.algorithm === "scrypt", "Admin credential fixture returned an invalid schema");
  return credential;
}

function startMonitor({ sandbox, port, sdrconnectUrl, faultPoint, armFile, markerFile, adminFile, smallSession }) {
  const child = spawn(nodeExecutable, [serverExecutable], {
    cwd: sandbox,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RF_MONITOR_ALLOW_TEST_PROCESS_FAULTS: faultAcknowledgement,
      RF_MONITOR_TEST_PROCESS_FAULT_POINT: faultPoint,
      RF_MONITOR_TEST_PROCESS_FAULT_ROOT: sandbox,
      RF_MONITOR_TEST_PROCESS_FAULT_ARM_FILE: armFile,
      RF_MONITOR_TEST_PROCESS_FAULT_MARKER_FILE: markerFile,
      RF_MONITOR_SIMULATION: "off",
      RF_MONITOR_HOST: "127.0.0.1",
      RF_MONITOR_PORT: String(port),
      RF_MONITOR_STORAGE: path.join(sandbox, "control"),
      RF_MONITOR_FIELD_DATA_ROOT: path.join(sandbox, "field"),
      RF_MONITOR_TEST_DATA_ROOT: path.join(sandbox, "test"),
      RF_MONITOR_CATALOG_FILE: cataloguePath,
      RF_MONITOR_ADMIN_FILE: adminFile,
      RF_MONITOR_MIN_FREE_BYTES: "0",
      RF_MONITOR_STORAGE_MAX_BYTES: "268435456",
      RF_MONITOR_SESSION_MAX_BYTES: smallSession ? "1" : "134217728",
      RF_MONITOR_MAINTENANCE_INTERVAL_MS: "600000",
      RF_MONITOR_RECOVERY_REQUEST: path.join(sandbox, "run", "recover-sdrconnect"),
      RF_MONITOR_APPLICATION_RESTART_REQUEST: path.join(sandbox, "run", "restart-application"),
      RFMON_RECOVERY_STATUS_FILE: path.join(sandbox, "run", "receiver-status.json"),
      RFMON_APPLICATION_RECOVERY_STATUS_FILE: path.join(sandbox, "run", "application-status.json"),
      SDRCONNECT_URL: sdrconnectUrl,
      SDRCONNECT_TIMEOUT_MS: "1000",
      SDRCONNECT_SAMPLE_RATE_HZ: "10000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout = appendBounded(output.stdout, chunk.toString()); });
  child.stderr.on("data", (chunk) => { output.stderr = appendBounded(output.stderr, chunk.toString()); });
  return { child, output };
}

async function waitForServer(processState, origin) {
  await waitFor(async () => {
    if (processState.child.exitCode !== null || processState.child.signalCode !== null) {
      throw new Error(`server exited early (${processState.child.exitCode ?? processState.child.signalCode}): ${processState.output.stderr}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }, "packaged RF Monitor startup", 20_000, 100);
}

async function healthSnapshot(origin) {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
  const text = await response.text();
  assertion(response.status === 200, `Health API returned ${response.status}`);
  const health = JSON.parse(text);
  assertion(health.schemaVersion === 2, "Health API did not return schemaVersion 2");
  assertion(health.dataDomain?.active === "field", "Packaged V2 fixture did not run in the field trust domain");
  assertion(Buffer.byteLength(text) < MAX_HEALTH_RESPONSE_BYTES, "Health response exceeded 64 KiB");
  assertion(Number(health.evidence?.writerQueueItems) <= MAX_WRITER_ITEMS, "Evidence writer exceeded 64 items");
  assertion(Number(health.evidence?.writerQueueBytes) <= MAX_WRITER_BYTES, "Evidence writer exceeded 2 MiB");
  assertion(Number(health.network?.dashboards) <= 8, "Live dashboard admission exceeded eight clients");
  assertion(Number(health.network?.queuedBytes) <= MAX_CLIENT_QUEUE_BYTES * Math.max(1, Number(health.network?.dashboards ?? 0)), "Live client queue exceeded 256 KiB per dashboard");
  assertion(Number(health.software?.rssBytes) < MAX_RSS_BYTES, "RF Monitor RSS exceeded the 768 MiB hard ceiling");
  assertion(Number(health.evidence?.ringBytes ?? 0) <= MAX_RING_BYTES_ONE_RECEIVER, "One-receiver spectrum ring exceeded its packed bound");
  return { health, bytes: Buffer.byteLength(text) };
}

async function liveFrame(origin) {
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/live", { headers: { Origin: origin } });
  const bootstrapPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Live bootstrap timed out")), 5_000);
    const onMessage = (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (message.type !== "snapshot") return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
  await Promise.race([
    once(socket, "open"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Live WebSocket did not open")), 5_000)),
  ]);
  const bootstrap = await bootstrapPromise;
  const targetId = bootstrap.payload?.monitorTargets?.[0]?.id;
  assertion(typeof targetId === "string" && targetId, "Live bootstrap did not publish a physical target");
  socket.send(JSON.stringify({
    type: "subscribe",
    protocolVersion: 2,
    rateHz: 2,
    engineer: false,
    visibleTargetIds: [targetId],
    detailTargetIds: [targetId],
    visibleFeedIds: [],
    detailFeedIds: [],
  }));
  const frameBytes = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Live spectrum frame timed out")), 12_000);
    const onMessage = (data, binary) => {
      if (!binary) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(data.byteLength);
    };
    socket.on("message", onMessage);
  });
  const duringLiveHealth = await healthSnapshot(origin);
  socket.close();
  await Promise.race([once(socket, "close"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  return {
    targetId,
    frameBytes,
    bootstrapControlSequence: bootstrap.controlSequence,
    healthBytes: duringLiveHealth.bytes,
    resourceSample: {
      writerQueueItems: duringLiveHealth.health.evidence.writerQueueItems,
      writerQueueBytes: duringLiveHealth.health.evidence.writerQueueBytes,
      clientQueuedBytes: duringLiveHealth.health.network.queuedBytes,
      rssBytes: duringLiveHealth.health.software.rssBytes,
      ringBytes: duringLiveHealth.health.evidence.ringBytes ?? 0,
    },
  };
}

async function countIndexedFrames(evidenceRoot) {
  let total = 0;
  let sessions = [];
  try {
    sessions = await readdir(evidenceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of sessions) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    try {
      const contents = await readFile(path.join(evidenceRoot, entry.name, "spectrum", "frames.jsonl"), "utf8");
      total += contents.split("\n").filter((line) => line.trim()).length;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return total;
}

async function waitForIndexedFrames(evidenceRoot, minimum = 1) {
  return waitFor(async () => {
    const count = await countIndexedFrames(evidenceRoot);
    return count >= minimum ? count : 0;
  }, `${minimum} persisted evidence frame(s)`, 15_000, 100);
}

async function applySettings(origin) {
  const unlock = await fetch(`${origin}/api/admin/unlock`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  });
  assertion(unlock.status === 200, `Protected Settings unlock returned ${unlock.status}`);
  const cookie = unlock.headers.get("set-cookie")?.split(";", 1)[0];
  assertion(cookie, "Protected Settings unlock did not return a cookie");
  const settingsResponse = await fetch(`${origin}/api/settings`, { signal: AbortSignal.timeout(3_000) });
  const payload = await settingsResponse.json();
  const settings = payload.settings;
  assertion(Number.isSafeInteger(settings?.revision), "Settings response did not include a revision");
  settings.siteName = `${settings.siteName} V2`;
  return fetch(`${origin}/api/settings`, {
    method: "PUT",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      "x-rf-monitor-csrf": "settings-v1",
    },
    body: JSON.stringify({ expectedRevision: settings.revision, settings }),
  }).catch(() => undefined);
}

async function waitForKilled(child, markerFile) {
  const marker = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(markerFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }, "SIGKILL fault marker", 15_000, 25);
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("Faulted process did not exit")), 5_000))]);
  }
  assertion(child.signalCode === "SIGKILL", `Faulted server exited with ${child.exitCode ?? child.signalCode}, not SIGKILL`);
  return marker;
}

async function gracefulStop(processState) {
  const { child } = processState;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Packaged server did not stop cleanly: ${processState.output.stderr}`)), 30_000)),
  ]);
  assertion(child.exitCode === 0 && child.signalCode === null, `Recovery server did not stop cleanly (${child.exitCode ?? child.signalCode})`);
}

async function forceStop(processState) {
  if (!processState) return;
  const { child } = processState;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

export function createV2SandboxCleanup({ sandbox, keepTemp, stopRuntime }) {
  const resolvedSandbox = path.resolve(sandbox);
  assertion(resolvedSandbox.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), "V2 cleanup refused a sandbox outside the temporary root");
  let cleanupPromise;
  return () => {
    cleanupPromise ??= (async () => {
      await stopRuntime();
      if (!keepTemp) await rm(resolvedSandbox, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
}

async function verifierResult(sessionPath) {
  const first = await spawnWithInput(nodeExecutable, [verifierExecutable, "--json", sessionPath]);
  const second = await spawnWithInput(nodeExecutable, [verifierExecutable, "--json", sessionPath]);
  assertion(first.code === second.code && first.signal === null && second.signal === null, `Evidence verifier was not stable for ${path.basename(sessionPath)}`);
  assertion(first.stdout === second.stdout, `Evidence verifier output was not deterministic for ${path.basename(sessionPath)}`);
  const parsed = JSON.parse(first.stdout);
  const result = parsed.results?.[0];
  assertion(result && ["PASS", "INCOMPLETE", "FAIL"].includes(result.outcome), `Evidence verifier returned an invalid schema for ${path.basename(sessionPath)}`);
  assertion(first.code === (result.outcome === "PASS" ? 0 : result.outcome === "INCOMPLETE" ? 2 : 1), `Evidence verifier exit code disagreed with ${result.outcome}`);
  return { exitCode: first.code, ...result };
}

async function verifySessions(evidenceRoot) {
  const entries = (await readdir(evidenceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
    .sort((left, right) => left.name.localeCompare(right.name));
  assertion(entries.length > 0, "Packaged process produced no evidence sessions");
  const results = [];
  for (const entry of entries) {
    const sessionPath = path.join(evidenceRoot, entry.name);
    const descriptor = JSON.parse(await readFile(path.join(sessionPath, "session.json"), "utf8"));
    const verification = await verifierResult(sessionPath);
    assertion(verification.outcome !== "FAIL", `Recovered evidence failed verification: ${entry.name} (${verification.reasons.join(",")})`);
    assertion(descriptor.dataDomain === "field", `Recovered session escaped the field trust domain: ${entry.name}`);
    if (descriptor.lifecycle === "Complete") {
      assertion(verification.outcome === "PASS", `Session ${entry.name} was falsely labelled Complete`);
    }
    results.push({
      sessionId: entry.name,
      lifecycle: descriptor.lifecycle,
      outcome: verification.outcome,
      reasons: verification.reasons,
      filesVerified: verification.filesVerified,
      bytesVerified: verification.bytesVerified,
      manifestSchemaVersion: verification.manifestSchemaVersion,
    });
  }
  return results;
}

async function inspectCrashState(evidenceRoot, markerSessionId) {
  const entries = (await readdir(evidenceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const states = [];
  for (const entry of entries) {
    const sessionPath = path.join(evidenceRoot, entry.name);
    let descriptor;
    try {
      descriptor = JSON.parse(await readFile(path.join(sessionPath, "session.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const verification = await verifierResult(sessionPath);
    if (descriptor.lifecycle === "Complete") {
      assertion(verification.outcome === "PASS", `Crash state falsely labelled ${entry.name} Complete`);
    }
    states.push({ sessionId: entry.name, lifecycle: descriptor.lifecycle, verifierOutcome: verification.outcome, reasons: verification.reasons });
  }
  assertion(states.some((state) => state.sessionId === markerSessionId), `Fault marker session ${markerSessionId} was absent after SIGKILL`);
  return states;
}

async function verifyFrameProvenance(evidenceRoot, centers, centerByTarget) {
  const mismatches = [];
  let framesChecked = 0;
  const entries = await readdir(evidenceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const sessionPath = path.join(evidenceRoot, entry.name);
    let contents;
    try {
      contents = await readFile(path.join(sessionPath, "spectrum", "frames.jsonl"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const [lineIndex, line] of contents.split("\n").entries()) {
      if (!line.trim()) continue;
      const indexed = JSON.parse(line);
      const frame = indexed.frame;
      const requestedCenterHz = Number(frame.requestedCenterHz);
      const confirmedCenterHz = Number(frame.confirmedCenterHz);
      const targetCenterHz = Number(centerByTarget[frame.targetId]);
      const expectedMarker = markerForCenter(confirmedCenterHz, centers);
      const rawPath = path.join(sessionPath, ...String(indexed.rawFile).split("/"));
      const handle = await open(rawPath, "r");
      const byte = Buffer.alloc(1);
      try {
        const read = await handle.read(byte, 0, 1, Number(indexed.rawOffset));
        assertion(read.bytesRead === 1, `Indexed raw byte is missing in ${entry.name}`);
      } finally {
        await handle.close();
      }
      framesChecked += 1;
      if (
        requestedCenterHz !== confirmedCenterHz
        || !centers.includes(confirmedCenterHz)
        || targetCenterHz !== confirmedCenterHz
        || byte[0] !== expectedMarker
      ) {
        mismatches.push({ sessionId: entry.name, line: lineIndex + 1, targetId: frame.targetId, targetCenterHz, requestedCenterHz, confirmedCenterHz, observedMarker: byte[0], expectedMarker });
      }
    }
  }
  assertion(framesChecked > 0, "No persisted spectrum frame was available for epoch/provenance verification");
  assertion(mismatches.length === 0, `Old-frequency evidence was misattributed: ${JSON.stringify(mismatches.slice(0, 4))}`);
  return { framesChecked, mismatches: mismatches.length };
}

async function runScenario(faultPoint, credential, centers, centerByTarget, keepTemp) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), `rf-monitor-v2-${faultPoint}-`));
  const fieldEvidenceRoot = path.join(sandbox, "field", "evidence");
  const testRoot = path.join(sandbox, "test");
  const armFile = path.join(sandbox, "fault", "armed");
  const markerFile = path.join(sandbox, "fault", "killed.json");
  const adminFile = path.join(sandbox, "config", "admin.json");
  const isRotationFault = faultPoint.startsWith("rotation-");
  const isFinalizationFault = faultPoint.startsWith("finalization-");
  let first;
  let recovery;
  let fake;
  const cleanup = createV2SandboxCleanup({
    sandbox,
    keepTemp,
    stopRuntime: async () => {
      await forceStop(first);
      await forceStop(recovery);
      await fake?.stop().catch(() => undefined);
    },
  });
  activeScenarioCleanups.add(cleanup);
  try {
    await Promise.all([
      mkdir(path.dirname(armFile), { recursive: true }),
      mkdir(path.dirname(adminFile), { recursive: true }),
      mkdir(testRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(adminFile, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 }),
      writeFile(path.join(testRoot, "sentinel.txt"), "test-domain-must-remain-byte-identical\n", { mode: 0o600 }),
    ]);
    const testHashBefore = await hashTree(testRoot);
    fake = new FakeSdrconnect(centers);
    await fake.start();
    fake.setEmitting(!isRotationFault);
    const firstPort = await unusedPort();
    const firstOrigin = `http://127.0.0.1:${firstPort}`;
    first = startMonitor({
      sandbox,
      port: firstPort,
      sdrconnectUrl: fake.url,
      faultPoint,
      armFile,
      markerFile,
      adminFile,
      smallSession: isRotationFault,
    });
    await waitForServer(first, firstOrigin);
    const initialHealth = await healthSnapshot(firstOrigin);
    let initialLive;
    if (!isRotationFault) {
      initialLive = await liveFrame(firstOrigin);
      await waitForIndexedFrames(fieldEvidenceRoot, 1);
    }
    await writeFile(armFile, "armed\n", { flag: "wx", mode: 0o600 });
    if (isRotationFault) {
      void fetch(`${firstOrigin}/api/storage/maintenance`, {
        method: "POST",
        headers: { Origin: firstOrigin, "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    } else if (isFinalizationFault) {
      void applySettings(firstOrigin);
    }
    const marker = await waitForKilled(first.child, markerFile);
    assertion(marker.point === faultPoint, `Fault marker reported ${marker.point}, expected ${faultPoint}`);
    const crashState = await inspectCrashState(fieldEvidenceRoot, marker.sessionId);
    const testHashAfterCrash = await hashTree(testRoot);
    assertion(testHashAfterCrash === testHashBefore, `SIGKILL field process mutated the test trust domain at ${faultPoint}`);

    fake.setEmitting(true);
    const recoveryPort = await unusedPort();
    const recoveryOrigin = `http://127.0.0.1:${recoveryPort}`;
    recovery = startMonitor({
      sandbox,
      port: recoveryPort,
      sdrconnectUrl: fake.url,
      faultPoint,
      armFile: path.join(sandbox, "fault", "not-armed-after-restart"),
      markerFile: path.join(sandbox, "fault", "must-not-kill-after-restart.json"),
      adminFile,
      smallSession: false,
    });
    await waitForServer(recovery, recoveryOrigin);
    const recoveredHealth = await healthSnapshot(recoveryOrigin);
    const recoveredLive = await liveFrame(recoveryOrigin);
    await waitForIndexedFrames(fieldEvidenceRoot, 1);
    await gracefulStop(recovery);
    recovery = undefined;

    const sessions = await verifySessions(fieldEvidenceRoot);
    const provenance = await verifyFrameProvenance(fieldEvidenceRoot, centers, centerByTarget);
    const testHashAfter = await hashTree(testRoot);
    assertion(testHashAfter === testHashBefore, `Field process mutated the test trust domain at ${faultPoint}`);
    assertion(fake.staleFramesInjected > 0, `Fake SDRconnect injected no stale-frequency frames at ${faultPoint}`);
    assertion(fake.differentCenterStaleFramesInjected > 0, `Fake SDRconnect did not exercise a different old tune at ${faultPoint}`);
    const incompleteSessions = sessions.filter((session) => session.outcome === "INCOMPLETE").length;
    if (faultPoint.startsWith("frame-") || faultPoint === "rotation-after-next-session") {
      assertion(incompleteSessions > 0, `Crash point ${faultPoint} did not preserve an explicit incomplete session`);
    }
    return {
      faultPoint,
      result: "PASS",
      processExit: { signal: "SIGKILL", markerSessionId: marker.sessionId },
      httpWebSocket: {
        initialHealthBytes: initialHealth.bytes,
        initialLive: initialLive ?? { deferredUntilRecovery: true },
        recoveredHealthBytes: recoveredHealth.bytes,
        recoveredLive,
      },
      resourceBounds: {
        writerItemsMaximum: Math.max(initialHealth.health.evidence.writerQueueItems, recoveredHealth.health.evidence.writerQueueItems, initialLive?.resourceSample?.writerQueueItems ?? 0, recoveredLive.resourceSample.writerQueueItems),
        writerBytesMaximum: Math.max(initialHealth.health.evidence.writerQueueBytes, recoveredHealth.health.evidence.writerQueueBytes, initialLive?.resourceSample?.writerQueueBytes ?? 0, recoveredLive.resourceSample.writerQueueBytes),
        clientQueuedBytesMaximum: Math.max(initialHealth.health.network.queuedBytes, recoveredHealth.health.network.queuedBytes, initialLive?.resourceSample?.clientQueuedBytes ?? 0, recoveredLive.resourceSample.clientQueuedBytes),
        rssBytesMaximum: Math.max(initialHealth.health.software.rssBytes, recoveredHealth.health.software.rssBytes, initialLive?.resourceSample?.rssBytes ?? 0, recoveredLive.resourceSample.rssBytes),
        ringBytesMaximum: Math.max(initialHealth.health.evidence.ringBytes ?? 0, recoveredHealth.health.evidence.ringBytes ?? 0, initialLive?.resourceSample?.ringBytes ?? 0, recoveredLive.resourceSample.ringBytes),
      },
      evidence: {
        crashState,
        sessions,
        falseComplete: 0,
        incompleteSessions,
        verifierCommand: `${nodeExecutable} dist/server-node/evidence-verifier.js --json SESSION`,
      },
      provenance: {
        ...provenance,
        staleFramesInjected: fake.staleFramesInjected,
      },
      trustDomains: {
        active: "field",
        testTreeSha256Before: testHashBefore,
        testTreeSha256AfterCrash: testHashAfterCrash,
        testTreeSha256AfterRecovery: testHashAfter,
        unchanged: true,
      },
      fakeSdrconnect: {
        connections: fake.connections,
        spectrumFramesSent: fake.spectrumFramesSent,
        staleFramesInjected: fake.staleFramesInjected,
        differentCenterStaleFramesInjected: fake.differentCenterStaleFramesInjected,
      },
      ...(keepTemp ? { sandbox } : {}),
    };
  } finally {
    await cleanup();
    activeScenarioCleanups.delete(cleanup);
  }
}

async function writeExclusive(filePath, value) {
  const handle = await open(filePath, "wx", 0o440);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactReleaseIdentity(value, label = "release") {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid`);
  const observedKeys = Object.keys(value).sort();
  const expectedKeys = [...releaseIdentityFields].sort();
  assertion(observedKeys.length === expectedKeys.length && observedKeys.every((key, index) => key === expectedKeys[index]), `${label} fields are invalid`);
  const identity = {};
  for (const field of releaseIdentityFields) {
    const observed = value?.[field];
    if (field === "schemaVersion") {
      assertion(observed === 1, `${label} schemaVersion is invalid`);
    } else if (field === "product") {
      assertion(observed === "rf-monitor", `${label} product is invalid`);
    } else if (field.endsWith("Digest")) {
      assertion(/^[a-f0-9]{64}$/.test(String(observed ?? "")), `${label} ${field} is invalid`);
    } else {
      assertion(typeof observed === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(observed), `${label} ${field} is invalid`);
    }
    identity[field] = observed;
  }
  return identity;
}

export async function validateV2Candidate({ root = repositoryRoot, validatePackage = validateReleasePackage } = {}) {
  const validated = await validatePackage({ repositoryRoot: root });
  assertion(validated?.valid === true, "V2 release-package validation did not pass");
  return exactReleaseIdentity({
    schemaVersion: 1,
    product: "rf-monitor",
    ...Object.fromEntries(releaseIdentityFields.slice(2).map((field) => [field, validated[field]])),
  }, "validated release");
}

export function assertV2CandidateUnchanged(before, after) {
  const first = exactReleaseIdentity(before, "pre-run release");
  const second = exactReleaseIdentity(after, "post-run release");
  for (const field of releaseIdentityFields) {
    assertion(first[field] === second[field], `V2 candidate changed during qualification: ${field}`);
  }
  return true;
}

function exactBundleEntryName(value) {
  assertion(bundleFiles.includes(value), `V2 checksum lists an unexpected file: ${value}`);
  return value;
}

export async function verifyV2QualificationBundle(bundlePath) {
  const directory = path.resolve(bundlePath);
  const directoryDetails = await lstat(directory);
  assertion(directoryDetails.isDirectory() && !directoryDetails.isSymbolicLink(), "V2 bundle is not a regular directory");
  assertion((directoryDetails.mode & 0o222) === 0, "V2 bundle directory is writable");
  const entries = (await readdir(directory)).sort();
  assertion(JSON.stringify(entries) === JSON.stringify(["SHA256SUMS", ...bundleFiles].sort()), "V2 bundle entries are incomplete or unexpected");

  const contents = {};
  for (const name of [...bundleFiles, "SHA256SUMS"]) {
    const filePath = path.join(directory, name);
    const details = await lstat(filePath);
    assertion(details.isFile() && !details.isSymbolicLink(), `V2 bundle entry is not a regular file: ${name}`);
    assertion((details.mode & 0o222) === 0, `V2 bundle entry is writable: ${name}`);
    assertion(details.size <= (name === "SHA256SUMS" ? 4 * 1024 : 8 * 1024 * 1024), `V2 bundle entry exceeds its bound: ${name}`);
    contents[name] = await readFile(filePath);
  }

  const checksumText = contents.SHA256SUMS.toString("utf8");
  assertion(checksumText.endsWith("\n"), "V2 SHA256SUMS must end with one newline");
  const checksumLines = checksumText.trimEnd().split("\n");
  assertion(checksumLines.length === bundleFiles.length, "V2 SHA256SUMS has the wrong number of entries");
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assertion(match, "V2 SHA256SUMS contains a malformed entry");
    const name = exactBundleEntryName(match[2]);
    assertion(!checksums.has(name), `V2 SHA256SUMS repeats ${name}`);
    checksums.set(name, match[1]);
  }
  for (const name of bundleFiles) {
    assertion(checksums.get(name) === sha256(contents[name]), `V2 checksum mismatch: ${name}`);
  }

  const record = JSON.parse(contents["qualification.json"].toString("utf8"));
  const summary = JSON.parse(contents["summary.json"].toString("utf8"));
  assertion(record.schemaVersion === 1 && record.gate === "V2", "V2 qualification record schema is invalid");
  assertion(["PASS", "FAIL"].includes(record.result), "V2 qualification result is invalid");
  assertion(record.softwareQualificationOnly === true && record.productionQualified === false, "V2 record exceeds software-only scope");
  const release = exactReleaseIdentity(record.release, "V2 record release");
  const before = exactReleaseIdentity(record.candidateIdentity?.before, "V2 pre-run candidate");
  const after = exactReleaseIdentity(record.candidateIdentity?.after, "V2 post-run candidate");
  assertV2CandidateUnchanged(before, after);
  for (const field of releaseIdentityFields) assertion(release[field] === before[field], `V2 record release disagrees with ${field}`);
  assertion(record.candidateIdentity?.unchanged === true, "V2 candidate binding is not fail-closed");
  assertion(Array.isArray(record.scenarios) && record.scenarios.length <= faultPoints.length, "V2 scenario list is invalid");
  for (const [index, scenario] of record.scenarios.entries()) {
    assertion(scenario?.faultPoint === faultPoints[index], `V2 scenario order is invalid at ${index}`);
    assertion(["PASS", "FAIL"].includes(scenario?.result), `V2 scenario result is invalid at ${index}`);
    if (scenario.result === "PASS") {
      assertion(scenario.trustDomains?.active === "field" && scenario.trustDomains?.unchanged === true, `V2 trust-domain evidence is invalid at ${index}`);
    }
  }
  if (record.result === "PASS") {
    assertion(record.scenarios.length === faultPoints.length && record.scenarios.every((scenario) => scenario.result === "PASS"), "V2 PASS does not contain every passing fault point");
  } else {
    assertion(record.scenarios.some((scenario) => scenario.result === "FAIL"), "V2 FAIL has no failed scenario");
  }
  assertion(summary.schemaVersion === 1 && summary.gate === "V2", "V2 summary schema is invalid");
  assertion(summary.result === record.result && summary.buildId === release.buildId, "V2 summary identity disagrees with the record");
  assertion(summary.scenarioCount === record.scenarios.length, "V2 summary scenario count disagrees with the record");
  return { valid: true, gate: "V2", result: record.result, buildId: release.buildId, files: [...bundleFiles] };
}

export async function publishV2QualificationBundle({ outputDirectory, record, summary }) {
  const finalPath = path.resolve(outputDirectory);
  const parent = path.dirname(finalPath);
  const temporaryPath = path.join(parent, `.partial-${path.basename(finalPath)}-${process.pid}-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  await mkdir(temporaryPath, { mode: 0o750 });
  try {
    const serialized = {
      "qualification.json": Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
      "summary.json": Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    };
    for (const name of bundleFiles) await writeExclusive(path.join(temporaryPath, name), serialized[name]);
    const checksumText = `${bundleFiles.map((name) => `${sha256(serialized[name])}  ${name}`).sort().join("\n")}\n`;
    await writeExclusive(path.join(temporaryPath, "SHA256SUMS"), checksumText);
    await chmod(temporaryPath, 0o550);
    await verifyV2QualificationBundle(temporaryPath);
    await rename(temporaryPath, finalPath);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await verifyV2QualificationBundle(finalPath);
    return finalPath;
  } catch (error) {
    await chmod(temporaryPath, 0o750).catch(() => undefined);
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupActiveV2Qualification() {
  await Promise.allSettled([...activeScenarioCleanups].map((cleanup) => cleanup()));
}

function installInterruptionCleanup() {
  let handling = false;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = async () => {
      if (handling) return;
      handling = true;
      await cleanupActiveV2Qualification();
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export async function runV2Qualification(parsedArguments) {
  const releaseBefore = await validateV2Candidate();
  for (const required of [nodeExecutable, serverExecutable, verifierExecutable, credentialExecutable, releaseMetadataPath]) {
    const details = await stat(required).catch(() => undefined);
    assertion(details?.isFile(), `Packaged V2 prerequisite is missing: ${required}. Run npm run build first.`);
  }
  const catalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
  const tierOneTargets = catalogue.captureTargets
    .filter((target) => target.tier === "tier1" && target.defaultEnabled);
  const centers = tierOneTargets.map((target) => Number(target.centerHz));
  const centerByTarget = Object.fromEntries(tierOneTargets.map((target) => [target.id, Number(target.centerHz)]));
  assertion(centers.length === 4 && centers.every(Number.isFinite), "Tier-1 catalogue did not expose the expected four physical centers");
  const credential = await createAdminCredential();
  const keepTemp = parsedArguments.keepTemp;
  const outputDirectory = path.resolve(parsedArguments.output ?? path.join(
    repositoryRoot,
    "artifacts/validation/v2",
    `${safeTimestamp()}-${releaseBefore.buildId}`,
  ));
  const startedAt = new Date().toISOString();
  const scenarios = [];
  let failed;
  for (const faultPoint of faultPoints) {
    process.stdout.write(`V2 ${faultPoint} ... `);
    try {
      const result = await runScenario(faultPoint, credential, centers, centerByTarget, keepTemp);
      scenarios.push(result);
      process.stdout.write("PASS\n");
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
      scenarios.push({ faultPoint, result: "FAIL", error: failed.slice(0, 2_048) });
      process.stdout.write(`FAIL — ${failed}\n`);
      break;
    }
  }
  const releaseAfter = await validateV2Candidate();
  assertV2CandidateUnchanged(releaseBefore, releaseAfter);
  const record = {
    schemaVersion: 1,
    gate: "V2",
    qualification: "packaged-process-and-storage-boundaries",
    result: failed ? "FAIL" : "PASS",
    softwareQualificationOnly: true,
    productionQualified: false,
    startedAt,
    completedAt: new Date().toISOString(),
    release: releaseAfter,
    candidateIdentity: {
      before: releaseBefore,
      after: releaseAfter,
      unchanged: true,
    },
    runtime: {
      node: nodeExecutable,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      server: "dist/server-node/index.js",
      fakeSdrconnect: "loopback WebSocket fixture",
      temporaryFilesystem: true,
    },
    commands: [
      "npm run build",
      "npm run validate:v2",
      `${nodeExecutable} dist/server-node/evidence-verifier.js --json SESSION`,
    ],
    assertions: {
      realHttpAndWebSocket: true,
      sigkillBoundaries: faultPoints,
      noFalseComplete: true,
      deterministicOfflineVerifier: true,
      fieldTestSeparation: true,
      oldFrequencyMisattribution: 0,
      resourceBounds: {
        healthResponseBytes: MAX_HEALTH_RESPONSE_BYTES,
        writerItems: MAX_WRITER_ITEMS,
        writerBytes: MAX_WRITER_BYTES,
        clientQueueBytes: MAX_CLIENT_QUEUE_BYTES,
        rssBytes: MAX_RSS_BYTES,
        oneReceiverRingBytes: MAX_RING_BYTES_ONE_RECEIVER,
      },
    },
    scenarios,
    limitations: [
      "This is bounded packaged software qualification, not a physical power-loss or installed RF-chain test.",
      "V5-V7 remain separate held-out, calibrated, and bounded installed qualification gates.",
    ],
    ...(failed ? { failure: failed } : {}),
  };
  const summary = {
    schemaVersion: 1,
    gate: record.gate,
    result: record.result,
    buildId: record.release.buildId,
    scenarioCount: scenarios.length,
    output: path.relative(repositoryRoot, outputDirectory),
  };
  await publishV2QualificationBundle({ outputDirectory, record, summary });
  process.stdout.write(`${record.result} ${path.join(outputDirectory, "qualification.json")}\n`);
  if (failed) process.exitCode = 1;
  return { outputDirectory, record, summary };
}

async function main(arguments_) {
  const parsed = parseV2Arguments(arguments_);
  if (parsed.help) {
    process.stdout.write(V2_HELP);
    return;
  }
  if (parsed.verifyBundle) {
    const result = await verifyV2QualificationBundle(parsed.verifyBundle);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const uninstall = installInterruptionCleanup();
  try {
    await runV2Qualification(parsed);
  } finally {
    uninstall();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
