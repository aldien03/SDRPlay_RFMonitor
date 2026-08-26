import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface ReceiverRecoveryRequest {
  schemaVersion: 1;
  requestId: string;
  requestedAt: string;
  source: "operator";
}

export interface ApplicationRestartRequest {
  schemaVersion: 1;
  requestId: string;
  requestedAt: string;
  source: "settings-admin";
  expectedConfigurationRevision: number;
  previousBootId: string;
  auditEntryHash: string;
}

export type RecoverySupervisorState = "live" | "requested" | "recovering" | "failed" | "lockout";

export interface RecoverySupervisorStatus {
  schemaVersion: 1;
  state: RecoverySupervisorState;
  reasonCode: string;
  source: "automatic" | "manual";
  observedAt: string;
  requestId?: string;
  requestedAt?: string;
  nextAttemptAt?: string;
  lockoutUntil?: string;
  attemptsInWindow?: number;
  maxAttempts?: number;
  requestRetained?: boolean;
  systemdResult?: string;
}

export type RecoveryStatusReadResult =
  | { availability: "available"; fresh: boolean; ageMs: number; status: RecoverySupervisorStatus }
  | { availability: "unavailable"; reasonCode: "missing" | "oversized" | "invalid" | "unreadable" };

export type RecoveryOperationOutcome =
  | "request-accepted"
  | "helper-pending"
  | "verified-recovery"
  | "cooldown"
  | "lockout"
  | "unavailable";

export interface RecoveryOperationState {
  schemaVersion: 1;
  outcome: RecoveryOperationOutcome;
  reasonCode: string;
  requestId?: string;
  requestedAt?: string;
  retryAfterMs?: number;
  nextAttemptAt?: string;
  lockoutUntil?: string;
  attemptsInWindow?: number;
  maxAttempts?: number;
}

const MAX_STATUS_BYTES = 16 * 1024;
const STATUS_FRESH_MS = 45_000;

function boundedString(value: unknown, maximum = 128): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
  const string = boundedString(value, 64);
  return string !== undefined && Number.isFinite(Date.parse(string)) ? string : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000 ? Number(value) : undefined;
}

