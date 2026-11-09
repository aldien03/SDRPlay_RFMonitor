import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DataDomain, EvidenceLifecycle, EvidenceManifest, EvidenceSession } from "../shared/types";

export type EvidenceVerificationOutcome = "PASS" | "INCOMPLETE" | "FAIL";

export interface EvidenceVerificationResult {
  outcome: EvidenceVerificationOutcome;
  sessionId?: string;
  manifestSchemaVersion?: 1 | 2;
  dataDomain?: DataDomain;
  filesVerified: number;
  bytesVerified: number;
  reasons: string[];
}

export interface EvidenceFinalizationRecord {
  schemaVersion: 1;
  sessionId: string;
  dataDomain: DataDomain;
  lifecycle: "Complete" | "Incomplete";
  committedAt: string;
  manifestSha256: string;
  sha256SumsSha256: string;
  recordSha256: string;
}

export interface EvidenceVerificationOptions {
  expectedDataDomain?: DataDomain;
}

export interface EvidenceCommitInspection {
  outcome: "committed" | "missing" | "fail";
  sessionId?: string;
  dataDomain?: DataDomain;
  lifecycle?: "Complete" | "Incomplete";
  committedAt?: string;
  reasons: string[];
}

export interface MultipartEvidenceVerificationResult {
  outcome: EvidenceVerificationOutcome;
  partsVerified: number;
  totalParts?: number;
  reconstructionSha256?: string;
  reasons: string[];
}

const MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SUMS_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_FILES = 100_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LIFECYCLES = new Set<EvidenceLifecycle>(["Active", "Finalizing", "Complete", "Incomplete", "Corrupt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function sha256BoundedFile(filePath: string, maximumBytes: number): Promise<string> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) {
    throw new Error(`file-size-bound:${path.basename(filePath)}`);
  }
  return (await sha256File(filePath)).sha256;
}

async function readBounded(filePath: string, maximumBytes: number): Promise<string> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) {
    throw new Error(`file-size-bound:${path.basename(filePath)}`);
  }
  return readFile(filePath, "utf8");
}

