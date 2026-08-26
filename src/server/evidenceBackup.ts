import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DataDomain } from "../shared/types";
import { verifyEvidenceDirectory, type EvidenceVerificationOutcome } from "./evidenceVerifier";

const MAX_FILES = 200_000;
const MAX_PATH_BYTES = 768;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_PARTIALS = 128;
const COPY_OVERHEAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MINIMUM_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const AUDIT_RETAIN_BYTES = 1024 * 1024;
const MAX_AUDIT_RECORD_BYTES = 64 * 1024;
const MAX_AUDIT_LOCK_BYTES = 4 * 1024;
// A durable audit rotation includes file and directory fsync. Under production
// disk pressure that can legitimately exceed five seconds, so concurrent
// writers receive a bounded 30-second serialization window before failing.
const AUDIT_LOCK_WAIT_MS = 30_000;
const AUDIT_LOCK_RETRY_MS = 25;
const AUDIT_LOCK_STALE_MS = 60_000;
const AUDIT_LOCK_HARD_STALE_MS = 10 * 60_000;
const BACKUP_MANIFEST = "backup-manifest.json";
const BACKUP_SUMS = "SHA256SUMS.txt";
const BACKUP_DESCRIPTOR = "backup-package.json";
const RESTORE_DESCRIPTOR = ".rf-monitor-restore.json";
const RESTORE_PARTIAL_DESCRIPTOR = ".rf-monitor-restore-partial.json";
const SECRET_NAME = /(^|\/)(?:admin\.json(?:[.-][^/]*)?|\.env(?:\.[^/]*)?|[^/]*credential[^/]*|[^/]*password[^/]*|[^/]*secret[^/]*|[^/]*private[^/]*|[^/]*\.(?:key|pem|p12|pfx))$/i;
const CONFIG_ALLOWED = /^(?:(?:operational\.json|config-audit\.jsonl|catalog\.json|production-qualification\.json)|(?:revisions|qualification|baselines)\/.*)$/;

export type BackupOutcome = "PASS" | "INCOMPLETE" | "FAIL";
export type BackupOperationState = "planned" | "complete" | "incomplete" | "refused" | "recovery-required";
export type BackupFaultPoint = "after-copy" | "after-manifest" | "after-publish" | "restore-after-copy" | "restore-after-publish";

export interface BackupConfigRoot {
  label: string;
  path: string;
}

export interface BackupFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupEvidenceEntry {
  path: string;
  dataDomain: DataDomain;
  outcome: EvidenceVerificationOutcome;
  reasons: string[];
}

export interface BackupManifest {
  schemaVersion: 1;
  backupId: string;
  createdAt: string;
  hashAlgorithm: "SHA-256";
  sourceContentSha256: string;
  dataDomains: DataDomain[];
  files: BackupFileEntry[];
  evidence: BackupEvidenceEntry[];
  excludedSecretPaths: string[];
  excludedConfigPaths: string[];
  complete: boolean;
}

export interface BackupResult {
  schemaVersion: 1;
  operation: "create" | "verify" | "restore" | "status";
  state: BackupOperationState;
  outcome: BackupOutcome;
  backupId?: string;
  backupPath?: string;
  restorePath?: string;
  files: number;
  bytes: number;
  evidencePackages: number;
  incompleteEvidence: number;
  excludedSecrets: number;
  excludedConfigFiles: number;
  recoveredPartials: number;
  pendingPartials: number;
  idempotent: boolean;
  auditDurable: boolean;
  reasons: string[];
  sourceContentSha256?: string;
  manifestSha256?: string;
  availableBytes?: number;
  requiredBytes?: number;
  minimumFreeBytes?: number;
}

export interface BackupCreateOptions {
  dataRoot: string;
  configRoots: BackupConfigRoot[];
  destinationRoot: string;
  backupId: string;
  minimumFreeBytes?: number;
  dryRun?: boolean;
  recover?: boolean;
  now?: () => Date;
  availableBytes?: (directory: string) => Promise<number>;
  faultInjector?: (point: BackupFaultPoint) => void | Promise<void>;
}

export interface BackupRestoreOptions {
  backupPath: string;
  destinationPath: string;
  minimumFreeBytes?: number;
  dryRun?: boolean;
  recover?: boolean;
  now?: () => Date;
  availableBytes?: (directory: string) => Promise<number>;
  faultInjector?: (point: BackupFaultPoint) => void | Promise<void>;
}

export interface BackupVerifyOptions {
  expectedBackupId?: string;
}

interface SourceFile extends BackupFileEntry {
  sourcePath: string;
}

interface BackupPlan {
  manifest: BackupManifest;
  sourceFiles: SourceFile[];
}

interface HeldAuditLock {
  path: string;
  device: number;
  inode: number;
  nonce: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeBackupId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) throw new Error("backup-id-invalid");
  return value;
}

function safeLabel(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error("config-label-invalid");
  return value;
}

function requireAbsolutePath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`path-must-be-absolute:${value}`);
  return path.resolve(value);
}

function refuseFilesystemRoot(value: string, label: string): string {
  if (value === path.parse(value).root) throw new Error(`${label}-filesystem-root-refused`);
  return value;
}

function portable(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function pathWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePortable(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\") || /[\0\r\n]/.test(relativePath)) {
    throw new Error(`backup-path-invalid:${relativePath || "<empty>"}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`backup-path-invalid:${relativePath}`);
  const resolved = path.resolve(root, ...segments);
  if (!pathWithin(root, resolved) || resolved === path.resolve(root)) throw new Error(`backup-path-escape:${relativePath}`);
  return resolved;
}

async function assertNoSymlinkComponents(absolutePath: string, requireDirectory: boolean): Promise<void> {
  if (!path.isAbsolute(absolutePath)) throw new Error(`path-must-be-absolute:${absolutePath}`);
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error(`symlink-path-refused:${current}`);
  }
  const final = await lstat(resolved);
  if (final.isSymbolicLink()) throw new Error(`symlink-path-refused:${resolved}`);
  if (requireDirectory && !final.isDirectory()) throw new Error(`directory-required:${resolved}`);
}

async function assertParentNoSymlink(absolutePath: string): Promise<void> {
  if (!path.isAbsolute(absolutePath)) throw new Error(`path-must-be-absolute:${absolutePath}`);
  await assertNoSymlinkComponents(path.dirname(path.resolve(absolutePath)), true);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`regular-file-required:${filePath}`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.byteLength;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTreeDirectories(root: string): Promise<void> {
  const directories = [root];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`symlink-staging-refused:${path.join(current, entry.name)}`);
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      directories.push(child);
      pending.push(child);
      if (directories.length > MAX_FILES) throw new Error("backup-directory-count-bound");
    }
  }
  for (const directory of directories.sort((left, right) => right.length - left.length)) await syncDirectory(directory);
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function walkRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink-source-refused:${absolute}`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(portable(path.relative(root, absolute)));
      else throw new Error(`non-regular-source-refused:${absolute}`);
      if (files.length + pending.length > MAX_FILES) throw new Error("backup-file-count-bound");
    }
  }
  return files.sort();
}