export async function readRecoverySupervisorStatus(
  source: string,
  now = Date.now(),
  freshMs = STATUS_FRESH_MS,
): Promise<RecoveryStatusReadResult> {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { availability: "unavailable", reasonCode: "invalid" };
    if (metadata.size <= 0 || metadata.size > MAX_STATUS_BYTES) return { availability: "unavailable", reasonCode: "oversized" };
    const bytes = Buffer.alloc(Math.min(MAX_STATUS_BYTES + 1, metadata.size + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead > MAX_STATUS_BYTES) return { availability: "unavailable", reasonCode: "oversized" };
    const raw = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as Record<string, unknown>;
    const state = boundedString(raw.state);
    const reasonCode = boundedString(raw.reasonCode);
    const observedAt = optionalTimestamp(raw.observedAt);
    const sourceValue = boundedString(raw.source);
    if (
      raw.schemaVersion !== 1
      || !state
      || !(["live", "requested", "recovering", "failed", "lockout"] as string[]).includes(state)
      || !reasonCode
      || !observedAt
      || (sourceValue !== "automatic" && sourceValue !== "manual")
    ) return { availability: "unavailable", reasonCode: "invalid" };
    const observedAtMs = Date.parse(observedAt);
    if (observedAtMs > now + 5_000) return { availability: "unavailable", reasonCode: "invalid" };
    const ageMs = Math.max(0, now - observedAtMs);
    const status: RecoverySupervisorStatus = {
      schemaVersion: 1,
      state: state as RecoverySupervisorState,
      reasonCode,
      source: sourceValue,
      observedAt,
      requestId: boundedString(raw.requestId),
      requestedAt: optionalTimestamp(raw.requestedAt),
      nextAttemptAt: optionalTimestamp(raw.nextAttemptAt),
      lockoutUntil: optionalTimestamp(raw.lockoutUntil),
      attemptsInWindow: optionalCount(raw.attemptsInWindow),
      maxAttempts: optionalCount(raw.maxAttempts),
      requestRetained: typeof raw.requestRetained === "boolean" ? raw.requestRetained : undefined,
      systemdResult: boundedString(raw.systemdResult),
    };
    return { availability: "available", fresh: ageMs <= freshMs, ageMs, status };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { availability: "unavailable", reasonCode: "missing" };
    if (error instanceof SyntaxError) return { availability: "unavailable", reasonCode: "invalid" };
    return { availability: "unavailable", reasonCode: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function delayUntil(timestamp: string | undefined, now: number): number | undefined {
  if (!timestamp) return undefined;
  const delay = Date.parse(timestamp) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** Maps privileged-helper state to the bounded public Retry contract. */
export function recoveryOperationState(
  result: RecoveryStatusReadResult,
  receiverReady: boolean,
  now = Date.now(),
): RecoveryOperationState {
  if (result.availability === "unavailable" || !result.fresh) {
    return { schemaVersion: 1, outcome: "unavailable", reasonCode: result.availability === "unavailable" ? result.reasonCode : "stale-status" };
  }
  const status = result.status;
  const common = {
    schemaVersion: 1 as const,
    reasonCode: status.reasonCode,
    requestId: status.requestId,
    requestedAt: status.requestedAt,
    nextAttemptAt: status.nextAttemptAt,
    lockoutUntil: status.lockoutUntil,
    attemptsInWindow: status.attemptsInWindow,
    maxAttempts: status.maxAttempts,
  };
  if (status.state === "lockout") return { ...common, outcome: "lockout", retryAfterMs: delayUntil(status.lockoutUntil, now) };
  if (status.state === "requested" || status.state === "recovering") return { ...common, outcome: "helper-pending", retryAfterMs: delayUntil(status.nextAttemptAt, now) };
  if (status.state === "failed") {
    if (status.nextAttemptAt) return { ...common, outcome: "cooldown", retryAfterMs: delayUntil(status.nextAttemptAt, now) };
    return { ...common, outcome: "unavailable" };
  }
  if (receiverReady) return { ...common, outcome: "verified-recovery" };
  return { ...common, outcome: "unavailable", reasonCode: "receiver-not-ready" };
}

async function publishAtomicRequest<T extends { requestId: string }>(destination: string, request: T): Promise<T> {
  const directoryPath = path.dirname(destination);
  const temporary = `${destination}.partial-${process.pid}-${request.requestId}`;
  let handle;
  try {
    const directory = await lstat(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Recovery request directory must be a real directory");
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Recovery request destination must be a regular file");
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    const directoryHandle = await open(directoryPath, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return request;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Publish an operator recovery request with an atomic same-directory rename.
 * The privileged helper retains this file until recovery is confirmed, so a
 * systemd start-limit failure cannot silently consume an accepted request.
 */
export async function publishReceiverRecoveryRequest(
  destination: string,
  now = new Date(),
): Promise<ReceiverRecoveryRequest> {
  const request: ReceiverRecoveryRequest = {
    schemaVersion: 1,
    requestId: randomUUID(),
    requestedAt: now.toISOString(),
    source: "operator",
  };
  return publishAtomicRequest(destination, request);
}

export async function publishApplicationRestartRequest(
  destination: string,
  input: {
    expectedConfigurationRevision: number;
    previousBootId: string;
    auditEntryHash: string;
  },
  now = new Date(),
): Promise<ApplicationRestartRequest> {
  if (!Number.isInteger(input.expectedConfigurationRevision) || input.expectedConfigurationRevision < 1) {
    throw new Error("Expected configuration revision must be a positive integer");
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.previousBootId)) throw new Error("Previous boot identity is invalid");
  if (!/^[a-f0-9]{64}$/.test(input.auditEntryHash)) throw new Error("Durable audit identity is invalid");
  const request: ApplicationRestartRequest = {
    schemaVersion: 1,
    requestId: randomUUID(),
    requestedAt: now.toISOString(),
    source: "settings-admin",
    expectedConfigurationRevision: input.expectedConfigurationRevision,
    previousBootId: input.previousBootId,
    auditEntryHash: input.auditEntryHash,
  };
  return publishAtomicRequest(destination, request);
}

/**
 * Enforces the authorization ordering at the privilege boundary: no request
 * file can exist until the caller confirms its audit record is durable.
 */
export async function publishAuditedApplicationRestartRequest(
  destination: string,
  input: { expectedConfigurationRevision: number; previousBootId: string },
  durableAudit: () => Promise<{ entryHash: string }>,
  now = new Date(),
): Promise<ApplicationRestartRequest> {
  const audit = await durableAudit();
  return publishApplicationRestartRequest(destination, { ...input, auditEntryHash: audit.entryHash }, now);
}