async function readOptionalJson(filePath: string, maximumBytes: number): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readBounded(filePath, maximumBytes)) as unknown;
    if (!isRecord(parsed)) throw new Error(`invalid-json-object:${path.basename(filePath)}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error(`malformed-json:${path.basename(filePath)}`);
    throw error;
  }
}

function resolveManifestPath(root: string, relativePath: string): string {
  if (
    !relativePath
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) throw new Error(`invalid-manifest-path:${relativePath || "<empty>"}`);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`manifest-path-escape:${relativePath}`);
  }
  return resolved;
}

function parseLifecycle(descriptor: Record<string, unknown> | undefined): EvidenceLifecycle | undefined {
  const lifecycle = descriptor?.lifecycle;
  return typeof lifecycle === "string" && LIFECYCLES.has(lifecycle as EvidenceLifecycle)
    ? lifecycle as EvidenceLifecycle
    : undefined;
}

function unsignedFinalizationRecord(record: Omit<EvidenceFinalizationRecord, "recordSha256">): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    dataDomain: record.dataDomain,
    lifecycle: record.lifecycle,
    committedAt: record.committedAt,
    manifestSha256: record.manifestSha256,
    sha256SumsSha256: record.sha256SumsSha256,
  });
}

export function createEvidenceFinalizationRecord(
  input: Omit<EvidenceFinalizationRecord, "schemaVersion" | "recordSha256">,
): EvidenceFinalizationRecord {
  const unsigned = { schemaVersion: 1 as const, ...input };
  return { ...unsigned, recordSha256: sha256Bytes(unsignedFinalizationRecord(unsigned)) };
}

function validateFinalizationRecord(value: Record<string, unknown>): EvidenceFinalizationRecord {
  if (
    value.schemaVersion !== 1
    || typeof value.sessionId !== "string" || !value.sessionId
    || (value.dataDomain !== "field" && value.dataDomain !== "test")
    || (value.lifecycle !== "Complete" && value.lifecycle !== "Incomplete")
    || typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt))
    || typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)
    || typeof value.sha256SumsSha256 !== "string" || !SHA256_PATTERN.test(value.sha256SumsSha256)
    || typeof value.recordSha256 !== "string" || !SHA256_PATTERN.test(value.recordSha256)
  ) throw new Error("invalid-finalization-record");
  const record = value as unknown as EvidenceFinalizationRecord;
  const expected = sha256Bytes(unsignedFinalizationRecord({
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    dataDomain: record.dataDomain,
    lifecycle: record.lifecycle,
    committedAt: record.committedAt,
    manifestSha256: record.manifestSha256,
    sha256SumsSha256: record.sha256SumsSha256,
  }));
  if (record.recordSha256 !== expected) throw new Error("finalization-record-hash-mismatch");
  return record;
}

function validateManifest(value: Record<string, unknown>): EvidenceManifest {
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new Error("unsupported-manifest-schema");
  if (typeof value.sessionId !== "string" || !value.sessionId) throw new Error("manifest-session-id-invalid");
  if (value.hashAlgorithm !== "SHA-256") throw new Error("manifest-hash-algorithm-invalid");
  if (!Array.isArray(value.files) || value.files.length > MAX_MANIFEST_FILES) throw new Error("manifest-file-count-bound");
  const seen = new Set<string>();
  for (const candidate of value.files) {
    if (!isRecord(candidate)
      || typeof candidate.path !== "string"
      || !Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) < 0
      || typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
      throw new Error("manifest-entry-invalid");
    }
    resolveManifestPath("/validation-root", candidate.path);
    if (candidate.path === "manifest.json" || candidate.path === "SHA256SUMS.txt" || seen.has(candidate.path)) {
      throw new Error(`manifest-entry-duplicate-or-reserved:${candidate.path}`);
    }
    seen.add(candidate.path);
  }
  if (value.schemaVersion === 2 && value.dataDomain !== "field" && value.dataDomain !== "test") {
    throw new Error("manifest-data-domain-invalid");
  }
  return value as unknown as EvidenceManifest;
}

function parseSums(contents: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || sums.has(match[2])) throw new Error("sha256sums-invalid");
    sums.set(match[2], match[1]);
  }
  return sums;
}

function failure(reason: string, partial: Partial<EvidenceVerificationResult> = {}): EvidenceVerificationResult {
  return {
    outcome: "FAIL",
    filesVerified: partial.filesVerified ?? 0,
    bytesVerified: partial.bytesVerified ?? 0,
    reasons: [reason],
    ...(partial.sessionId ? { sessionId: partial.sessionId } : {}),
    ...(partial.manifestSchemaVersion ? { manifestSchemaVersion: partial.manifestSchemaVersion } : {}),
    ...(partial.dataDomain ? { dataDomain: partial.dataDomain } : {}),
  };
}

/**
 * Inspect only the bounded transactional metadata used to publish a session.
 * This is safe for startup recovery: it never reads or hashes evidence payloads.
 * A full payload verification remains a separate, explicit operation.
 */
export async function inspectEvidenceCommitMetadata(
  root: string,
  options: EvidenceVerificationOptions & { expectedSessionId?: string } = {},
): Promise<EvidenceCommitInspection> {
  let record: Record<string, unknown> | undefined;
  try {
    record = await readOptionalJson(path.join(root, "finalization.json"), MAX_DESCRIPTOR_BYTES);
  } catch (error) {
    return { outcome: "fail", reasons: [error instanceof Error ? error.message : "finalization-record-unreadable"] };
  }
  if (!record) return { outcome: "missing", reasons: ["finalization-commit-missing"] };

  let commit: EvidenceFinalizationRecord;
  try {
    commit = validateFinalizationRecord(record);
  } catch (error) {
    return { outcome: "fail", reasons: [error instanceof Error ? error.message : "finalization-record-invalid"] };
  }
  const base = {
    sessionId: commit.sessionId,
    dataDomain: commit.dataDomain,
    lifecycle: commit.lifecycle,
    committedAt: commit.committedAt,
  };
  if (options.expectedSessionId && commit.sessionId !== options.expectedSessionId) {
    return { outcome: "fail", ...base, reasons: ["finalization-session-id-mismatch"] };
  }
  if (options.expectedDataDomain && commit.dataDomain !== options.expectedDataDomain) {
    return { outcome: "fail", ...base, reasons: ["finalization-data-domain-mismatch"] };
  }

  try {
    const [manifestDigest, sumsDigest, finalDescriptor] = await Promise.all([
      sha256BoundedFile(path.join(root, "manifest.json"), MAX_MANIFEST_BYTES),
      sha256BoundedFile(path.join(root, "SHA256SUMS.txt"), MAX_SUMS_BYTES),
      readOptionalJson(path.join(root, "session-final.json"), MAX_DESCRIPTOR_BYTES),
    ]);
    if (manifestDigest !== commit.manifestSha256) throw new Error("finalization-manifest-hash-mismatch");
    if (sumsDigest !== commit.sha256SumsSha256) throw new Error("finalization-sums-hash-mismatch");
    if (!finalDescriptor
      || finalDescriptor.id !== commit.sessionId
      || finalDescriptor.lifecycle !== commit.lifecycle
      || (finalDescriptor.dataDomain !== undefined && finalDescriptor.dataDomain !== commit.dataDomain)) {
      throw new Error("final-session-descriptor-mismatch");
    }
  } catch (error) {
    return { outcome: "fail", ...base, reasons: [error instanceof Error ? error.message : "finalization-metadata-unreadable"] };
  }
  return { outcome: "committed", ...base, reasons: [] };
}

/**
 * Verify an extracted evidence session or export directory without trusting
 * the running RF Monitor process. The result contains no wall-clock-dependent
 * fields, so the same bytes always yield the same outcome and reason codes.
 */
export async function verifyEvidenceDirectory(
  root: string,
  options: EvidenceVerificationOptions = {},
): Promise<EvidenceVerificationResult> {
  let descriptor: Record<string, unknown> | undefined;
  let lifecycle: EvidenceLifecycle | undefined;
  try {
    descriptor = await readOptionalJson(path.join(root, "session.json"), MAX_DESCRIPTOR_BYTES);
    lifecycle = parseLifecycle(descriptor);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "session-descriptor-unreadable");
  }

  if (descriptor?.lifecycle !== undefined && !lifecycle) return failure("session-lifecycle-invalid");
  if (lifecycle === "Corrupt") return failure("session-marked-corrupt", {
    sessionId: typeof descriptor?.id === "string" ? descriptor.id : undefined,
  });

  let manifestRecord: Record<string, unknown> | undefined;
  let finalizationRecord: Record<string, unknown> | undefined;
  try {
    [manifestRecord, finalizationRecord] = await Promise.all([
      readOptionalJson(path.join(root, "manifest.json"), MAX_MANIFEST_BYTES),
      readOptionalJson(path.join(root, "finalization.json"), MAX_DESCRIPTOR_BYTES),
    ]);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "evidence-metadata-unreadable");
  }

  if (!manifestRecord) {
    if (lifecycle === "Active" || lifecycle === "Finalizing" || lifecycle === "Incomplete") {
      return {
        outcome: "INCOMPLETE",
        sessionId: typeof descriptor?.id === "string" ? descriptor.id : undefined,
        dataDomain: descriptor?.dataDomain === "field" || descriptor?.dataDomain === "test" ? descriptor.dataDomain : undefined,
        filesVerified: 0,
        bytesVerified: 0,
        reasons: ["manifest-not-finalized"],
      };
    }
    return failure(lifecycle === "Complete" ? "finalization-commit-or-manifest-missing" : "manifest-missing");
  }

  let manifest: EvidenceManifest;
  try {
    manifest = validateManifest(manifestRecord);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "manifest-invalid");
  }
  const partial: Partial<EvidenceVerificationResult> = {
    sessionId: manifest.sessionId,
    manifestSchemaVersion: manifest.schemaVersion,
    dataDomain: manifest.dataDomain,
    filesVerified: 0,
    bytesVerified: 0,
  };
  if (options.expectedDataDomain && manifest.dataDomain && manifest.dataDomain !== options.expectedDataDomain) {
    return failure("unexpected-data-domain", partial);
  }
  if (descriptor?.id !== undefined && descriptor.id !== manifest.sessionId) return failure("descriptor-session-id-mismatch", partial);
  if (descriptor?.dataDomain && manifest.dataDomain && descriptor.dataDomain !== manifest.dataDomain) {
    return failure("descriptor-data-domain-mismatch", partial);
  }

  let manifestDigest: string;
  let sumsDigest: string;
  let sums: Map<string, string>;
  try {
    const [manifestFile, sumsFile, sumsContents] = await Promise.all([
      sha256File(path.join(root, "manifest.json")),
      sha256File(path.join(root, "SHA256SUMS.txt")),
      readBounded(path.join(root, "SHA256SUMS.txt"), MAX_SUMS_BYTES),
    ]);
    manifestDigest = manifestFile.sha256;
    sumsDigest = sumsFile.sha256;
    sums = parseSums(sumsContents);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "sha256sums-unreadable", partial);
  }

  const expectedSums = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  expectedSums.set("manifest.json", manifestDigest);
  if (sums.size !== expectedSums.size) return failure("sha256sums-entry-count-mismatch", partial);
  for (const [filePath, digest] of expectedSums) {
    if (sums.get(filePath) !== digest) return failure(`sha256sums-mismatch:${filePath}`, partial);
  }

  let filesVerified = 0;
  let bytesVerified = 0;
  try {
    for (const entry of manifest.files) {
      const absolutePath = resolveManifestPath(root, entry.path);
      const fileType = await lstat(absolutePath);
      if (!fileType.isFile() || fileType.isSymbolicLink()) throw new Error(`manifest-entry-not-regular:${entry.path}`);
      const digest = await sha256File(absolutePath);
      if (digest.bytes !== entry.bytes) throw new Error(`file-size-mismatch:${entry.path}`);
      if (digest.sha256 !== entry.sha256) throw new Error(`file-hash-mismatch:${entry.path}`);
      filesVerified += 1;
      bytesVerified += digest.bytes;
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : "evidence-file-unreadable", {
      ...partial,
      filesVerified,
      bytesVerified,
    });
  }

  const resultBase = {
    sessionId: manifest.sessionId,
    manifestSchemaVersion: manifest.schemaVersion,
    ...(manifest.dataDomain ? { dataDomain: manifest.dataDomain } : {}),
    filesVerified,
    bytesVerified,
  };

  if (finalizationRecord) {
    let commit: EvidenceFinalizationRecord;
    try {
      commit = validateFinalizationRecord(finalizationRecord);
    } catch (error) {
      return failure(error instanceof Error ? error.message : "finalization-record-invalid", resultBase);
    }
    if (commit.sessionId !== manifest.sessionId) return failure("finalization-session-id-mismatch", resultBase);
    if (manifest.dataDomain && commit.dataDomain !== manifest.dataDomain) return failure("finalization-data-domain-mismatch", resultBase);
    if (commit.manifestSha256 !== manifestDigest) return failure("finalization-manifest-hash-mismatch", resultBase);
    if (commit.sha256SumsSha256 !== sumsDigest) return failure("finalization-sums-hash-mismatch", resultBase);
    if (lifecycle && lifecycle !== "Finalizing" && lifecycle !== commit.lifecycle) {
      return failure("descriptor-finalization-lifecycle-mismatch", resultBase);
    }
    const finalDescriptorEntry = manifest.files.find((entry) => entry.path === "session-final.json");
    if (!finalDescriptorEntry) return failure("final-session-descriptor-missing", resultBase);
    try {
      const finalDescriptor = JSON.parse(await readBounded(path.join(root, "session-final.json"), MAX_DESCRIPTOR_BYTES)) as unknown;
      if (!isRecord(finalDescriptor) || finalDescriptor.lifecycle !== commit.lifecycle || finalDescriptor.id !== manifest.sessionId) {
        return failure("final-session-descriptor-mismatch", resultBase);
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : "final-session-descriptor-invalid", resultBase);
    }
    if (commit.lifecycle === "Complete") {
      if (manifest.complete !== true || manifest.evidenceGap === true || (manifest.missingParts?.length ?? 0) > 0) {
        return failure("complete-commit-has-incomplete-manifest", resultBase);
      }
      return { outcome: "PASS", ...resultBase, reasons: [] };
    }
    if (manifest.complete === true || manifest.evidenceGap !== true) {
      return failure("incomplete-commit-has-complete-manifest", resultBase);
    }
    return {
      outcome: "INCOMPLETE",
      ...resultBase,
      reasons: [...(manifest.missingParts?.length ? manifest.missingParts : ["evidence-gap"])].sort(),
    };
  }

  // New transactional descriptors require the atomic finalization commit.
  if (lifecycle === "Complete") return failure("finalization-commit-missing", resultBase);
  if (lifecycle === "Active" || lifecycle === "Finalizing" || lifecycle === "Incomplete") {
    return {
      outcome: "INCOMPLETE",
      ...resultBase,
      reasons: [lifecycle === "Active" ? "session-active" : lifecycle === "Finalizing" ? "finalization-not-committed" : "session-incomplete"],
    };
  }

  // Incident evidence packages must carry the client report and export record
  // they were built with; a hashed but stripped package is incomplete.
  if (manifest.packageType === "incident-evidence") {
    const listed = new Set(manifest.files.map((entry) => entry.path));
    // A numbered part carries only its share of the files; the set is checked as a whole.
    const missing = listed.has("multipart.json") ? [] : ["report.html", "report.json", "export-record.json", "README-VERIFY.txt"].filter((name) => !listed.has(name));
    if (missing.length) return { outcome: "INCOMPLETE", ...resultBase, reasons: missing.map((name) => `incident-package-missing:${name}`) };
  }
  // Manifest-v1, pre-transaction manifest-v2, and extracted export packages
  // remain readable. Their manifest completeness flags remain authoritative.
  if (manifest.complete === false || manifest.evidenceGap === true) {
    return {
      outcome: "INCOMPLETE",
      ...resultBase,
      reasons: [...(manifest.missingParts?.length ? manifest.missingParts : ["evidence-gap"])].sort(),
    };
  }
  return { outcome: "PASS", ...resultBase, reasons: [] };
}

/** Verify extracted multipart roots and prove their file inventory reconstructs exactly once. */
export async function verifyMultipartEvidenceDirectories(
  roots: readonly string[],
  options: EvidenceVerificationOptions = {},
): Promise<MultipartEvidenceVerificationResult> {
  if (!roots.length || roots.length > 1_024) {
    return { outcome: "FAIL", partsVerified: 0, reasons: ["multipart-part-count-bound"] };
  }
  const parts: Array<{
    root: string;
    partNumber: number;
    totalParts: number;
    archiveRoot: string;
    reconstructionSha256?: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
    verification: EvidenceVerificationResult;
  }> = [];
  try {
    for (const root of roots) {
      const record = await readOptionalJson(path.join(root, "multipart.json"), MAX_MANIFEST_BYTES);
      if (!record
        || (record.schemaVersion !== 1 && record.schemaVersion !== 2)
        || !Number.isSafeInteger(record.partNumber) || (record.partNumber as number) < 1
        || !Number.isSafeInteger(record.totalParts) || (record.totalParts as number) < 1
        || (record.totalParts as number) > 1_024
        || typeof record.archiveRoot !== "string" || !record.archiveRoot
        || !Array.isArray(record.includedFiles)
        || record.noTruncation !== true) throw new Error("multipart-metadata-invalid");
      const manifest = validateManifest(await readOptionalJson(path.join(root, "manifest.json"), MAX_MANIFEST_BYTES) ?? {});
      const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
      let files: Array<{ path: string; bytes: number; sha256: string }>;
      if (record.schemaVersion === 2) {
        if (typeof record.reconstructionSha256 !== "string" || !SHA256_PATTERN.test(record.reconstructionSha256)
          || !Array.isArray(record.files)) throw new Error("multipart-reconstruction-metadata-invalid");
        files = record.files.map((candidate) => {
          if (!isRecord(candidate)
            || typeof candidate.path !== "string"
            || !Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) < 0
            || typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
            throw new Error("multipart-file-entry-invalid");
          }
          const manifestEntry = manifestByPath.get(candidate.path);
          if (!manifestEntry || manifestEntry.bytes !== candidate.bytes || manifestEntry.sha256 !== candidate.sha256) {
            throw new Error(`multipart-manifest-mismatch:${candidate.path}`);
          }
          return { path: candidate.path, bytes: candidate.bytes as number, sha256: candidate.sha256 };
        });
      } else {
        // Legacy multipart metadata has no cross-part digest. Retain readable
        // verification by using each part manifest's own signed inventory.
        files = (record.includedFiles as unknown[]).map((candidate) => {
          if (typeof candidate !== "string") throw new Error("multipart-included-file-invalid");
          const manifestEntry = manifestByPath.get(candidate);
          if (!manifestEntry) throw new Error(`multipart-manifest-mismatch:${candidate}`);
          return { path: candidate, bytes: manifestEntry.bytes, sha256: manifestEntry.sha256 };
        });
      }
      const included = record.includedFiles as unknown[];
      if (included.length !== files.length || included.some((candidate, index) => candidate !== files[index].path)) {
        throw new Error("multipart-included-file-list-mismatch");
      }
      parts.push({
        root,
        partNumber: record.partNumber as number,
        totalParts: record.totalParts as number,
        archiveRoot: record.archiveRoot,
        ...(record.schemaVersion === 2 ? { reconstructionSha256: record.reconstructionSha256 as string } : {}),
        files,
        verification: await verifyEvidenceDirectory(root, options),
      });
    }
  } catch (error) {
    return { outcome: "FAIL", partsVerified: parts.length, reasons: [error instanceof Error ? error.message : "multipart-verification-failed"] };
  }

  const totalParts = parts[0].totalParts;
  if (parts.some((part) => part.totalParts !== totalParts || part.archiveRoot !== parts[0].archiveRoot)) {
    return { outcome: "FAIL", partsVerified: parts.length, totalParts, reasons: ["multipart-set-metadata-mismatch"] };
  }
  const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  if (ordered.length !== totalParts || ordered.some((part, index) => part.partNumber !== index + 1)) {
    return { outcome: "INCOMPLETE", partsVerified: parts.length, totalParts, reasons: ["multipart-parts-missing-or-duplicate"] };
  }
  if (ordered.some((part) => part.verification.outcome === "FAIL")) {
    return {
      outcome: "FAIL",
      partsVerified: parts.length,
      totalParts,
      reasons: ordered.flatMap((part) => part.verification.outcome === "FAIL"
        ? part.verification.reasons.map((reason) => `part-${part.partNumber}:${reason}`)
        : []).sort(),
    };
  }
  const files = ordered.flatMap((part) => part.files);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    return { outcome: "FAIL", partsVerified: parts.length, totalParts, reasons: ["multipart-file-duplicate"] };
  }
  const reconstructionSha256 = sha256Bytes(
    [...files].sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.sha256} ${file.bytes} ${file.path}\n`).join(""),
  );
  const committedDigests = new Set(ordered.map((part) => part.reconstructionSha256).filter(Boolean));
  if (committedDigests.size > 1 || (committedDigests.size === 1 && !committedDigests.has(reconstructionSha256))) {
    return { outcome: "FAIL", partsVerified: parts.length, totalParts, reconstructionSha256, reasons: ["multipart-reconstruction-hash-mismatch"] };
  }
  const incomplete = ordered.some((part) => part.verification.outcome === "INCOMPLETE");
  return {
    outcome: incomplete ? "INCOMPLETE" : "PASS",
    partsVerified: parts.length,
    totalParts,
    reconstructionSha256,
    reasons: incomplete
      ? ordered.flatMap((part) => part.verification.outcome === "INCOMPLETE"
        ? part.verification.reasons.map((reason) => `part-${part.partNumber}:${reason}`)
        : []).sort()
      : [],
  };
}

export function legacyStatusForLifecycle(lifecycle: EvidenceLifecycle): EvidenceSession["status"] {
  if (lifecycle === "Active") return "recording";
  if (lifecycle === "Corrupt") return "storage-error";
  return "closed";
}