async function availableBytes(directoryPath: string): Promise<number> {
  const details = await statfs(directoryPath);
  const bytes = BigInt(details.bavail) * BigInt(details.bsize);
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

function sourceCommitment(files: readonly BackupFileEntry[]): string {
  return sha256Text([...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((entry) => `${entry.sha256} ${entry.bytes} ${entry.path}\n`).join(""));
}

function totalBytes(files: readonly BackupFileEntry[]): number {
  let total = 0;
  for (const entry of files) {
    total += entry.bytes;
    if (!Number.isSafeInteger(total)) throw new Error("backup-byte-count-bound");
  }
  return total;
}

function requiredCapacity(payloadBytes: number, minimumFreeBytes: number): number {
  const required = payloadBytes + minimumFreeBytes + COPY_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(required)) throw new Error("backup-capacity-count-bound");
  return required;
}

async function readBoundedJson(filePath: string, maximumBytes: number): Promise<Record<string, unknown>> {
  const contents = await readBoundedText(filePath, maximumBytes);
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`metadata-json-invalid:${path.basename(filePath)}`);
  }
  if (!record(value)) throw new Error(`metadata-object-required:${path.basename(filePath)}`);
  return value;
}

async function readBoundedText(filePath: string, maximumBytes: number): Promise<string> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) throw new Error(`metadata-size-bound:${path.basename(filePath)}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function validateManifest(value: Record<string, unknown>): BackupManifest {
  if (value.schemaVersion !== 1 || typeof value.backupId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.backupId)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || value.hashAlgorithm !== "SHA-256"
    || typeof value.sourceContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceContentSha256)
    || !Array.isArray(value.dataDomains) || value.dataDomains.length !== 2 || value.dataDomains[0] !== "field" || value.dataDomains[1] !== "test"
    || !Array.isArray(value.files) || value.files.length > MAX_FILES
    || !Array.isArray(value.evidence) || value.evidence.length > MAX_FILES
    || !Array.isArray(value.excludedSecretPaths) || value.excludedSecretPaths.length > MAX_FILES
    || !Array.isArray(value.excludedConfigPaths) || value.excludedConfigPaths.length > MAX_FILES
    || typeof value.complete !== "boolean") throw new Error("backup-manifest-invalid");
  const seen = new Set<string>();
  let previousPath = "";
  for (const candidate of value.files) {
    if (!record(candidate) || typeof candidate.path !== "string" || Buffer.byteLength(candidate.path) > MAX_PATH_BYTES
      || !Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) < 0
      || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) throw new Error("backup-file-entry-invalid");
    resolvePortable("/backup-validation", candidate.path);
    validatePackagedPath(candidate.path);
    if (seen.has(candidate.path) || candidate.path === BACKUP_MANIFEST || candidate.path === BACKUP_SUMS) throw new Error(`backup-file-entry-duplicate:${candidate.path}`);
    if (previousPath && candidate.path <= previousPath) throw new Error("backup-file-entries-not-sorted");
    seen.add(candidate.path);
    previousPath = candidate.path;
  }
  const evidencePaths = new Set<string>();
  for (const candidate of value.evidence) {
    if (!record(candidate) || typeof candidate.path !== "string" || Buffer.byteLength(candidate.path) > MAX_PATH_BYTES
      || (candidate.dataDomain !== "field" && candidate.dataDomain !== "test")
      || (candidate.outcome !== "PASS" && candidate.outcome !== "INCOMPLETE")
      || !Array.isArray(candidate.reasons) || candidate.reasons.some((reason) => typeof reason !== "string" || reason.length > 512)) {
      throw new Error("backup-evidence-entry-invalid");
    }
    resolvePortable("/backup-validation", candidate.path);
    if (evidencePaths.has(candidate.path)) throw new Error(`backup-evidence-entry-duplicate:${candidate.path}`);
    if (domainForBackupPath(candidate.path) !== candidate.dataDomain) throw new Error(`backup-evidence-domain-mismatch:${candidate.path}`);
    evidencePaths.add(candidate.path);
  }
  const discoveredEvidence = new Set<string>();
  for (const filePath of seen) {
    const match = filePath.match(/^(payload\/data\/(?:field|test)\/(?:.*\/)?evidence\/session-[^/]+)\//);
    if (match) discoveredEvidence.add(match[1]);
  }
  if (discoveredEvidence.size !== evidencePaths.size || [...discoveredEvidence].some((entry) => !evidencePaths.has(entry))) {
    throw new Error("backup-evidence-inventory-mismatch");
  }
  const excluded = new Set<string>();
  for (const candidate of value.excludedSecretPaths) {
    if (typeof candidate !== "string" || Buffer.byteLength(candidate) > MAX_PATH_BYTES) throw new Error("backup-secret-entry-invalid");
    resolvePortable("/backup-validation", candidate);
    const relative = candidate.match(/^payload\/(?:data\/(?:field|test)|config\/[a-z][a-z0-9-]{0,47})\/(.+)$/)?.[1];
    if (!relative || !SECRET_NAME.test(relative) || seen.has(candidate) || excluded.has(candidate)) throw new Error("backup-secret-entry-invalid");
    excluded.add(candidate);
  }
  for (const candidate of value.excludedConfigPaths) {
    if (typeof candidate !== "string" || Buffer.byteLength(candidate) > MAX_PATH_BYTES) throw new Error("backup-config-exclusion-entry-invalid");
    resolvePortable("/backup-validation", candidate);
    const relative = candidate.match(/^payload\/config\/[a-z][a-z0-9-]{0,47}\/(.+)$/)?.[1];
    if (!relative || CONFIG_ALLOWED.test(relative) || SECRET_NAME.test(relative) || seen.has(candidate) || excluded.has(candidate)) {
      throw new Error("backup-config-exclusion-entry-invalid");
    }
    excluded.add(candidate);
  }
  const manifest = value as unknown as BackupManifest;
  totalBytes(manifest.files);
  if (sourceCommitment(manifest.files) !== manifest.sourceContentSha256) throw new Error("backup-source-commitment-mismatch");
  if (manifest.complete !== manifest.evidence.every((entry) => entry.outcome === "PASS")) throw new Error("backup-completeness-mismatch");
  return manifest;
}

function domainForBackupPath(filePath: string): DataDomain | undefined {
  if (filePath.startsWith("payload/data/field/")) return "field";
  if (filePath.startsWith("payload/data/test/")) return "test";
  return undefined;
}

function validatePackagedPath(filePath: string): void {
  const data = filePath.match(/^payload\/data\/(field|test)\/(.+)$/);
  if (data) {
    if (SECRET_NAME.test(data[2])) throw new Error(`backup-secret-content-refused:${filePath}`);
    return;
  }
  const config = filePath.match(/^payload\/config\/([a-z][a-z0-9-]{0,47})\/(.+)$/);
  if (config && CONFIG_ALLOWED.test(config[2]) && !SECRET_NAME.test(config[2])) return;
  throw new Error(`backup-file-scope-invalid:${filePath}`);
}

async function validateDomainMarkers(root: string, manifest: BackupManifest): Promise<void> {
  for (const domain of manifest.dataDomains) {
    const markerPath = path.join(root, "payload", "data", domain, ".rf-monitor-data-domain.json");
    if (!(await exists(markerPath))) throw new Error(`domain-marker-missing:${domain}`);
    const marker = await readBoundedJson(markerPath, 64 * 1024);
    if (marker.dataDomain !== domain && marker.domain !== domain) throw new Error(`domain-marker-mismatch:${domain}`);
  }
}

async function planBackup(options: BackupCreateOptions): Promise<BackupPlan> {
  const dataRoot = refuseFilesystemRoot(requireAbsolutePath(options.dataRoot), "source");
  const destinationRoot = refuseFilesystemRoot(requireAbsolutePath(options.destinationRoot), "destination");
  await assertNoSymlinkComponents(dataRoot, true);
  await assertNoSymlinkComponents(destinationRoot, true);
  if (pathWithin(dataRoot, destinationRoot) || pathWithin(destinationRoot, dataRoot)) throw new Error("source-destination-must-be-separate");
  if (!options.configRoots.length || options.configRoots.length > 32) throw new Error("config-root-count-bound");
  const labels = new Set<string>();
  const configRoots = options.configRoots.map((config) => ({
    label: safeLabel(config.label),
    path: refuseFilesystemRoot(requireAbsolutePath(config.path), "config-source"),
  }));
  for (const config of configRoots) {
    if (labels.has(config.label)) throw new Error(`config-label-duplicate:${config.label}`);
    labels.add(config.label);
    await assertNoSymlinkComponents(config.path, true);
    if (pathWithin(config.path, destinationRoot) || pathWithin(destinationRoot, config.path)) throw new Error("source-destination-must-be-separate");
  }
  const dataDomains: DataDomain[] = [];
  for (const domain of ["field", "test"] as const) {
    const domainRoot = path.join(dataRoot, domain);
    await assertNoSymlinkComponents(domainRoot, true);
    if (await exists(path.join(domainRoot, ".rf-monitor-active.json"))) throw new Error(`active-domain-refused:${domain}`);
    const marker = await readBoundedJson(path.join(domainRoot, ".rf-monitor-data-domain.json"), 64 * 1024);
    if (marker.dataDomain !== domain && marker.domain !== domain) throw new Error(`domain-marker-mismatch:${domain}`);
    dataDomains.push(domain);
  }

  const excludedSecretPaths: string[] = [];
  const excludedConfigPaths: string[] = [];
  const sourceFiles: SourceFile[] = [];
  const addRoot = async (sourceRoot: string, prefix: string, configAllowlist: boolean) => {
    for (const relativePath of await walkRegularFiles(sourceRoot)) {
      const outputPath = `${prefix}/${relativePath}`;
      if (Buffer.byteLength(outputPath) > MAX_PATH_BYTES) throw new Error(`backup-path-length-bound:${outputPath.slice(0, 128)}`);
      if (SECRET_NAME.test(relativePath)) {
        excludedSecretPaths.push(outputPath);
        if (sourceFiles.length + excludedSecretPaths.length + excludedConfigPaths.length > MAX_FILES) throw new Error("backup-file-count-bound");
        continue;
      }
      if (configAllowlist && !CONFIG_ALLOWED.test(relativePath)) {
        excludedConfigPaths.push(outputPath);
        if (sourceFiles.length + excludedSecretPaths.length + excludedConfigPaths.length > MAX_FILES) throw new Error("backup-file-count-bound");
        continue;
      }
      const sourcePath = resolvePortable(sourceRoot, relativePath);
      const details = await lstat(sourcePath);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error(`source-file-changed:${outputPath}`);
      const digest = await sha256File(sourcePath);
      sourceFiles.push({ path: outputPath, sourcePath, ...digest });
      if (sourceFiles.length + excludedSecretPaths.length + excludedConfigPaths.length > MAX_FILES) throw new Error("backup-file-count-bound");
    }
  };
  await addRoot(dataRoot, "payload/data", false);
  for (const config of configRoots) await addRoot(config.path, `payload/config/${config.label}`, true);
  sourceFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const sessionRoots = new Map<string, { sourcePath: string; dataDomain: DataDomain }>();
  for (const file of sourceFiles) {
    const match = file.path.match(/^(payload\/data\/(field|test)\/(?:.*\/)?evidence\/(session-[^/]+))\//);
    if (!match) continue;
    const sessionBackupPath = match[1];
    if (!sessionRoots.has(sessionBackupPath)) {
      const relativeToData = sessionBackupPath.slice("payload/data/".length);
      sessionRoots.set(sessionBackupPath, {
        sourcePath: resolvePortable(dataRoot, relativeToData),
        dataDomain: match[2] as DataDomain,
      });
    }
  }
  const evidence: BackupEvidenceEntry[] = [];
  for (const [backupPath, session] of [...sessionRoots].sort(([left], [right]) => left.localeCompare(right))) {
    const descriptorPath = path.join(session.sourcePath, "session.json");
    if (await exists(descriptorPath)) {
      const descriptor = await readBoundedJson(descriptorPath, 2 * 1024 * 1024);
      if (descriptor.lifecycle === "Active" || descriptor.lifecycle === "Finalizing" || descriptor.status === "recording") {
        throw new Error(`unfinalized-session-refused:${backupPath}`);
      }
    }
    const verification = await verifyEvidenceDirectory(session.sourcePath, { expectedDataDomain: session.dataDomain });
    evidence.push({
      path: backupPath,
      dataDomain: session.dataDomain,
      outcome: verification.outcome,
      reasons: verification.reasons.slice(0, 32).map((reason) => reason.slice(0, 512)),
    });
  }
  const failed = evidence.filter((entry) => entry.outcome === "FAIL");
  if (failed.length) throw new Error(`source-evidence-failed:${failed.map((entry) => entry.path).slice(0, 8).join(",")}`);
  const fileEntries = sourceFiles.map(({ sourcePath: _sourcePath, ...entry }) => entry);
  const manifest: BackupManifest = {
    schemaVersion: 1,
    backupId: safeBackupId(options.backupId),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    hashAlgorithm: "SHA-256",
    sourceContentSha256: sourceCommitment(fileEntries),
    dataDomains,
    files: fileEntries,
    evidence,
    excludedSecretPaths: excludedSecretPaths.sort(),
    excludedConfigPaths: excludedConfigPaths.sort(),
    complete: evidence.every((entry) => entry.outcome === "PASS"),
  };
  return { manifest, sourceFiles };
}

async function copyHashed(source: string, destination: string, expected: BackupFileEntry): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.byteLength;
      callback(null, buffer);
    },
  });
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await sourceHandle.stat();
    if (!details.isFile()) throw new Error(`source-not-regular:${expected.path}`);
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      hashing,
      createWriteStream(destination, { flags: "wx", mode: 0o640 }),
    );
  } finally {
    await sourceHandle.close();
  }
  const handle = await open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new Error(`source-changed-during-copy:${expected.path}`);
}

async function removeRecoveredPartials(
  parent: string,
  prefix: string,
  recover: boolean,
  dryRun: boolean,
  validateOwner: (partialPath: string) => Promise<void>,
): Promise<{ recovered: number; pending: number }> {
  const entries = (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.name.startsWith(prefix) && entry.name.includes(".partial-"));
  if (entries.length > MAX_PARTIALS) throw new Error("backup-partial-count-bound");
  if (entries.length && !recover) throw new Error("interrupted-partial-present-use-recover");
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`unowned-partial-refused:${entry.name}`);
    const target = path.join(parent, entry.name);
    if (!pathWithin(parent, target) || target === path.resolve(parent)) throw new Error("partial-path-escape");
    await validateOwner(target);
    if (!dryRun) await rm(target, { recursive: true, force: true });
  }
  if (entries.length && !dryRun) await syncDirectory(parent);
  return { recovered: dryRun ? 0 : entries.length, pending: dryRun ? entries.length : 0 };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function inspectAuditLock(lockPath: string): Promise<{ device: number; inode: number; recoverable: boolean }> {
  const handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    const ownedMode = details.isFile() && details.nlink === 1 && (details.mode & 0o077) === 0
      && (typeof process.geteuid !== "function" || details.uid === process.geteuid());
    if (!ownedMode) throw new Error("backup-audit-lock-invalid");
    const fileAgeMs = Date.now() - details.mtimeMs;
    if (details.size <= 0 || details.size > MAX_AUDIT_LOCK_BYTES) {
      return {
        device: details.dev,
        inode: details.ino,
        recoverable: fileAgeMs > AUDIT_LOCK_HARD_STALE_MS,
      };
    }
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(await handle.readFile("utf8"));
    } catch {
      return {
        device: details.dev,
        inode: details.ino,
        recoverable: fileAgeMs > AUDIT_LOCK_HARD_STALE_MS,
      };
    }
    if (!record(descriptor) || descriptor.schemaVersion !== 1 || descriptor.type !== "rf-monitor-backup-audit-lock"
      || !Number.isSafeInteger(descriptor.pid) || (descriptor.pid as number) <= 0
      || typeof descriptor.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(descriptor.nonce)
      || typeof descriptor.createdAt !== "string" || !Number.isFinite(Date.parse(descriptor.createdAt))) {
      return {
        device: details.dev,
        inode: details.ino,
        recoverable: fileAgeMs > AUDIT_LOCK_HARD_STALE_MS,
      };
    }
    const ageMs = Date.now() - Date.parse(descriptor.createdAt);
    const recoverable = fileAgeMs > AUDIT_LOCK_HARD_STALE_MS
      || (fileAgeMs > AUDIT_LOCK_STALE_MS && ageMs > AUDIT_LOCK_STALE_MS && !processIsAlive(descriptor.pid as number));
    return { device: details.dev, inode: details.ino, recoverable };
  } finally {
    await handle.close();
  }
}

async function removeStaleAuditLock(lockPath: string): Promise<boolean> {
  const inspected = await inspectAuditLock(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!inspected) return true;
  if (!inspected.recoverable) return false;
  const current = await lstat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!current) return true;
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== inspected.device || current.ino !== inspected.inode) return false;
  await unlink(lockPath);
  await syncDirectory(path.dirname(lockPath));
  return true;
}

async function acquireAuditLock(destinationRoot: string): Promise<HeldAuditLock> {
  const lockPath = path.join(destinationRoot, "rf-monitor-backup-audit.lock");
  const deadline = Date.now() + AUDIT_LOCK_WAIT_MS;
  while (true) {
    const nonce = randomUUID();
    let handle;
    let createdIdentity: { device: number; inode: number } | undefined;
    try {
      handle = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const initialDetails = await handle.stat();
      if (!initialDetails.isFile() || initialDetails.nlink !== 1) throw new Error("backup-audit-lock-invalid");
      createdIdentity = { device: initialDetails.dev, inode: initialDetails.ino };
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: 1,
        type: "rf-monitor-backup-audit-lock",
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      })}\n`);
      await handle.sync();
      const details = await handle.stat();
      if (!details.isFile() || details.nlink !== 1 || details.dev !== createdIdentity.device || details.ino !== createdIdentity.inode) {
        throw new Error("backup-audit-lock-invalid");
      }
      await handle.close();
      handle = undefined;
      await syncDirectory(destinationRoot);
      return { path: lockPath, device: details.dev, inode: details.ino, nonce };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (createdIdentity) {
        const current = await lstat(lockPath).catch(() => undefined);
        if (current && current.dev === createdIdentity.device && current.ino === createdIdentity.inode) {
          await unlink(lockPath).catch(() => undefined);
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("backup-audit-lock-busy");
      if (await removeStaleAuditLock(lockPath)) continue;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("backup-audit-lock-busy");
      await new Promise((resolve) => setTimeout(resolve, Math.min(AUDIT_LOCK_RETRY_MS, remainingMs)));
    }
  }
}

