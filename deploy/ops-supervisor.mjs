#!/usr/bin/env node
import { createHash, X509Certificate } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

export const OPS_SCHEMA_VERSION = 1;
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_HEALTH_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
export const MAX_ISSUES = 32;
export const MAX_EVIDENCE_TARGETS = 1_024;
export const DEFAULT_RETENTION = Object.freeze({ daily: 400, weekly: 104, monthly: 36 });

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_BACKUP_MAX_AGE_MS = 36 * 60 * 60_000;
const DEFAULT_WEEKLY_MAX_AGE_MS = 9 * DAY_MS;
const DEFAULT_MONTHLY_MAX_AGE_MS = 40 * DAY_MS;
const DEFAULT_CERTIFICATE_ATTENTION_MS = 30 * DAY_MS;
const DEFAULT_RECOVERY_STATUS_MAX_AGE_MS = 10 * 60_000;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function integer(value, fallback, label) {
  const selected = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error(`${label}-invalid`);
  return selected;
}

function isoTime(value, fallback) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function issue(code, severity, area, value, limit, action) {
  return { code, severity, area, value, limit, action };
}

function ageMs(timestamp, nowMs) {
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined;
}

function isPastGrace(installedAt, maximumAgeMs, nowMs) {
  const installedAge = ageMs(installedAt, nowMs);
  return installedAge === undefined || installedAge >= maximumAgeMs;
}

