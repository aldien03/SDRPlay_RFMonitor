import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { DataDomain } from "../shared/types";

const DOMAIN_MARKER = ".rf-monitor-data-domain.json";
const DOMAIN_LEASE = ".rf-monitor-active.json";
const DOMAIN_MARKER_SCHEMA = 1;
const MAX_LEGACY_BASELINE_BYTES = 64 * 1024 * 1024;
const TEST_CLEAR_JOURNAL = "test-data-clear-operation.json";
const TEST_CLEAR_GENERATION = ".rf-monitor-test-generation.json";
const CONTROL_AUDIT = "domain-maintenance-audit.jsonl";
const CONTROL_RECORD_MAX_BYTES = 64 * 1024;

export interface DomainPathSet {
  root: string;
  evidenceRoot: string;
  baselineFile: string;
}

export interface DataDomainPaths {
  baseRoot: string;
  field: DomainPathSet;
  test: DomainPathSet;
  /** Unscoped v1 learning is retained but never selected by a domain-aware runtime. */
  legacyBaselineFile: string;
}

export interface LegacyBaselineQuarantine {
  state: "none" | "ignored";
  sourcePath: string;
  reason?: "unscoped-data-domain" | "unreadable-unscoped-data-domain";
  sha256?: string;
  bytes?: number;
  recordCount?: number;
}

export interface ClearedTestData {
  domain: "test";
  operationId: string;
  clearedAt: string;
  previousDataPresent: boolean;
  committed: true;
  state: "complete" | "recovery-required";
  cleanupPending: boolean;
  auditDurable: boolean;
  recoveryReason?: string;
}

export type ClearTestDataFaultPoint =
  | "before-prepared-audit"
  | "before-commit-rename"
  | "after-commit-rename"
  | "before-replacement-create"
  | "before-cleanup"
  | "after-cleanup"
  | "before-completion-audit"
  | "before-journal-cleanup";

export interface ClearTestDataOptions {
  actor?: string;
  operationId?: string;
  now?: () => Date;
  /** Deterministic test seam. Production callers leave this unset. */
  injectFault?: (point: ClearTestDataFaultPoint) => void | Promise<void>;
}

type TestClearPhase = "prepared" | "committed" | "replacement-ready" | "audited";

interface TestClearJournal {
  schemaVersion: 1;
  type: "test-data-clear";
  operationId: string;
  actor: string;
  clearedAt: string;
  previousDataPresent: boolean;
  testRoot: string;
  quarantinePath: string;
  phase: TestClearPhase;
}

export interface TestClearRecovery {
  found: boolean;
  committed: boolean;
  result?: ClearedTestData;
}

export type BaselineRestartPhase = "prepared" | "baseline-committed" | "runtime-reset" | "audited";

export interface BaselineRestartOperation {
  schemaVersion: 1;
  type: "baseline-restart";
  operationId: string;
  dataDomain: DataDomain;
  targetId: string;
  fingerprintId: string;
  expectedGeneration: number;
  nextGeneration: number;
  binCount: number;
  actor: string;
  preparedAt: string;
  phase: BaselineRestartPhase;
}