async function releaseAuditLock(destinationRoot: string, held: HeldAuditLock): Promise<void> {
  const current = await lstat(held.path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.device || current.ino !== held.inode) {
    throw new Error(`backup-audit-lock-ownership-lost:${held.nonce}`);
  }
  await unlink(held.path);
  await syncDirectory(destinationRoot);
}

async function appendAuditLocked(destinationRoot: string, result: BackupResult, now: Date): Promise<boolean> {
  const auditPath = path.join(destinationRoot, "rf-monitor-backup-audit.jsonl");
  const line = `${JSON.stringify({ timestamp: now.toISOString(), ...result })}\n`;
  if (Buffer.byteLength(line) > MAX_AUDIT_RECORD_BYTES) throw new Error("backup-audit-record-size-bound");
  const handle = await open(
    auditPath,
    fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o640,
  );
  let retained = Buffer.alloc(0);
  let rotate = false;
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("backup-audit-not-regular");
    rotate = details.size + Buffer.byteLength(line) > MAX_AUDIT_BYTES;
    if (rotate && details.size > 0) {
      const start = Math.max(0, details.size - AUDIT_RETAIN_BYTES);
      const buffer = Buffer.alloc(details.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const tail = buffer.subarray(0, bytesRead);
      const newline = start === 0 ? -1 : tail.indexOf(0x0a);
      retained = newline >= 0 ? tail.subarray(newline + 1) : start === 0 ? tail : Buffer.alloc(0);
    } else if (!rotate) {
      await handle.writeFile(line);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  if (rotate) {
    await writeAtomic(auditPath, `${retained.toString("utf8")}${line}`);
  }
  await syncDirectory(destinationRoot);
  return true;
}

async function appendAudit(destinationRoot: string, result: BackupResult, now: Date): Promise<boolean> {
  const held = await acquireAuditLock(destinationRoot);
  try {
    return await appendAuditLocked(destinationRoot, result, now);
  } finally {
    await releaseAuditLock(destinationRoot, held);
  }
}

function baseResult(operation: BackupResult["operation"], state: BackupOperationState, outcome: BackupOutcome): BackupResult {
  return {
    schemaVersion: 1,
    operation,
    state,
    outcome,
    files: 0,
    bytes: 0,
    evidencePackages: 0,
    incompleteEvidence: 0,
    excludedSecrets: 0,
    excludedConfigFiles: 0,
    recoveredPartials: 0,
    pendingPartials: 0,
    idempotent: false,
    auditDurable: false,
    reasons: [],
  };
}

export async function verifyBackup(backupPathInput: string, options: BackupVerifyOptions = {}): Promise<BackupResult> {
  const backupPath = refuseFilesystemRoot(requireAbsolutePath(backupPathInput), "backup");
  const result = baseResult("verify", "refused", "FAIL");
  result.backupPath = backupPath;
  try {
    await assertNoSymlinkComponents(backupPath, true);
    const manifest = validateManifest(await readBoundedJson(path.join(backupPath, BACKUP_MANIFEST), MAX_MANIFEST_BYTES));
    if (options.expectedBackupId && manifest.backupId !== options.expectedBackupId) throw new Error("backup-id-mismatch");
    result.backupId = manifest.backupId;
    result.sourceContentSha256 = manifest.sourceContentSha256;
    result.files = manifest.files.length;
    result.bytes = totalBytes(manifest.files);
    result.evidencePackages = manifest.evidence.length;
    result.excludedSecrets = manifest.excludedSecretPaths.length;
    result.excludedConfigFiles = manifest.excludedConfigPaths.length;
    const packageDescriptor = await readBoundedJson(path.join(backupPath, BACKUP_DESCRIPTOR), 64 * 1024);
    if (packageDescriptor.schemaVersion !== 1 || packageDescriptor.type !== "rf-monitor-backup"
      || packageDescriptor.backupId !== manifest.backupId || packageDescriptor.createdAt !== manifest.createdAt
      || packageDescriptor.sourceContentSha256 !== manifest.sourceContentSha256) {
      throw new Error("backup-package-descriptor-mismatch");
    }
    const manifestDigest = await sha256File(path.join(backupPath, BACKUP_MANIFEST));
    const descriptorDigest = await sha256File(path.join(backupPath, BACKUP_DESCRIPTOR));
    result.manifestSha256 = manifestDigest.sha256;
    const sumsText = await readBoundedText(path.join(backupPath, BACKUP_SUMS), MAX_SUMS_BYTES);
    const expectedSums = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
    expectedSums.set(BACKUP_MANIFEST, manifestDigest.sha256);
    expectedSums.set(BACKUP_DESCRIPTOR, descriptorDigest.sha256);
    const actualSums = new Map<string, string>();
    for (const line of sumsText.split("\n")) {
      if (!line) continue;
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      if (!match || actualSums.has(match[2])) throw new Error("backup-sums-invalid");
      actualSums.set(match[2], match[1]);
    }
    if (actualSums.size !== expectedSums.size) throw new Error("backup-sums-entry-count-mismatch");
    const actualFiles = (await walkRegularFiles(backupPath)).filter((entry) => entry !== BACKUP_MANIFEST && entry !== BACKUP_SUMS && entry !== BACKUP_DESCRIPTOR);
    if (actualFiles.length !== manifest.files.length || actualFiles.some((entry, index) => entry !== manifest.files[index].path)) {
      throw new Error("backup-file-inventory-mismatch");
    }
    for (const entry of manifest.files) {
      const absolute = resolvePortable(backupPath, entry.path);
      const details = await lstat(absolute);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error(`backup-file-not-regular:${entry.path}`);
      const digest = await sha256File(absolute);
      if (digest.bytes !== entry.bytes) throw new Error(`backup-file-size-mismatch:${entry.path}`);
      if (digest.sha256 !== entry.sha256 || actualSums.get(entry.path) !== entry.sha256) throw new Error(`backup-file-hash-mismatch:${entry.path}`);
    }
    if (actualSums.get(BACKUP_MANIFEST) !== manifestDigest.sha256) throw new Error("backup-manifest-sum-mismatch");
    if (actualSums.get(BACKUP_DESCRIPTOR) !== descriptorDigest.sha256) throw new Error("backup-package-descriptor-sum-mismatch");
    await validateDomainMarkers(backupPath, manifest);
    const evidenceOutcomes: BackupEvidenceEntry[] = [];
    for (const entry of manifest.evidence) {
      const verification = await verifyEvidenceDirectory(resolvePortable(backupPath, entry.path), { expectedDataDomain: entry.dataDomain });
      evidenceOutcomes.push({ ...entry, outcome: verification.outcome, reasons: verification.reasons });
      if (verification.outcome !== entry.outcome) throw new Error(`backup-evidence-outcome-mismatch:${entry.path}`);
    }
    const failed = evidenceOutcomes.filter((entry) => entry.outcome === "FAIL");
    if (failed.length) throw new Error(`backup-evidence-failed:${failed[0].path}`);
    result.incompleteEvidence = evidenceOutcomes.filter((entry) => entry.outcome === "INCOMPLETE").length;
    result.outcome = result.incompleteEvidence ? "INCOMPLETE" : "PASS";
    result.state = result.incompleteEvidence ? "incomplete" : "complete";
    result.reasons = result.incompleteEvidence ? ["source-evidence-incomplete"] : [];
    return result;
  } catch (error) {
    result.reasons = [error instanceof Error ? error.message : "backup-verification-failed"];
    return result;
  }
}

export async function createBackup(options: BackupCreateOptions): Promise<BackupResult> {
  const now = options.now?.() ?? new Date();
  const destinationRoot = refuseFilesystemRoot(requireAbsolutePath(options.destinationRoot), "destination");
  const backupId = safeBackupId(options.backupId);
  const backupPath = path.join(destinationRoot, backupId);
  const result = baseResult("create", "refused", "FAIL");
  result.backupId = backupId;
  result.backupPath = backupPath;
  let partialPath: string | undefined;
  let published = false;
  try {
    await assertNoSymlinkComponents(destinationRoot, true);
    const plan = await planBackup(options);
    const partialRecovery = await removeRecoveredPartials(
      destinationRoot,
      `.${backupId}.partial-`,
      Boolean(options.recover),
      Boolean(options.dryRun),
      async (partial) => {
        let descriptor: Record<string, unknown>;
        try {
          descriptor = await readBoundedJson(path.join(partial, BACKUP_DESCRIPTOR), 64 * 1024);
        } catch {
          throw new Error(`unowned-partial-refused:${path.basename(partial)}`);
        }
        if (descriptor.schemaVersion !== 1 || descriptor.type !== "rf-monitor-backup" || descriptor.backupId !== backupId
          || descriptor.sourceContentSha256 !== plan.manifest.sourceContentSha256) {
          throw new Error(`unowned-partial-refused:${path.basename(partial)}`);
        }
      },
    );
    result.files = plan.manifest.files.length;
    result.bytes = totalBytes(plan.manifest.files);
    result.evidencePackages = plan.manifest.evidence.length;
    result.incompleteEvidence = plan.manifest.evidence.filter((entry) => entry.outcome === "INCOMPLETE").length;
    result.excludedSecrets = plan.manifest.excludedSecretPaths.length;
    result.excludedConfigFiles = plan.manifest.excludedConfigPaths.length;
    result.recoveredPartials = partialRecovery.recovered;
    result.pendingPartials = partialRecovery.pending;
    result.sourceContentSha256 = plan.manifest.sourceContentSha256;
    const plannedOutcome: BackupOutcome = result.incompleteEvidence ? "INCOMPLETE" : "PASS";
    if (await exists(backupPath)) {
      const existing = await verifyBackup(backupPath, { expectedBackupId: backupId });
      if (existing.outcome === "FAIL" || existing.sourceContentSha256 !== plan.manifest.sourceContentSha256) throw new Error("backup-id-exists-with-different-or-invalid-content");
      const idempotent = {
        ...existing,
        operation: "create" as const,
        idempotent: true,
        recoveredPartials: partialRecovery.recovered,
        pendingPartials: partialRecovery.pending,
        auditDurable: false,
      };
      idempotent.auditDurable = await appendAudit(destinationRoot, idempotent, now);
      return idempotent;
    }
    const free = await (options.availableBytes ?? availableBytes)(destinationRoot);
    const minimum = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error("minimum-free-bytes-invalid");
    const required = requiredCapacity(result.bytes, minimum);
    result.availableBytes = free;
    result.requiredBytes = required;
    result.minimumFreeBytes = minimum;
    if (free < required) throw new Error(`insufficient-destination-capacity:${free}:${required}`);
    if (options.dryRun) {
      return {
        ...result,
        state: result.incompleteEvidence ? "incomplete" : "planned",
        outcome: plannedOutcome,
        reasons: result.incompleteEvidence ? ["source-evidence-incomplete"] : [],
      };
    }

    partialPath = path.join(destinationRoot, `.${backupId}.partial-${randomUUID().slice(0, 8)}`);
    await mkdir(partialPath, { recursive: false, mode: 0o750 });
    const packageDescriptorContents = JSON.stringify({
      schemaVersion: 1,
      type: "rf-monitor-backup",
      backupId,
      createdAt: plan.manifest.createdAt,
      sourceContentSha256: plan.manifest.sourceContentSha256,
    }, null, 2);
    await writeAtomic(path.join(partialPath, BACKUP_DESCRIPTOR), packageDescriptorContents);
    for (const source of plan.sourceFiles) await copyHashed(source.sourcePath, resolvePortable(partialPath, source.path), source);
    await options.faultInjector?.("after-copy");
    const currentSourcePaths = new Set<string>();
    const collectCurrent = async (sourceRoot: string, prefix: string, allowlist: boolean) => {
      for (const relativePath of await walkRegularFiles(sourceRoot)) {
        if (SECRET_NAME.test(relativePath) || (allowlist && !CONFIG_ALLOWED.test(relativePath))) continue;
        currentSourcePaths.add(`${prefix}/${relativePath}`);
      }
    };
    await collectCurrent(requireAbsolutePath(options.dataRoot), "payload/data", false);
    for (const config of options.configRoots) await collectCurrent(requireAbsolutePath(config.path), `payload/config/${safeLabel(config.label)}`, true);
    if (currentSourcePaths.size !== plan.sourceFiles.length || plan.sourceFiles.some((entry) => !currentSourcePaths.has(entry.path))) {
      throw new Error("source-inventory-changed-during-copy");
    }
    for (const source of plan.sourceFiles) {
      const current = await sha256File(source.sourcePath);
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) throw new Error(`source-changed-after-copy:${source.path}`);
    }
    const manifestContents = JSON.stringify(plan.manifest, null, 2);
    await writeAtomic(path.join(partialPath, BACKUP_MANIFEST), manifestContents);
    const sums = [
      ...plan.manifest.files.map((entry) => `${entry.sha256}  ${entry.path}\n`),
      `${sha256Text(manifestContents)}  ${BACKUP_MANIFEST}\n`,
      `${sha256Text(packageDescriptorContents)}  ${BACKUP_DESCRIPTOR}\n`,
    ].join("");
    await writeAtomic(path.join(partialPath, BACKUP_SUMS), sums);
    await options.faultInjector?.("after-manifest");
    const verification = await verifyBackup(partialPath, { expectedBackupId: backupId });
    if (verification.outcome === "FAIL") throw new Error(`backup-staging-verification-failed:${verification.reasons.join(",")}`);
    await syncTreeDirectories(partialPath);
    await rename(partialPath, backupPath);
    partialPath = undefined;
    published = true;
    await syncDirectory(destinationRoot);
    await options.faultInjector?.("after-publish");
    const completed: BackupResult = {
      ...verification,
      operation: "create",
      backupPath,
      recoveredPartials: partialRecovery.recovered,
      pendingPartials: partialRecovery.pending,
      auditDurable: false,
      availableBytes: free,
      requiredBytes: required,
      minimumFreeBytes: minimum,
    };
    completed.auditDurable = await appendAudit(destinationRoot, completed, now);
    return completed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "backup-create-failed";
    if (partialPath && !published && !/^(?:fixture-|simulated-|power-loss)/.test(reason)) {
      await rm(partialPath, { recursive: true, force: true }).catch(() => undefined);
      partialPath = undefined;
    }
    result.state = published || partialPath ? "recovery-required" : "refused";
    result.reasons = [reason];
    result.auditDurable = await appendAudit(destinationRoot, result, now).catch(() => false);
    return result;
  }
}

export async function backupStatus(destinationRootInput: string, backupIdInput: string): Promise<BackupResult> {
  const destinationRoot = refuseFilesystemRoot(requireAbsolutePath(destinationRootInput), "destination");
  const backupId = safeBackupId(backupIdInput);
  const result = baseResult("status", "refused", "FAIL");
  result.backupId = backupId;
  result.backupPath = path.join(destinationRoot, backupId);
  try {
    await assertNoSymlinkComponents(destinationRoot, true);
    const partials = (await readdir(destinationRoot, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith(`.${backupId}.partial-`));
    if (partials.length > MAX_PARTIALS) throw new Error("backup-partial-count-bound");
    result.pendingPartials = partials.length;
    if (await exists(result.backupPath)) return {
      ...(await verifyBackup(result.backupPath, { expectedBackupId: backupId })),
      operation: "status",
      pendingPartials: partials.length,
    };
    result.state = partials.length ? "recovery-required" : "refused";
    result.reasons = [partials.length ? "interrupted-partial-present-use-recover" : "backup-not-found"];
    return result;
  } catch (error) {
    result.reasons = [error instanceof Error ? error.message : "backup-status-failed"];
    return result;
  }
}

async function verifyRestoredPayload(destinationPath: string, manifest: BackupManifest): Promise<boolean> {
  const expected = manifest.files.map((entry) => ({ ...entry, path: entry.path.replace(/^payload\//, "") }));
  const actual = (await walkRegularFiles(destinationPath))
    .filter((entry) => entry !== RESTORE_DESCRIPTOR && entry !== RESTORE_PARTIAL_DESCRIPTOR)
    .sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index].path)) return false;
  for (const entry of expected) {
    const digest = await sha256File(resolvePortable(destinationPath, entry.path));
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) return false;
  }
  return true;
}

export async function restoreBackup(options: BackupRestoreOptions): Promise<BackupResult> {
  const now = options.now?.() ?? new Date();
  const backupPath = refuseFilesystemRoot(requireAbsolutePath(options.backupPath), "backup");
  const destinationPath = requireAbsolutePath(options.destinationPath);
  if (destinationPath === path.parse(destinationPath).root) throw new Error("restore-destination-filesystem-root-refused");
  const parent = path.dirname(destinationPath);
  const result = baseResult("restore", "refused", "FAIL");
  result.backupPath = backupPath;
  result.restorePath = destinationPath;
  let partialPath: string | undefined;
  let published = false;
  try {
    await assertNoSymlinkComponents(backupPath, true);
    await assertParentNoSymlink(destinationPath);
    if (pathWithin(backupPath, destinationPath) || pathWithin(destinationPath, backupPath)) throw new Error("backup-restore-paths-must-be-separate");
    const verification = await verifyBackup(backupPath);
    Object.assign(result, {
      backupId: verification.backupId,
      files: verification.files,
      bytes: verification.bytes,
      evidencePackages: verification.evidencePackages,
      incompleteEvidence: verification.incompleteEvidence,
      excludedSecrets: verification.excludedSecrets,
      excludedConfigFiles: verification.excludedConfigFiles,
      sourceContentSha256: verification.sourceContentSha256,
      manifestSha256: verification.manifestSha256,
    });
    if (verification.outcome === "FAIL") throw new Error(`backup-verification-failed:${verification.reasons.join(",")}`);
    const manifest = validateManifest(await readBoundedJson(path.join(backupPath, BACKUP_MANIFEST), MAX_MANIFEST_BYTES));
    if (await exists(destinationPath)) {
      await assertNoSymlinkComponents(destinationPath, true);
      const descriptorPath = path.join(destinationPath, RESTORE_DESCRIPTOR);
      if (!(await exists(descriptorPath))) throw new Error("restore-destination-not-empty-or-owned");
      const descriptor = await readBoundedJson(descriptorPath, 64 * 1024);
      if (descriptor.backupId !== manifest.backupId || descriptor.manifestSha256 !== verification.manifestSha256
        || !(await verifyRestoredPayload(destinationPath, manifest))) throw new Error("restore-destination-does-not-match-backup");
      return { ...verification, operation: "restore", restorePath: destinationPath, idempotent: true, auditDurable: true };
    }
    const partialRecovery = await removeRecoveredPartials(
      parent,
      `.${path.basename(destinationPath)}.partial-`,
      Boolean(options.recover),
      Boolean(options.dryRun),
      async (partial) => {
        const partialMarker = path.join(partial, RESTORE_PARTIAL_DESCRIPTOR);
        let descriptor: Record<string, unknown>;
        try {
          descriptor = await readBoundedJson(
            await exists(partialMarker) ? partialMarker : path.join(partial, RESTORE_DESCRIPTOR),
            64 * 1024,
          );
        } catch {
          throw new Error(`unowned-partial-refused:${path.basename(partial)}`);
        }
        const owned = descriptor.schemaVersion === 1 && (
          descriptor.type === "rf-monitor-restore-partial"
            ? descriptor.backupId === manifest.backupId && descriptor.manifestSha256 === verification.manifestSha256
              && descriptor.destinationName === path.basename(destinationPath)
            : descriptor.backupId === manifest.backupId && descriptor.manifestSha256 === verification.manifestSha256
        );
        if (!owned) throw new Error(`unowned-partial-refused:${path.basename(partial)}`);
      },
    );
    result.recoveredPartials = partialRecovery.recovered;
    result.pendingPartials = partialRecovery.pending;
    const free = await (options.availableBytes ?? availableBytes)(parent);
    const minimum = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error("minimum-free-bytes-invalid");
    const required = requiredCapacity(result.bytes, minimum);
    result.availableBytes = free;
    result.requiredBytes = required;
    result.minimumFreeBytes = minimum;
    if (free < required) throw new Error(`insufficient-restore-capacity:${free}:${required}`);
    if (options.dryRun) {
      return {
        ...result,
        state: verification.outcome === "INCOMPLETE" ? "incomplete" : "planned",
        outcome: verification.outcome,
        reasons: verification.outcome === "INCOMPLETE" ? ["source-evidence-incomplete"] : [],
      };
    }
    partialPath = path.join(parent, `.${path.basename(destinationPath)}.partial-${randomUUID().slice(0, 8)}`);
    await mkdir(partialPath, { recursive: false, mode: 0o750 });
    await writeAtomic(path.join(partialPath, RESTORE_PARTIAL_DESCRIPTOR), JSON.stringify({
      schemaVersion: 1,
      type: "rf-monitor-restore-partial",
      backupId: manifest.backupId,
      manifestSha256: verification.manifestSha256,
      destinationName: path.basename(destinationPath),
      createdAt: now.toISOString(),
    }, null, 2));
    for (const entry of manifest.files) {
      const relative = entry.path.replace(/^payload\//, "");
      if (relative === entry.path) throw new Error(`restore-payload-prefix-missing:${entry.path}`);
      await copyHashed(resolvePortable(backupPath, entry.path), resolvePortable(partialPath, relative), entry);
    }
    await options.faultInjector?.("restore-after-copy");
    const completedResult: BackupResult = {
      ...verification,
      operation: "restore",
      restorePath: destinationPath,
      recoveredPartials: partialRecovery.recovered,
      pendingPartials: partialRecovery.pending,
      auditDurable: true,
      availableBytes: free,
      requiredBytes: required,
      minimumFreeBytes: minimum,
    };
    const descriptor = {
      schemaVersion: 1,
      backupId: manifest.backupId,
      manifestSha256: verification.manifestSha256,
      restoredAt: now.toISOString(),
      files: manifest.files.length,
      bytes: result.bytes,
      evidenceOutcome: verification.outcome,
      sourceContentSha256: manifest.sourceContentSha256,
      result: completedResult,
    };
    await writeAtomic(path.join(partialPath, RESTORE_DESCRIPTOR), JSON.stringify(descriptor, null, 2));
    if (!(await verifyRestoredPayload(partialPath, manifest))) throw new Error("restore-staging-verification-failed");
    await unlink(path.join(partialPath, RESTORE_PARTIAL_DESCRIPTOR));
    await syncTreeDirectories(partialPath);
    await rename(partialPath, destinationPath);
    partialPath = undefined;
    published = true;
    await syncDirectory(parent);
    await options.faultInjector?.("restore-after-publish");
    return completedResult;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "backup-restore-failed";
    if (partialPath && !published && !/^(?:fixture-|simulated-|power-loss)/.test(reason)) {
      await rm(partialPath, { recursive: true, force: true }).catch(() => undefined);
      partialPath = undefined;
    }
    result.state = published || partialPath ? "recovery-required" : "refused";
    result.reasons = [reason];
    return result;
  }
}