/** Pure evaluation: adapters collect facts; this function only classifies them. */
export function evaluateReadiness(snapshot, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const backupMaxAgeMs = options.backupMaxAgeMs ?? DEFAULT_BACKUP_MAX_AGE_MS;
  const weeklyMaxAgeMs = options.weeklyMaxAgeMs ?? DEFAULT_WEEKLY_MAX_AGE_MS;
  const monthlyMaxAgeMs = options.monthlyMaxAgeMs ?? DEFAULT_MONTHLY_MAX_AGE_MS;
  const certificateAttentionMs = options.certificateAttentionMs ?? DEFAULT_CERTIFICATE_ATTENTION_MS;
  const recoveryStatusMaxAgeMs = options.recoveryStatusMaxAgeMs ?? DEFAULT_RECOVERY_STATUS_MAX_AGE_MS;
  const restartAttentionCount = options.restartAttentionCount ?? 3;
  const findings = [];

  if (!snapshot.uptime?.available || !snapshot.uptime?.schemaValid) {
    findings.push(issue("uptime-probe-failed", "critical", "software", "Unavailable", "Fresh schema-v2 health", "Check RF Monitor status and the local health endpoint."));
  } else if (snapshot.uptime.currentState === "critical") {
    findings.push(issue("application-health-critical", "critical", "software", "Critical", "Normal or Attention", "Open System health and follow the first safe action."));
  }

  if (!snapshot.clock?.available || snapshot.clock.synchronized !== true) {
    findings.push(issue("clock-not-synchronized", "critical", "clock", "Not synchronized", "Synchronized", "Restore time synchronization before using timestamps as evidence."));
  }

  if (snapshot.certificate?.required) {
    const remainingMs = snapshot.certificate.expiresAt ? Date.parse(snapshot.certificate.expiresAt) - nowMs : Number.NaN;
    if (!snapshot.certificate.available || !Number.isFinite(remainingMs)) {
      findings.push(issue("certificate-unavailable", "attention", "network", "Not readable", "Valid certificate", "Check the configured TLS certificate."));
    } else if (remainingMs <= 0) {
      findings.push(issue("certificate-expired", "critical", "network", "Expired", "Valid", "Renew the TLS certificate before operator use."));
    } else if (remainingMs <= certificateAttentionMs) {
      findings.push(issue("certificate-expiring", "attention", "network", `${Math.ceil(remainingMs / DAY_MS)} days`, `More than ${Math.ceil(certificateAttentionMs / DAY_MS)} days`, "Schedule certificate renewal."));
    }
  }

  if (!snapshot.disk?.available) {
    findings.push(issue("disk-health-unavailable", "critical", "recording", "Unavailable", "Readable filesystem", "Check the evidence disk or mount."));
  } else if (snapshot.disk.healthy === false) {
    findings.push(issue("disk-health-failed", "critical", "recording", "Recording path unhealthy", "Healthy", "Open Recording and check disk and writer status."));
  } else if (snapshot.disk.availableBytes < snapshot.disk.reserveBytes) {
    findings.push(issue("disk-below-reserve", "critical", "recording", `${snapshot.disk.availableBytes} bytes`, `${snapshot.disk.reserveBytes} bytes`, "Free space without deleting active evidence."));
  }

  if (!snapshot.service?.available || snapshot.service.active !== true) {
    findings.push(issue("service-not-active", "critical", "software", "Not active", "Active", "Check RF Monitor service status."));
  } else if ((snapshot.service.restarts ?? 0) >= restartAttentionCount) {
    findings.push(issue("restart-count-high", "attention", "software", String(snapshot.service.restarts), `< ${restartAttentionCount}`, "Review recovery history and preserve a support bundle."));
  }

  for (const recovery of snapshot.recovery ?? []) {
    const label = recovery.name === "receiver" ? "Receiver" : "Software";
    if (!recovery.available) {
      findings.push(issue(`${recovery.name}-recovery-status-missing`, "attention", "recovery", "Unavailable", "Fresh status", `Check ${label.toLowerCase()} recovery supervision.`));
      continue;
    }
    if (recovery.state === "lockout") {
      findings.push(issue(`${recovery.name}-recovery-lockout`, "critical", "recovery", "Lockout", "Live", `Resolve the ${label.toLowerCase()} fault before one manual retry.`));
    } else if (recovery.state === "failed") {
      findings.push(issue(`${recovery.name}-recovery-failed`, "attention", "recovery", "Failed", "Live", `Check the ${label.toLowerCase()} recovery result.`));
    }
    const recoveryAgeMs = ageMs(recovery.observedAt, nowMs);
    if (recoveryAgeMs === undefined || recoveryAgeMs > recoveryStatusMaxAgeMs) {
      findings.push(issue(`${recovery.name}-recovery-status-stale`, "attention", "recovery", recoveryAgeMs === undefined ? "Unknown" : `${Math.floor(recoveryAgeMs / 1000)} seconds`, `≤ ${Math.floor(recoveryStatusMaxAgeMs / 1000)} seconds`, `Check the ${label.toLowerCase()} recovery timer.`));
    }
  }

  const installedAt = isoTime(snapshot.schedule?.installedAt, nowIso);
  const backupAgeMs = ageMs(snapshot.backup?.completedAt, nowMs);
  if (snapshot.backup?.lastAttemptOutcome === "FAIL") {
    findings.push(issue("backup-attempt-failed", "attention", "backup", "Latest attempt failed", "PASS or labelled INCOMPLETE", "Check the backup result and create a new verified backup."));
  }
  if (!snapshot.backup?.available) {
    if (isPastGrace(installedAt, backupMaxAgeMs, nowMs)) findings.push(issue("backup-missing", "attention", "backup", "No verified backup", `Within ${Math.ceil(backupMaxAgeMs / 3_600_000)} hours`, "Run and verify the off-host backup."));
  } else if (snapshot.backup.outcome === "FAIL") {
    findings.push(issue("backup-verification-failed", "critical", "backup", "Failed", "PASS or labelled INCOMPLETE", "Preserve the failed backup and create a new verified backup."));
  } else if (backupAgeMs === undefined || backupAgeMs > backupMaxAgeMs) {
    findings.push(issue("backup-stale", "attention", "backup", backupAgeMs === undefined ? "Unknown age" : `${Math.floor(backupAgeMs / 3_600_000)} hours`, `≤ ${Math.ceil(backupMaxAgeMs / 3_600_000)} hours`, "Create and verify a current off-host backup."));
  }

  const weeklyAgeMs = ageMs(snapshot.schedule?.lastWeeklyAt, nowMs);
  if (snapshot.schedule?.weeklyState === "critical") {
    findings.push(issue("weekly-verification-failed", "critical", "scheduled-checks", "Failed", "PASS or labelled INCOMPLETE", "Inspect the weekly evidence and backup verification record."));
  } else if (snapshot.schedule?.weeklyState === "attention") {
    findings.push(issue("weekly-verification-incomplete", "attention", "scheduled-checks", "Incomplete", "PASS", "Review the labelled evidence or backup gaps."));
  }
  if ((weeklyAgeMs === undefined && isPastGrace(installedAt, weeklyMaxAgeMs, nowMs)) || (weeklyAgeMs !== undefined && weeklyAgeMs > weeklyMaxAgeMs)) {
    findings.push(issue("weekly-verification-overdue", "attention", "scheduled-checks", weeklyAgeMs === undefined ? "Not completed" : `${Math.floor(weeklyAgeMs / DAY_MS)} days`, `≤ ${Math.ceil(weeklyMaxAgeMs / DAY_MS)} days`, "Run the weekly evidence and backup verification."));
  }
  const monthlyAgeMs = ageMs(snapshot.schedule?.lastMonthlyAt, nowMs);
  if (snapshot.schedule?.monthlyState === "critical") {
    findings.push(issue("monthly-drill-failed", "critical", "scheduled-checks", "Failed", "PASS or labelled INCOMPLETE", "Inspect the recovery and restore drill record."));
  } else if (snapshot.schedule?.monthlyState === "attention") {
    findings.push(issue("monthly-drill-incomplete", "attention", "scheduled-checks", "Incomplete", "PASS", "Review the labelled restore gaps."));
  }
  if ((monthlyAgeMs === undefined && isPastGrace(installedAt, monthlyMaxAgeMs, nowMs)) || (monthlyAgeMs !== undefined && monthlyAgeMs > monthlyMaxAgeMs)) {
    findings.push(issue("monthly-drill-overdue", "attention", "scheduled-checks", monthlyAgeMs === undefined ? "Not completed" : `${Math.floor(monthlyAgeMs / DAY_MS)} days`, `≤ ${Math.ceil(monthlyMaxAgeMs / DAY_MS)} days`, "Run the non-disruptive recovery and restore drill."));
  }

  if (snapshot.change?.changed && snapshot.uptime?.productionReady !== true) {
    findings.push(issue("recommissioning-required-after-change", "attention", "qualification", "Release or RF configuration changed", "Qualified current fingerprint", "Complete commissioning for the current release and configuration."));
  }

  const deduplicated = [];
  const seen = new Set();
  for (const finding of findings) {
    if (seen.has(finding.code)) continue;
    seen.add(finding.code);
    deduplicated.push(finding);
    if (deduplicated.length >= MAX_ISSUES) break;
  }
  const state = deduplicated.some((entry) => entry.severity === "critical")
    ? "critical"
    : deduplicated.length ? "attention" : "normal";
  return { state, evaluatedAt: nowIso, issues: deduplicated };
}