export interface DataDomainLease {
  domain: DataDomain;
  filePath: string;
  release(): Promise<void>;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertSeparatedDomainRoots(fieldRoot: string, testRoot: string): void {
  const field = path.resolve(fieldRoot);
  const test = path.resolve(testRoot);
  if (field === path.parse(field).root || test === path.parse(test).root) {
    throw new Error("RF Monitor data-domain roots cannot be a filesystem root");
  }
  if (isWithin(field, test) || isWithin(test, field)) {
    throw new Error("Field and test data roots must be separate, non-nested directories");
  }
}

export function createDataDomainPaths(input: {
  baseRoot: string;
  fieldRoot?: string;
  testRoot?: string;
  legacyBaselineFile: string;
}): DataDomainPaths {
  const baseRoot = path.resolve(input.baseRoot);
  if (baseRoot === path.parse(baseRoot).root) throw new Error("RF Monitor data base cannot be a filesystem root");
  const fieldRoot = path.resolve(input.fieldRoot ?? path.join(baseRoot, "field"));
  const testRoot = path.resolve(input.testRoot ?? path.join(baseRoot, "test"));
  assertSeparatedDomainRoots(fieldRoot, testRoot);
  if (isWithin(fieldRoot, baseRoot) || isWithin(testRoot, baseRoot)) {
    throw new Error("The data-domain control root must remain outside the field and test trees");
  }
  const entry = (root: string): DomainPathSet => ({
    root,
    evidenceRoot: path.join(root, "evidence"),
    baselineFile: path.join(root, "baselines", "baselines-v2.json"),
  });
  return {
    baseRoot,
    field: entry(fieldRoot),
    test: entry(testRoot),
    legacyBaselineFile: path.resolve(input.legacyBaselineFile),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeDurable(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

function safeOperationId(value: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error("Data operation ID is invalid");
  return value;
}

function testClearJournalPath(paths: DataDomainPaths): string {
  return path.join(path.resolve(paths.baseRoot), TEST_CLEAR_JOURNAL);
}

function baselineRestartJournalPath(paths: DataDomainPaths, domain: DataDomain): string {
  return path.join(path.resolve(paths.baseRoot), `baseline-restart-${domain}-operation.json`);
}

function parseBaselineRestartOperation(value: unknown, domain: DataDomain): BaselineRestartOperation {
  const input = value as Partial<BaselineRestartOperation>;
  if (!input || input.schemaVersion !== 1 || input.type !== "baseline-restart" || input.dataDomain !== domain) {
    throw new Error(`Baseline-restart ${domain} journal is invalid`);
  }
  const operationId = safeOperationId(String(input.operationId ?? ""));
  if (typeof input.targetId !== "string" || input.targetId.length < 1 || input.targetId.length > 256) throw new Error("Baseline-restart target is invalid");
  if (typeof input.fingerprintId !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprintId)) throw new Error("Baseline-restart fingerprint is invalid");
  if (!Number.isSafeInteger(input.expectedGeneration) || Number(input.expectedGeneration) <= 0
      || !Number.isSafeInteger(input.nextGeneration) || Number(input.nextGeneration) <= Number(input.expectedGeneration)) {
    throw new Error("Baseline-restart generation is invalid");
  }
  if (!Number.isSafeInteger(input.binCount) || Number(input.binCount) <= 0 || Number(input.binCount) > 8_192) {
    throw new Error("Baseline-restart FFT grid is invalid");
  }
  if (typeof input.actor !== "string" || input.actor.length < 1 || input.actor.length > 128) throw new Error("Baseline-restart actor is invalid");
  if (typeof input.preparedAt !== "string" || !Number.isFinite(Date.parse(input.preparedAt))) throw new Error("Baseline-restart timestamp is invalid");
  if (!["prepared", "baseline-committed", "runtime-reset", "audited"].includes(String(input.phase))) {
    throw new Error("Baseline-restart phase is invalid");
  }
  return {
    schemaVersion: 1,
    type: "baseline-restart",
    operationId,
    dataDomain: domain,
    targetId: input.targetId,
    fingerprintId: input.fingerprintId,
    expectedGeneration: Number(input.expectedGeneration),
    nextGeneration: Number(input.nextGeneration),
    binCount: Number(input.binCount),
    actor: input.actor,
    preparedAt: input.preparedAt,
    phase: input.phase as BaselineRestartPhase,
  };
}

export async function readBaselineRestartOperation(
  paths: DataDomainPaths,
  domain: DataDomain,
): Promise<BaselineRestartOperation | undefined> {
  const filePath = baselineRestartJournalPath(paths, domain);
  let details;
  try {
    details = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!details.isFile() || details.size <= 0 || details.size > CONTROL_RECORD_MAX_BYTES) {
    throw new Error(`Baseline-restart ${domain} journal exceeds its storage bound`);
  }
  try {
    return parseBaselineRestartOperation(JSON.parse(await readFile(filePath, "utf8")), domain);
  } catch (error) {
    throw new Error(`Baseline-restart ${domain} journal is unreadable; signal learning must remain Checking`, { cause: error });
  }
}

export async function writeBaselineRestartOperation(
  paths: DataDomainPaths,
  operation: BaselineRestartOperation,
): Promise<void> {
  const validated = parseBaselineRestartOperation(operation, operation.dataDomain);
  await writeAtomicJson(baselineRestartJournalPath(paths, operation.dataDomain), validated);
}

export async function removeBaselineRestartOperation(paths: DataDomainPaths, domain: DataDomain): Promise<void> {
  await removeDurable(baselineRestartJournalPath(paths, domain));
}

function expectedQuarantinePath(paths: DataDomainPaths, operationId: string): string {
  const testRoot = path.resolve(paths.test.root);
  return path.join(path.dirname(testRoot), `.${path.basename(testRoot)}.cleared-${operationId}`);
}

function parseTestClearJournal(value: unknown, paths: DataDomainPaths): TestClearJournal {
  const input = value as Partial<TestClearJournal>;
  if (!input || input.schemaVersion !== 1 || input.type !== "test-data-clear") throw new Error("Test-data clear journal is invalid");
  const operationId = safeOperationId(String(input.operationId ?? ""));
  const expectedRoot = path.resolve(paths.test.root);
  const expectedQuarantine = expectedQuarantinePath(paths, operationId);
  if (path.resolve(String(input.testRoot ?? "")) !== expectedRoot
      || path.resolve(String(input.quarantinePath ?? "")) !== expectedQuarantine) {
    throw new Error("Test-data clear journal does not match the configured test root");
  }
  if (!["prepared", "committed", "replacement-ready", "audited"].includes(String(input.phase))) {
    throw new Error("Test-data clear journal phase is invalid");
  }
  if (typeof input.actor !== "string" || input.actor.length < 1 || input.actor.length > 128) throw new Error("Test-data clear journal actor is invalid");
  if (typeof input.clearedAt !== "string" || !Number.isFinite(Date.parse(input.clearedAt))) throw new Error("Test-data clear journal timestamp is invalid");
  if (typeof input.previousDataPresent !== "boolean") throw new Error("Test-data clear journal data-presence flag is invalid");
  return {
    schemaVersion: 1,
    type: "test-data-clear",
    operationId,
    actor: input.actor,
    clearedAt: input.clearedAt,
    previousDataPresent: input.previousDataPresent,
    testRoot: expectedRoot,
    quarantinePath: expectedQuarantine,
    phase: input.phase as TestClearPhase,
  };
}

async function readTestClearJournal(paths: DataDomainPaths): Promise<TestClearJournal | undefined> {
  const filePath = testClearJournalPath(paths);
  let details;
  try {
    details = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!details.isFile() || details.size <= 0 || details.size > CONTROL_RECORD_MAX_BYTES) {
    throw new Error("Test-data clear journal exceeds its storage bound");
  }
  try {
    return parseTestClearJournal(JSON.parse(await readFile(filePath, "utf8")), paths);
  } catch (error) {
    throw new Error("Test-data clear journal is unreadable; refusing to choose a test-data tree", { cause: error });
  }
}

async function writeTestClearJournal(paths: DataDomainPaths, journal: TestClearJournal): Promise<void> {
  await writeAtomicJson(testClearJournalPath(paths), journal);
}

async function invokeFault(options: ClearTestDataOptions, point: ClearTestDataFaultPoint): Promise<void> {
  await options.injectFault?.(point);
}

async function writeTestGeneration(testRoot: string, operationId: string, clearedAt: string): Promise<void> {
  await writeAtomicJson(path.join(testRoot, TEST_CLEAR_GENERATION), {
    schemaVersion: 1,
    dataDomain: "test",
    clearOperationId: operationId,
    activatedAt: clearedAt,
  });
}

async function replacementMatches(testRoot: string, operationId: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path.join(testRoot, TEST_CLEAR_GENERATION), "utf8")) as Record<string, unknown>;
    return marker.schemaVersion === 1 && marker.dataDomain === "test" && marker.clearOperationId === operationId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureReplacement(journal: TestClearJournal): Promise<void> {
  const rootPresent = await exists(journal.testRoot);
  if (rootPresent) {
    if (!await replacementMatches(journal.testRoot, journal.operationId)) {
      throw new Error("Interrupted test-data clear found an unverified replacement tree; refusing to select it");
    }
    await ensureDomainRoot(journal.testRoot, "test");
    return;
  }
  const staging = path.join(
    path.dirname(journal.testRoot),
    `.${path.basename(journal.testRoot)}.replacement-${journal.operationId}`,
  );
  // This exact staging path is tied to the durable operation ID. It can never
  // contain the old tree (which has a different exact quarantine path).
  await rm(staging, { recursive: true, force: true });
  await ensureDomainRoot(staging, "test");
  await writeTestGeneration(staging, journal.operationId, journal.clearedAt);
  await syncDirectory(staging);
  await rename(staging, journal.testRoot);
  await syncDirectory(path.dirname(journal.testRoot));
}

function markerPayload(domain: DataDomain): string {
  return `${JSON.stringify({
    schemaVersion: DOMAIN_MARKER_SCHEMA,
    product: "rf-monitor",
    dataDomain: domain,
  }, null, 2)}\n`;
}

/**
 * Establishes an on-disk trust boundary. A directory previously marked for the
 * other domain is never reused, even when it is empty.
 */
export async function ensureDomainRoot(root: string, domain: DataDomain): Promise<void> {
  const resolved = path.resolve(root);
  const rootDetails = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootDetails?.isSymbolicLink()) throw new Error(`${domain} data root cannot be a symbolic link`);
  if (rootDetails && !rootDetails.isDirectory()) throw new Error(`${domain} data root must be a directory`);
  await mkdir(resolved, { recursive: true });
  const markerPath = path.join(resolved, DOMAIN_MARKER);
  const expected = markerPayload(domain);
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== DOMAIN_MARKER_SCHEMA || parsed.product !== "rf-monitor" || parsed.dataDomain !== domain) {
      throw new Error(`${domain} data root carries a conflicting domain marker`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(markerPath, "wx", 0o640);
  try {
    await handle.writeFile(expected, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function activeLease(root: string): Promise<{ pid: number; domain: DataDomain } | undefined> {
  const leasePath = path.join(path.resolve(root), DOMAIN_LEASE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(leasePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Data-domain lease is unreadable: ${leasePath}`, { cause: error });
  }
  const lease = parsed as { pid?: unknown; dataDomain?: unknown };
  if (!Number.isSafeInteger(lease.pid) || (lease.pid as number) <= 0 || !["field", "test"].includes(String(lease.dataDomain))) {
    throw new Error(`Data-domain lease is invalid: ${leasePath}`);
  }
  try {
    process.kill(lease.pid as number, 0);
    return { pid: lease.pid as number, domain: lease.dataDomain as DataDomain };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    await rm(leasePath, { force: true });
    return undefined;
  }
}

export async function acquireDataDomainLease(root: string, domain: DataDomain): Promise<DataDomainLease> {
  await ensureDomainRoot(root, domain);
  const resolved = path.resolve(root);
  const leasePath = path.join(resolved, DOMAIN_LEASE);
  const current = await activeLease(resolved);
  if (current) throw new Error(`${current.domain} data is already active in process ${current.pid}`);
  const handle = await open(leasePath, "wx", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, dataDomain: domain, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let released = false;
  return {
    domain,
    filePath: leasePath,
    async release() {
      if (released) return;
      released = true;
      const currentContents = await readFile(leasePath, "utf8").catch(() => "");
      let ownerPid: number | undefined;
      try { ownerPid = Number((JSON.parse(currentContents) as { pid?: unknown }).pid); } catch { /* fail closed below */ }
      if (ownerPid !== process.pid) throw new Error("Data-domain lease ownership changed; refusing to remove it");
      await rm(leasePath, { force: true });
    },
  };
}

/**
 * Reads only bounded metadata from the old unscoped store. The original file
 * is deliberately untouched: it may contain a mixture of field and simulation
 * learning and therefore can be retained for audit but never selected.
 */
export async function inspectLegacyBaseline(filePath: string): Promise<LegacyBaselineQuarantine> {
  const sourcePath = path.resolve(filePath);
  let details;
  try {
    details = await stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "none", sourcePath };
    throw error;
  }
  if (!details.isFile() || details.size <= 0 || details.size > MAX_LEGACY_BASELINE_BYTES) {
    return { state: "ignored", sourcePath, reason: "unreadable-unscoped-data-domain", bytes: details.size };
  }
  const contents = await readFile(sourcePath);
  let recordCount: number | undefined;
  let reason: LegacyBaselineQuarantine["reason"] = "unscoped-data-domain";
  try {
    const parsed = JSON.parse(contents.toString("utf8")) as { records?: unknown };
    if (Array.isArray(parsed.records)) recordCount = parsed.records.length;
    else reason = "unreadable-unscoped-data-domain";
  } catch {
    reason = "unreadable-unscoped-data-domain";
  }
  return {
    state: "ignored",
    sourcePath,
    reason,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.byteLength,
    recordCount,
  };
}

/** A control-plane audit is outside both trust-domain trees and is fsynced before return. */
export async function appendDomainMaintenanceAudit(paths: DataDomainPaths, entry: object): Promise<void> {
  const baseRoot = path.resolve(paths.baseRoot);
  await mkdir(baseRoot, { recursive: true });
  const auditPath = path.join(baseRoot, CONTROL_AUDIT);
  const handle = await open(auditPath, "a", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(baseRoot);
}

function clearResult(
  journal: TestClearJournal,
  state: ClearedTestData["state"],
  options: { cleanupPending: boolean; auditDurable: boolean; recoveryReason?: string },
): ClearedTestData {
  return {
    domain: "test",
    operationId: journal.operationId,
    clearedAt: journal.clearedAt,
    previousDataPresent: journal.previousDataPresent,
    committed: true,
    state,
    cleanupPending: options.cleanupPending,
    auditDurable: options.auditDurable,
    recoveryReason: options.recoveryReason,
  };
}

async function completeCommittedTestClear(
  paths: DataDomainPaths,
  journal: TestClearJournal,
  options: ClearTestDataOptions,
): Promise<ClearedTestData> {
  try {
    if (journal.phase === "committed") {
      await invokeFault(options, "before-replacement-create");
      await ensureReplacement(journal);
      journal = { ...journal, phase: "replacement-ready" };
      await writeTestClearJournal(paths, journal);
    } else if (journal.phase === "replacement-ready" || journal.phase === "audited") {
      await ensureReplacement(journal);
    }

    if (journal.phase === "replacement-ready") {
      await invokeFault(options, "before-cleanup");
      await rm(journal.quarantinePath, { recursive: true, force: true });
      await syncDirectory(path.dirname(journal.quarantinePath));
      await invokeFault(options, "after-cleanup");
      await invokeFault(options, "before-completion-audit");
      await appendDomainMaintenanceAudit(paths, {
        type: "test-data-cleared",
        operationId: journal.operationId,
        actor: journal.actor,
        domain: "test",
        clearedAt: journal.clearedAt,
        previousDataPresent: journal.previousDataPresent,
        committed: true,
      });
      journal = { ...journal, phase: "audited" };
      await writeTestClearJournal(paths, journal);
    }

    await invokeFault(options, "before-journal-cleanup");
    await removeDurable(testClearJournalPath(paths));
    return clearResult(journal, "complete", { cleanupPending: false, auditDurable: true });
  } catch (error) {
    const cleanupPending = await exists(journal.quarantinePath).catch(() => true);
    return clearResult(journal, "recovery-required", {
      cleanupPending,
      auditDurable: journal.phase === "audited",
      recoveryReason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function abortPreparedTestClear(paths: DataDomainPaths, journal: TestClearJournal, reason: unknown): Promise<void> {
  await appendDomainMaintenanceAudit(paths, {
    type: "test-data-clear-aborted",
    operationId: journal.operationId,
    actor: journal.actor,
    domain: "test",
    reason: reason instanceof Error ? reason.message : String(reason),
  }).catch(() => undefined);
  await removeDurable(testClearJournalPath(paths)).catch(() => undefined);
}

/**
 * Repairs one journaled clear before any test-domain lease or store is opened.
 * The exact quarantine name in the durable journal is the only old tree which
 * may be discarded. An unreadable or inconsistent record fails closed.
 */
export async function repairInterruptedTestClear(
  paths: DataDomainPaths,
  options: ClearTestDataOptions = {},
): Promise<TestClearRecovery> {
  assertSeparatedDomainRoots(paths.field.root, paths.test.root);
  const journal = await readTestClearJournal(paths);
  if (!journal) return { found: false, committed: false };
  const lease = await activeLease(journal.testRoot);
  if (lease) throw new Error(`Cannot repair test data while it is active in process ${lease.pid}`);
  const quarantinePresent = await exists(journal.quarantinePath);
  const testPresent = await exists(journal.testRoot);

  if (journal.phase === "prepared" && !quarantinePresent) {
    if (!testPresent && journal.previousDataPresent) {
      throw new Error("Interrupted test-data clear is ambiguous: the original test tree and its quarantine are both missing");
    }
    await appendDomainMaintenanceAudit(paths, {
      type: "test-data-clear-aborted",
      operationId: journal.operationId,
      actor: journal.actor,
      domain: "test",
      reason: "commit-not-reached",
    });
    await removeDurable(testClearJournalPath(paths));
    return { found: true, committed: false };
  }

  // A prepared journal plus its exact quarantine proves rename committed even
  // if the process died before persisting the next phase.
  const committedJournal = journal.phase === "prepared" ? { ...journal, phase: "committed" as const } : journal;
  if (journal.phase === "prepared") await writeTestClearJournal(paths, committedJournal);
  const result = await completeCommittedTestClear(paths, committedJournal, options);
  if (result.state !== "complete") {
    throw new Error(`Interrupted test-data clear ${result.operationId} still requires recovery: ${result.recoveryReason ?? "unknown failure"}`);
  }
  return { found: true, committed: true, result };
}

/**
 * Clears only the test trust domain. The directory rename is the destructive
 * commit point. Errors before it reject without changing the original tree;
 * errors after it return an explicit committed/recovery-required result.
 */
export async function clearTestDomain(
  paths: DataDomainPaths,
  actorOrOptions: string | ClearTestDataOptions = "settings-admin",
): Promise<ClearedTestData> {
  const options: ClearTestDataOptions = typeof actorOrOptions === "string" ? { actor: actorOrOptions } : actorOrOptions;
  const actor = options.actor ?? "settings-admin";
  assertSeparatedDomainRoots(paths.field.root, paths.test.root);
  const testRoot = path.resolve(paths.test.root);
  if (testRoot !== path.join(path.resolve(paths.baseRoot), "test")
      && !path.basename(testRoot).toLowerCase().includes("test")) {
    throw new Error("Refusing to clear a test-data root whose final path component is not explicitly test-scoped");
  }

  const pending = await readTestClearJournal(paths);
  if (pending) {
    try {
      const repaired = await repairInterruptedTestClear(paths, options);
      if (repaired.committed && repaired.result) return repaired.result;
    } catch (error) {
      const quarantinePresent = await exists(pending.quarantinePath).catch(() => true);
      if (pending.phase !== "prepared" || quarantinePresent) {
        return clearResult(pending, "recovery-required", {
          cleanupPending: quarantinePresent,
          auditDurable: pending.phase === "audited",
          recoveryReason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }
  const lease = await activeLease(testRoot);
  if (lease) throw new Error(`Test data is active in process ${lease.pid}; stop the test runtime before clearing it`);

  const operationId = safeOperationId(options.operationId ?? randomUUID());
  const previousDataPresent = await exists(testRoot);
  let journal: TestClearJournal = {
    schemaVersion: 1,
    type: "test-data-clear",
    operationId,
    actor,
    clearedAt: (options.now?.() ?? new Date()).toISOString(),
    previousDataPresent,
    testRoot,
    quarantinePath: expectedQuarantinePath(paths, operationId),
    phase: "prepared",
  };
  if (await exists(journal.quarantinePath)) throw new Error("Test-data clear quarantine already exists");

  await writeTestClearJournal(paths, journal);
  try {
    await invokeFault(options, "before-prepared-audit");
    await appendDomainMaintenanceAudit(paths, {
      type: "test-data-clear-prepared",
      operationId,
      actor,
      domain: "test",
      previousDataPresent,
    });
    if (previousDataPresent) await invokeFault(options, "before-commit-rename");
  } catch (error) {
    await abortPreparedTestClear(paths, journal, error);
    throw error;
  }

  if (previousDataPresent) {
    try {
      await rename(testRoot, journal.quarantinePath);
    } catch (error) {
      await abortPreparedTestClear(paths, journal, error);
      throw error;
    }
    // From this line onward callers must never receive a generic failure.
    try {
      await invokeFault(options, "after-commit-rename");
      await syncDirectory(path.dirname(testRoot));
      journal = { ...journal, phase: "committed" };
      await writeTestClearJournal(paths, journal);
    } catch (error) {
      return clearResult(journal, "recovery-required", {
        cleanupPending: true,
        auditDurable: false,
        recoveryReason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    journal = { ...journal, phase: "committed" };
    await writeTestClearJournal(paths, journal);
  }

  return completeCommittedTestClear(paths, journal, options);
}