export function mergeIssueLedger(issues, previous = [], now = new Date()) {
  const previousByCode = new Map(previous.filter((entry) => object(entry) && typeof entry.code === "string").map((entry) => [entry.code, entry]));
  return issues.slice(0, MAX_ISSUES).map((entry) => {
    const old = previousByCode.get(entry.code);
    return {
      ...entry,
      firstSeenAt: isoTime(old?.firstSeenAt, now.toISOString()),
      lastSeenAt: now.toISOString(),
      occurrences: Math.min(1_000_000, Number.isSafeInteger(old?.occurrences) ? old.occurrences + 1 : 1),
    };
  });
}

export function createHashedEnvelope(kind, payload, generatedAt = new Date()) {
  if (!["probe", "daily", "weekly", "monthly"].includes(kind)) throw new Error("ops-record-kind-invalid");
  const canonicalPayload = canonical(payload);
  const payloadText = JSON.stringify(canonicalPayload);
  const unsignedEnvelope = {
    schemaVersion: OPS_SCHEMA_VERSION,
    kind,
    generatedAt: generatedAt.toISOString(),
    hashAlgorithm: "SHA-256",
    payloadSha256: sha256(payloadText),
    payload: canonicalPayload,
  };
  const envelope = {
    ...unsignedEnvelope,
    recordSha256: sha256(JSON.stringify(canonical(unsignedEnvelope))),
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_RECORD_BYTES) throw new Error("ops-record-size-bound");
  return envelope;
}

export function verifyHashedEnvelope(value) {
  if (!object(value) || value.schemaVersion !== OPS_SCHEMA_VERSION || !["probe", "daily", "weekly", "monthly"].includes(value.kind)
    || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))
    || value.hashAlgorithm !== "SHA-256" || typeof value.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.payloadSha256)
    || typeof value.recordSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.recordSha256)
    || !object(value.payload)) return false;
  const unsignedEnvelope = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    generatedAt: value.generatedAt,
    hashAlgorithm: value.hashAlgorithm,
    payloadSha256: value.payloadSha256,
    payload: value.payload,
  };
  return sha256(JSON.stringify(canonical(value.payload))) === value.payloadSha256
    && sha256(JSON.stringify(canonical(unsignedEnvelope))) === value.recordSha256;
}

async function noSymlinkDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("ops-directory-must-be-absolute");
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("ops-directory-symlink-or-nondirectory");
  }
  return resolved;
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeAtomic(filePath, contents) {
  const parent = await noSymlinkDirectory(path.dirname(filePath));
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("ops-output-target-invalid");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${filePath}.partial-${process.pid}-${sha256(`${Date.now()}-${Math.random()}`).slice(0, 8)}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await syncDirectory(parent);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function archiveHashedRecord({ archiveDir, kind, payload, generatedAt = new Date(), retain = DEFAULT_RETENTION[kind] }) {
  if (!Number.isSafeInteger(retain) || retain < 1 || retain > 10_000) throw new Error("ops-retention-invalid");
  const root = await noSymlinkDirectory(archiveDir);
  const kindDirectory = path.join(root, kind);
  await mkdir(kindDirectory, { recursive: true, mode: 0o750 });
  await noSymlinkDirectory(kindDirectory);
  const envelope = createHashedEnvelope(kind, payload, generatedAt);
  const contents = `${JSON.stringify(envelope, null, 2)}\n`;
  const timestamp = generatedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const fileName = `${timestamp}-${envelope.recordSha256.slice(0, 12)}.json`;
  const output = path.join(kindDirectory, fileName);
  await writeAtomic(output, contents);
  await writeAtomic(path.join(root, `${kind}-latest.json`), contents);
  const entries = (await readdir(kindDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}T.*-[a-f0-9]{12}\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - retain))) {
    const stalePath = path.join(kindDirectory, stale);
    const details = await lstat(stalePath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("ops-retention-target-invalid");
    await unlink(stalePath);
  }
  await syncDirectory(kindDirectory);
  return { path: output, envelope };
}

async function readBoundedRegularFile(filePath, maximumBytes, label = "ops-file-size-bound") {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) throw new Error("ops-nofollow-unavailable");
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) throw new Error(`${label}:${path.basename(filePath)}`);
    const value = await handle.readFile("utf8");
    if (Buffer.byteLength(value) > maximumBytes) throw new Error(`${label}:${path.basename(filePath)}`);
    return value;
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(filePath, maximumBytes = MAX_STATE_BYTES) {
  const value = JSON.parse(await readBoundedRegularFile(filePath, maximumBytes, "ops-json-size-bound"));
  if (!object(value)) throw new Error(`ops-json-object-required:${path.basename(filePath)}`);
  return value;
}

async function optionalJson(filePath, maximumBytes = MAX_STATE_BYTES) {
  try { return await readBoundedJson(filePath, maximumBytes); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function execute(program, arguments_, timeoutMs = 15_000) {
  try {
    const result = await execFile(program, arguments_, { timeout: timeoutMs, maxBuffer: MAX_COMMAND_BYTES, encoding: "utf8" });
    return { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isSafeInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout.slice(0, MAX_COMMAND_BYTES) : "",
      stderr: typeof error?.stderr === "string" ? error.stderr.slice(0, MAX_COMMAND_BYTES) : "",
    };
  }
}

function commandOutcomeMatchesExit(result, outcome) {
  if (outcome === "PASS") return result.ok === true && result.exitCode === 0;
  if (outcome === "INCOMPLETE") return result.ok === false && result.exitCode === 2;
  return result.ok === false && [1, 3].includes(result.exitCode);
}

function boundedReasons(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return value.slice(0, 16).map((entry) => entry.slice(0, 256));
}

function parseCommandJson(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    return object(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseEvidenceVerifierResult(result, expectedPath) {
  const parsed = parseCommandJson(result);
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.results) || parsed.results.length !== 1) return undefined;
  const verification = parsed.results[0];
  const reasons = object(verification) ? boundedReasons(verification.reasons) : undefined;
  if (!object(verification) || verification.path !== path.resolve(expectedPath) || !["PASS", "INCOMPLETE", "FAIL"].includes(verification.outcome)
    || !reasons || !commandOutcomeMatchesExit(result, verification.outcome)) return undefined;
  return { outcome: verification.outcome, reasons };
}

function parseBackupCliResult(result, expected) {
  const parsed = parseCommandJson(result);
  const reasons = parsed ? boundedReasons(parsed.reasons) : undefined;
  if (parsed?.schemaVersion !== 1 || parsed.operation !== expected.operation
    || !["PASS", "INCOMPLETE", "FAIL"].includes(parsed.outcome) || !reasons
    || !commandOutcomeMatchesExit(result, parsed.outcome)) return undefined;
  if (parsed.outcome !== "FAIL" && (typeof parsed.backupId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(parsed.backupId)
    || !Number.isSafeInteger(parsed.files) || parsed.files < 0 || !Number.isSafeInteger(parsed.bytes) || parsed.bytes < 0)) return undefined;
  if (parsed.outcome !== "FAIL" && (parsed.backupId !== expected.backupId
    || typeof parsed.backupPath !== "string" || parsed.backupPath !== path.resolve(expected.backupPath)
    || (expected.operation === "restore"
      && (typeof parsed.restorePath !== "string" || parsed.restorePath !== path.resolve(expected.restorePath))))) return undefined;
  const stateMatches = parsed.outcome === "FAIL"
    ? ["refused", "recovery-required"].includes(parsed.state)
    : parsed.outcome === "INCOMPLETE"
      ? parsed.state === "incomplete"
      : expected.operation === "verify"
        ? parsed.state === "complete"
        : parsed.state === "planned" || (parsed.state === "complete" && parsed.idempotent === true);
  if (!stateMatches) return undefined;
  return { ...parsed, reasons };
}

async function fetchHealth(url, fetchImplementation = globalThis.fetch) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("health-url-invalid");
    const response = await fetchImplementation(parsed, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_BYTES) throw new Error("health-response-size-bound");
    if (!response.body) throw new Error("health-response-empty");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HEALTH_BYTES) {
        await reader.cancel("health-response-size-bound");
        throw new Error("health-response-size-bound");
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks, total);
    if (buffer.byteLength <= 0) throw new Error("health-response-empty");
    const health = JSON.parse(buffer.toString("utf8"));
    const schemaValid = object(health) && health.schemaVersion === 2 && object(health.identity) && object(health.summary);
    return { available: response.ok, schemaValid, health: schemaValid ? health : undefined };
  } catch {
    return { available: false, schemaValid: false };
  }
}

function parseProperties(text) {
  return Object.fromEntries(text.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

async function collectService(systemctl) {
  const result = await execute(systemctl, ["show", "rf-monitor.service", "--property=ActiveState", "--property=SubState", "--property=NRestarts"]);
  if (!result.ok) return { available: false, active: false, restarts: 0 };
  const values = parseProperties(result.stdout);
  return {
    available: true,
    active: values.ActiveState === "active" && values.SubState === "running",
    restarts: /^\d+$/.test(values.NRestarts ?? "") ? Number(values.NRestarts) : 0,
  };
}

async function collectTimer(systemctl, unit) {
  const result = await execute(systemctl, ["show", unit, "--property=ActiveState", "--property=NextElapseUSecRealtime"]);
  if (!result.ok) return { available: false, active: false, nextRun: false };
  const values = parseProperties(result.stdout);
  return { available: true, active: values.ActiveState === "active", nextRun: Boolean(values.NextElapseUSecRealtime && values.NextElapseUSecRealtime !== "n/a") };
}

async function collectClock(timedatectl) {
  const result = await execute(timedatectl, ["show", "--property=NTPSynchronized", "--value"]);
  return { available: result.ok, synchronized: result.stdout.trim() === "yes" };
}

async function collectCertificate(certificatePath, nowMs) {
  if (!certificatePath) return { required: false, available: true };
  try {
    if (!path.isAbsolute(certificatePath)) throw new Error("certificate-path-not-absolute");
    const details = await lstat(certificatePath);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > 1024 * 1024) throw new Error("certificate-file-invalid");
    const certificate = new X509Certificate(await readFile(certificatePath));
    const expiresAt = new Date(certificate.validTo).toISOString();
    return { required: true, available: Number.isFinite(Date.parse(expiresAt)), expiresAt, expired: Date.parse(expiresAt) <= nowMs };
  } catch {
    return { required: true, available: false };
  }
}

async function collectDisk(storageDir, reserveBytes, health) {
  try {
    const root = await noSymlinkDirectory(storageDir);
    const details = await statfs(root);
    const availableBigInt = BigInt(details.bavail) * BigInt(details.bsize);
    const availableBytes = availableBigInt > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(availableBigInt);
    const healthDisk = object(health?.disk) ? health.disk : {};
    const evidence = object(health?.evidence) ? health.evidence : {};
    return {
      available: true,
      availableBytes,
      reserveBytes,
      healthy: healthDisk.pressure !== true && evidence.diskPressure !== true && evidence.healthy !== false,
    };
  } catch {
    return { available: false, availableBytes: 0, reserveBytes, healthy: false };
  }
}

async function collectRecovery(name, filePath) {
  try {
    const value = await readBoundedJson(filePath, 64 * 1024);
    return {
      name,
      available: value.schemaVersion === 1 && typeof value.state === "string",
      state: typeof value.state === "string" ? value.state : "unknown",
      observedAt: typeof value.observedAt === "string" ? value.observedAt : undefined,
      lockoutUntil: typeof value.lockoutUntil === "string" ? value.lockoutUntil : undefined,
    };
  } catch {
    return { name, available: false, state: "unknown" };
  }
}

async function latestEnvelope(archiveDir, kind) {
  try {
    const value = await optionalJson(path.join(archiveDir, `${kind}-latest.json`), MAX_RECORD_BYTES);
    if (!value) return undefined;
    return verifyHashedEnvelope(value) ? value : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

async function latestBackup(backupRoot) {
  if (!backupRoot) return { available: false };
  try {
    const root = await noSymlinkDirectory(backupRoot);
    const auditPath = path.join(root, "rf-monitor-backup-audit.jsonl");
    const lines = (await readBoundedRegularFile(auditPath, 2 * 1024 * 1024, "backup-audit-size-bound")).trim().split("\n").slice(-512);
    let selected;
    let latestAttempt;
    for (const line of lines) {
      if (Buffer.byteLength(line) > 64 * 1024) continue;
      try {
        const record = JSON.parse(line);
        if (record.operation === "create" && ["PASS", "INCOMPLETE", "FAIL"].includes(record.outcome)
          && typeof record.timestamp === "string" && typeof record.backupPath === "string"
          && typeof record.backupId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(record.backupId)) {
          latestAttempt = record;
          if (record.outcome !== "FAIL" && ["complete", "incomplete"].includes(record.state)) selected = record;
        }
      } catch { /* A malformed old line cannot hide a later valid record. */ }
    }
    if (!selected || !path.isAbsolute(selected.backupPath)) return {
      available: false,
      lastAttemptAt: latestAttempt?.timestamp,
      lastAttemptOutcome: latestAttempt?.outcome,
    };
    const relative = path.relative(root, path.resolve(selected.backupPath));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { available: false };
    const backupPath = path.resolve(selected.backupPath);
    if (path.dirname(backupPath) !== root || path.basename(backupPath) !== selected.backupId) return { available: false };
    await noSymlinkDirectory(backupPath);
    return {
      available: true,
      completedAt: selected.timestamp,
      outcome: selected.outcome,
      backupId: selected.backupId,
      backupPath,
      lastAttemptAt: latestAttempt?.timestamp,
      lastAttemptOutcome: latestAttempt?.outcome,
    };
  } catch {
    return { available: false };
  }
}

function compactHealth(health) {
  return {
    serviceBootId: health?.identity?.serviceBootId,
    buildId: health?.identity?.release?.buildId,
    configurationHash: health?.identity?.configuration?.configurationHash,
    currentState: health?.summary?.state,
    productionReady: health?.productionReady === true,
    qualificationState: health?.productionQualification?.state,
    qualificationBlockers: Array.isArray(health?.productionQualification?.blockers)
      ? health.productionQualification.blockers.slice(0, 16).filter((entry) => typeof entry === "string").map((entry) => entry.slice(0, 96))
      : [],
  };
}

async function loadState(archiveDir, now) {
  const state = await optionalJson(path.join(archiveDir, "ops-state.json"), MAX_STATE_BYTES);
  if (state?.schemaVersion === OPS_SCHEMA_VERSION) return state;
  return { schemaVersion: OPS_SCHEMA_VERSION, installedAt: now.toISOString(), activeIssues: [] };
}

async function saveState(archiveDir, state) {
  const contents = `${JSON.stringify(canonical(state), null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error("ops-state-size-bound");
  await writeAtomic(path.join(archiveDir, "ops-state.json"), contents);
}

function fingerprint(compact) {
  return compact.buildId && compact.configurationHash ? `${compact.buildId}:${compact.configurationHash}` : undefined;
}

export async function collectDailySnapshot(config, now = new Date()) {
  const uptime = await fetchHealth(config.healthUrl, config.fetchImplementation);
  const health = uptime.health;
  const compact = compactHealth(health);
  const [clock, certificate, disk, service, receiverRecovery, applicationRecovery, backup, weekly, monthly] = await Promise.all([
    collectClock(config.timedatectl),
    collectCertificate(config.tlsCertificate, now.getTime()),
    collectDisk(config.storageDir, config.diskReserveBytes, health),
    collectService(config.systemctl),
    collectRecovery("receiver", config.receiverRecoveryStatus),
    collectRecovery("application", config.applicationRecoveryStatus),
    latestBackup(config.backupRoot),
    latestEnvelope(config.archiveDir, "weekly"),
    latestEnvelope(config.archiveDir, "monthly"),
  ]);
  const state = await loadState(config.archiveDir, now);
  const currentFingerprint = fingerprint(compact);
  return {
    snapshot: {
      uptime: { available: uptime.available, schemaValid: uptime.schemaValid, ...compact },
      clock,
      certificate,
      disk,
      service,
      recovery: [receiverRecovery, applicationRecovery],
      backup: {
        available: backup.available,
        completedAt: backup.completedAt,
        outcome: backup.outcome,
        lastAttemptAt: backup.lastAttemptAt,
        lastAttemptOutcome: backup.lastAttemptOutcome,
      },
      schedule: {
        installedAt: state.installedAt,
        lastWeeklyAt: weekly?.generatedAt,
        lastMonthlyAt: monthly?.generatedAt,
        weeklyState: weekly?.invalid ? "critical" : weekly?.payload?.summary?.state,
        monthlyState: monthly?.invalid ? "critical" : monthly?.payload?.summary?.state,
      },
      change: {
        changed: compact.productionReady !== true && Boolean(
          state.pendingRecommissioning
          || (state.lastFingerprint && currentFingerprint && state.lastFingerprint !== currentFingerprint)
        ),
      },
    },
    state,
    compact,
    currentFingerprint,
  };
}

export async function runDaily(config, now = new Date()) {
  const current = await evaluateCurrent(config, now);
  const archived = await archiveHashedRecord({ archiveDir: config.archiveDir, kind: "daily", payload: current.payload, generatedAt: now, retain: config.retention.daily });
  await saveState(config.archiveDir, { ...current.nextState, lastDailyAt: now.toISOString() });
  await writeAtomic(path.join(config.archiveDir, "status.json"), `${JSON.stringify(archived.envelope, null, 2)}\n`);
  return archived.envelope;
}

async function evaluateCurrent(config, now) {
  const collected = await collectDailySnapshot(config, now);
  const evaluated = evaluateReadiness(collected.snapshot, { nowMs: now.getTime(), ...config.thresholds });
  const activeIssues = mergeIssueLedger(evaluated.issues, collected.state.activeIssues, now);
  const payload = {
    summary: { state: evaluated.state, issueCount: activeIssues.length },
    identity: collected.compact,
    checks: {
      uptime: collected.snapshot.uptime.available && collected.snapshot.uptime.schemaValid,
      clockSynchronized: collected.snapshot.clock.synchronized === true,
      certificateExpiresAt: collected.snapshot.certificate.expiresAt,
      diskAvailableBytes: collected.snapshot.disk.availableBytes,
      diskReserveBytes: collected.snapshot.disk.reserveBytes,
      serviceActive: collected.snapshot.service.active,
      restartCount: collected.snapshot.service.restarts,
      backupCompletedAt: collected.snapshot.backup.completedAt,
      backupOutcome: collected.snapshot.backup.outcome,
      backupLastAttemptAt: collected.snapshot.backup.lastAttemptAt,
      backupLastAttemptOutcome: collected.snapshot.backup.lastAttemptOutcome,
      receiverRecovery: collected.snapshot.recovery[0]?.state,
      applicationRecovery: collected.snapshot.recovery[1]?.state,
      weeklyCompletedAt: collected.snapshot.schedule.lastWeeklyAt,
      monthlyCompletedAt: collected.snapshot.schedule.lastMonthlyAt,
      weeklyState: collected.snapshot.schedule.weeklyState,
      monthlyState: collected.snapshot.schedule.monthlyState,
    },
    issues: activeIssues,
  };
  const nextState = {
    schemaVersion: OPS_SCHEMA_VERSION,
    installedAt: collected.state.installedAt,
    lastFingerprint: collected.currentFingerprint,
    lastQualifiedFingerprint: collected.compact.productionReady ? collected.currentFingerprint : collected.state.lastQualifiedFingerprint,
    pendingRecommissioning: collected.compact.productionReady ? false : collected.snapshot.change.changed,
    activeIssues,
    lastDailyAt: collected.state.lastDailyAt,
    lastProbeAt: collected.state.lastProbeAt,
  };
  return { payload, nextState };
}

export async function runProbe(config, now = new Date()) {
  const current = await evaluateCurrent(config, now);
  const envelope = createHashedEnvelope("probe", current.payload, now);
  await saveState(config.archiveDir, { ...current.nextState, lastProbeAt: now.toISOString() });
  await writeAtomic(path.join(config.archiveDir, "status.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

async function discoverEvidenceTargets(roots) {
  const targets = [];
  const pending = [];
  for (const root of roots) pending.push({ directory: await noSymlinkDirectory(root), depth: 0 });
  while (pending.length) {
    const { directory, depth } = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    if (path.basename(directory).startsWith("session-") && entries.some((entry) => entry.isFile() && ["manifest.json", "session.json"].includes(entry.name))) {
      const descriptor = await optionalJson(path.join(directory, "session.json"), 2 * 1024 * 1024);
      if (!descriptor || !["Active", "Finalizing"].includes(descriptor.lifecycle)) targets.push(directory);
      if (targets.length > MAX_EVIDENCE_TARGETS) throw new Error("evidence-target-count-bound");
      continue;
    }
    if (depth >= 6) continue;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("evidence-symlink-refused");
      if (entry.isDirectory()) pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      if (pending.length + targets.length > MAX_EVIDENCE_TARGETS * 4) throw new Error("evidence-scan-bound");
    }
  }
  return targets.sort();
}

async function verifyEvidenceTargets(config, deadlineAtMs = Date.now() + config.weeklyJobMaxMs) {
  let targets;
  try { targets = await discoverEvidenceTargets(config.evidenceRoots); } catch (error) {
    return { outcome: "FAIL", checked: 0, pass: 0, incomplete: 0, fail: 1, reasons: [String(error?.message ?? "evidence-discovery-failed").slice(0, 256)] };
  }
  if (!targets.length) return { outcome: "INCOMPLETE", checked: 0, pass: 0, incomplete: 0, fail: 0, reasons: ["no-finalized-evidence-targets"] };
  let pass = 0;
  let incomplete = 0;
  let fail = 0;
  let checked = 0;
  const reasons = [];
  for (const target of targets) {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      fail += targets.length - checked;
      reasons.push("weekly-verification-time-bound");
      break;
    }
    const result = await execute(config.node, [config.evidenceVerifier, "--json", target], Math.min(config.verificationTimeoutMs, remainingMs));
    checked += 1;
    const parsed = parseEvidenceVerifierResult(result, target);
    if (!parsed) {
      fail += 1;
      if (reasons.length < 16) reasons.push(result.ok ? "evidence-verifier-output-invalid" : "evidence-verifier-failed");
    } else if (parsed.outcome === "PASS") pass += 1;
    else if (parsed.outcome === "INCOMPLETE") incomplete += 1;
    else {
      fail += 1;
      if (reasons.length < 16) reasons.push("evidence-verification-failed");
    }
  }
  return { outcome: fail ? "FAIL" : incomplete ? "INCOMPLETE" : "PASS", checked, pass, incomplete, fail, reasons };
}

async function verifyLatestBackup(config, timeoutMs = config.verificationTimeoutMs) {
  const latest = await latestBackup(config.backupRoot);
  if (!latest.available) return { outcome: "FAIL", reasons: ["verified-backup-missing"] };
  const result = await execute(config.node, [config.backupCli, "verify", "--backup", latest.backupPath, "--json"], timeoutMs);
  const parsed = parseBackupCliResult(result, {
    operation: "verify",
    backupId: latest.backupId,
    backupPath: latest.backupPath,
  });
  if (parsed && parsed.outcome !== "FAIL") {
    return {
      outcome: parsed.outcome,
      backupId: parsed.backupId,
      files: parsed.files,
      bytes: parsed.bytes,
      reasons: parsed.reasons,
      path: latest.backupPath,
    };
  }
  return { outcome: "FAIL", reasons: [result.ok ? "backup-verifier-output-invalid" : "backup-verifier-failed"], path: latest.backupPath };
}

export async function runWeekly(config, now = new Date()) {
  const deadlineAtMs = Date.now() + config.weeklyJobMaxMs;
  // Hash one source at a time. Concurrent full-evidence and backup verification
  // would create avoidable disk pressure on the monitoring host.
  const evidence = await verifyEvidenceTargets(config, deadlineAtMs);
  const remainingMs = deadlineAtMs - Date.now();
  const backup = remainingMs > 0
    ? await verifyLatestBackup(config, Math.min(config.verificationTimeoutMs, remainingMs))
    : { outcome: "FAIL", reasons: ["weekly-verification-time-bound"] };
  const state = evidence.outcome === "FAIL" || backup.outcome === "FAIL" ? "critical"
    : evidence.outcome === "INCOMPLETE" || backup.outcome === "INCOMPLETE" ? "attention" : "normal";
  const payload = {
    summary: { state, evidenceOutcome: evidence.outcome, backupOutcome: backup.outcome },
    evidence,
    backup: { ...backup, path: undefined },
  };
  return (await archiveHashedRecord({ archiveDir: config.archiveDir, kind: "weekly", payload, generatedAt: now, retain: config.retention.weekly })).envelope;
}

export async function runMonthly(config, now = new Date()) {
  const [applicationTimer, receiverTimer, applicationRecovery, receiverRecovery, backup] = await Promise.all([
    collectTimer(config.systemctl, "rf-monitor-application-recovery.timer"),
    collectTimer(config.systemctl, "rf-monitor-sdr-recovery.timer"),
    collectRecovery("application", config.applicationRecoveryStatus),
    collectRecovery("receiver", config.receiverRecoveryStatus),
    latestBackup(config.backupRoot),
  ]);
  let restore = { outcome: "FAIL", reasons: ["verified-backup-missing"] };
  if (backup.backupPath) {
    await noSymlinkDirectory(config.restoreStagingRoot);
    const destination = path.join(config.restoreStagingRoot, "ops-restore-drill-latest");
    const result = await execute(config.node, [config.backupCli, "restore", "--backup", backup.backupPath, "--destination", destination, "--dry-run", "--json"], Math.min(config.verificationTimeoutMs, config.monthlyJobMaxMs));
    const parsed = parseBackupCliResult(result, {
      operation: "restore",
      backupId: backup.backupId,
      backupPath: backup.backupPath,
      restorePath: destination,
    });
    if (parsed && parsed.outcome !== "FAIL") {
      restore = {
        outcome: parsed.outcome,
        state: parsed.state,
        files: parsed.files,
        bytes: parsed.bytes,
        reasons: parsed.reasons,
      };
    } else {
      restore = { outcome: "FAIL", reasons: [result.ok ? "restore-drill-output-invalid" : "restore-drill-failed"] };
    }
  }
  const recoveryPass = applicationTimer.active && applicationTimer.nextRun && receiverTimer.active && receiverTimer.nextRun
    && applicationRecovery.available && receiverRecovery.available
    && !["failed", "lockout"].includes(applicationRecovery.state)
    && !["failed", "lockout"].includes(receiverRecovery.state);
  const state = !recoveryPass || restore.outcome === "FAIL" ? "critical" : restore.outcome === "INCOMPLETE" ? "attention" : "normal";
  const payload = {
    summary: { state, recoveryOutcome: recoveryPass ? "PASS" : "FAIL", restoreOutcome: restore.outcome },
    recovery: {
      applicationTimer: { active: applicationTimer.active, nextRun: applicationTimer.nextRun },
      receiverTimer: { active: receiverTimer.active, nextRun: receiverTimer.nextRun },
      applicationState: applicationRecovery.state,
      receiverState: receiverRecovery.state,
    },
    restore,
  };
  return (await archiveHashedRecord({ archiveDir: config.archiveDir, kind: "monthly", payload, generatedAt: now, retain: config.retention.monthly })).envelope;
}

export function configFromEnvironment(environment = process.env) {
  const installDir = environment.RFMON_INSTALL_DIR ?? "/opt/rf-monitor";
  const archiveDir = environment.RFMON_OPS_ARCHIVE_DIR ?? "/var/lib/rf-monitor-ops";
  const storageDir = environment.RFMON_OPS_STORAGE_DIR ?? environment.RF_MONITOR_STORAGE ?? "/var/lib/rf-monitor/evidence";
  const evidenceRoots = (environment.RFMON_OPS_EVIDENCE_ROOTS ?? `${storageDir}/field/evidence,${storageDir}/test/evidence`)
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  return {
    installDir,
    archiveDir,
    storageDir,
    backupRoot: environment.RFMON_OPS_BACKUP_ROOT,
    restoreStagingRoot: environment.RFMON_OPS_RESTORE_STAGING_ROOT ?? "/var/lib/rf-monitor/restore-drills",
    evidenceRoots,
    healthUrl: environment.RFMON_OPS_HEALTH_URL ?? "http://127.0.0.1:8080/api/health",
    tlsCertificate: environment.RFMON_OPS_TLS_CERTIFICATE ?? "/etc/rf-monitor/tls/rf-monitor.crt",
    diskReserveBytes: integer(environment.RFMON_OPS_DISK_RESERVE_BYTES, 5 * 1024 * 1024 * 1024, "disk-reserve"),
    node: environment.RFMON_OPS_NODE ?? "/usr/bin/node",
    systemctl: environment.RFMON_OPS_SYSTEMCTL ?? "/usr/bin/systemctl",
    timedatectl: environment.RFMON_OPS_TIMEDATECTL ?? "/usr/bin/timedatectl",
    evidenceVerifier: environment.RFMON_OPS_EVIDENCE_VERIFIER ?? path.join(installDir, "dist/server-node/evidence-verifier.js"),
    backupCli: environment.RFMON_OPS_BACKUP_CLI ?? path.join(installDir, "dist/server-node/evidence-backup.js"),
    receiverRecoveryStatus: environment.RFMON_OPS_RECEIVER_RECOVERY_STATUS ?? "/run/rf-monitor-recovery/status.json",
    applicationRecoveryStatus: environment.RFMON_OPS_APPLICATION_RECOVERY_STATUS ?? "/run/rf-monitor-application-recovery/status.json",
    verificationTimeoutMs: integer(environment.RFMON_OPS_VERIFICATION_TIMEOUT_MS, 30 * 60_000, "verification-timeout"),
    weeklyJobMaxMs: integer(environment.RFMON_OPS_WEEKLY_JOB_MAX_MS, 5 * 60 * 60_000, "weekly-job-max"),
    monthlyJobMaxMs: integer(environment.RFMON_OPS_MONTHLY_JOB_MAX_MS, 5 * 60 * 60_000, "monthly-job-max"),
    retention: {
      daily: integer(environment.RFMON_OPS_DAILY_RECORDS, DEFAULT_RETENTION.daily, "daily-retention"),
      weekly: integer(environment.RFMON_OPS_WEEKLY_RECORDS, DEFAULT_RETENTION.weekly, "weekly-retention"),
      monthly: integer(environment.RFMON_OPS_MONTHLY_RECORDS, DEFAULT_RETENTION.monthly, "monthly-retention"),
    },
    thresholds: {
      backupMaxAgeMs: integer(environment.RFMON_OPS_BACKUP_MAX_AGE_MS, DEFAULT_BACKUP_MAX_AGE_MS, "backup-age"),
      weeklyMaxAgeMs: integer(environment.RFMON_OPS_WEEKLY_MAX_AGE_MS, DEFAULT_WEEKLY_MAX_AGE_MS, "weekly-age"),
      monthlyMaxAgeMs: integer(environment.RFMON_OPS_MONTHLY_MAX_AGE_MS, DEFAULT_MONTHLY_MAX_AGE_MS, "monthly-age"),
      restartAttentionCount: integer(environment.RFMON_OPS_RESTART_ATTENTION_COUNT, 3, "restart-attention"),
    },
  };
}

async function main() {
  const command = process.argv[2];
  if (!["probe", "daily", "weekly", "monthly", "status"].includes(command) || process.argv.length !== 3) {
    process.stderr.write("Usage: /usr/bin/node ops-supervisor.mjs probe|daily|weekly|monthly|status\n");
    return 64;
  }
  const config = configFromEnvironment();
  await noSymlinkDirectory(config.archiveDir);
  if (command === "status") {
    const status = await optionalJson(path.join(config.archiveDir, "status.json"), MAX_RECORD_BYTES);
    if (!status || !verifyHashedEnvelope(status)) throw new Error("ops-status-missing-or-invalid");
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const result = command === "probe" ? await runProbe(config) : command === "daily" ? await runDaily(config) : command === "weekly" ? await runWeekly(config) : await runMonthly(config);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: result.kind, generatedAt: result.generatedAt, state: result.payload.summary.state, issues: result.payload.summary.issueCount ?? 0 })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); } catch (error) {
    process.stderr.write(`RF Monitor operations supervision failed: ${error instanceof Error ? error.message : "unexpected-error"}\n`);
    process.exitCode = 1;
  }
}
