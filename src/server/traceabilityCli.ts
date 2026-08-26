import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RELEASE_PACKAGE_ROOTS,
  RELEASE_SOURCE_ROOTS,
  digestReleaseFiles,
} from "../../scripts/release-digest-policy.mjs";
import {
  type TraceabilityMatrix,
  type TraceabilityReference,
  type TraceabilityReleaseBinding,
  type TraceabilityValidationReport,
  extractExecutableTraceabilityAssertions,
  validateTraceabilityMatrix,
} from "../shared/traceability";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const DEFAULT_MATRIX_PATH = "config/qualification-traceability.json";
const DEFAULT_ROADMAP_PATH = "docs/production-development-roadmap.md";
const MAX_MATRIX_BYTES = 2 * 1024 * 1024;
const MAX_ROADMAP_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_METADATA_BYTES = 64 * 1024;
const MAX_AUTOMATED_TEST_BYTES = 2 * 1024 * 1024;

export interface TraceabilityCliOptions {
  repositoryRoot?: string;
  matrixPath?: string;
  roadmapPath?: string;
  /** False validates the registry only; a path binds it to a verified release. */
  releasePath?: string | false;
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 300) throw new Error(`${label} is invalid`);
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return normalized;
}

async function regularRepositoryFile(repositoryRoot: string, relativePath: string, label: string): Promise<string> {
  const safePath = safeRelativePath(relativePath, label);
  let current = repositoryRoot;
  const segments = safePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${safePath}`);
    if (index < segments.length - 1 && !metadata.isDirectory()) throw new Error(`${label} parent is not a directory: ${safePath}`);
    if (index === segments.length - 1 && !metadata.isFile()) throw new Error(`${label} is not a regular file: ${safePath}`);
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error(`${label} escapes the repository: ${safePath}`);
  return current;
}

async function boundedRead(filePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  const contents = await readFile(filePath);
  if (contents.byteLength > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  return contents;
}

function sameRelease(left: TraceabilityReleaseBinding, right: TraceabilityReleaseBinding): boolean {
  return left.buildId === right.buildId
    && left.sourceDigest === right.sourceDigest
    && left.packageDigest === right.packageDigest;
}

async function verifyImmutableArtifact(filePath: string, reference: TraceabilityReference, referenceId: string): Promise<void> {
  const contents = await boundedRead(filePath, MAX_ARTIFACT_RECORD_BYTES, `Immutable reference ${referenceId}`);
  let record: { release?: TraceabilityReleaseBinding };
  try {
    record = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Immutable reference ${referenceId} is not a JSON validation record`);
  }
  if (!reference.release || !record.release || !sameRelease(reference.release, record.release)) {
    throw new Error(`Immutable reference ${referenceId} release identity does not match its record`);
  }
}

async function verifyExternalRelease(repositoryRoot: string, releaseRelative: string): Promise<TraceabilityReleaseBinding> {
  const releaseFile = await regularRepositoryFile(repositoryRoot, releaseRelative, "External release metadata");
  let release: TraceabilityReleaseBinding & {
    schemaVersion?: number;
    product?: string;
    releaseVersion?: string;
    dependencyLockDigest?: string;
  };
  try {
    release = JSON.parse((await boundedRead(releaseFile, MAX_RELEASE_METADATA_BYTES, "Frozen release metadata")).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("External release metadata is not valid JSON");
    throw error;
  }
  if (release.schemaVersion !== 1 || release.product !== "rf-monitor"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(String(release.buildId ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(release.sourceDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(release.packageDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(release.dependencyLockDigest ?? ""))) {
    throw new Error("External release metadata is missing or unsupported");
  }
  const [sourceDigest, packageDigest, dependencyLockDigest, packageJson, clientIndex] = await Promise.all([
    digestReleaseFiles(repositoryRoot, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(repositoryRoot, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable"),
    digestReleaseFiles(repositoryRoot, ["package-lock.json"], "rf-monitor-lock-unavailable"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "dist/client/index.html"), "utf8"),
  ]);
  if (sourceDigest !== release.sourceDigest || packageDigest !== release.packageDigest || dependencyLockDigest !== release.dependencyLockDigest) {
    throw new Error("External release binding is stale for the current source/package/lock tree");
  }
  if (packageJson?.version !== release.releaseVersion) throw new Error("External release version differs from package.json");
  const embeddedIds = [...clientIndex.matchAll(/<meta\s+name=["']rf-monitor-client-build-id["']\s+content=["']([^"']+)["']\s*\/?>/g)].map((match) => match[1]);
  if (embeddedIds.length !== 1 || embeddedIds[0] !== release.buildId) throw new Error("External release does not match the packaged client identity");
  return { buildId: release.buildId, sourceDigest, packageDigest };
}

function referencedPaths(matrix: TraceabilityMatrix): Array<{ path: string; label: string; reference?: TraceabilityReference; referenceId?: string }> {
  const result: Array<{ path: string; label: string; reference?: TraceabilityReference; referenceId?: string }> = [];
  for (const [index, source] of (Array.isArray(matrix.authoritativeSources) ? matrix.authoritativeSources : []).entries()) {
    result.push({ path: safeRelativePath(source, `authoritativeSources[${index}]`), label: `Authoritative source ${index + 1}` });
  }
  if (matrix.references && typeof matrix.references === "object" && !Array.isArray(matrix.references)) {
    for (const [referenceId, reference] of Object.entries(matrix.references)) {
      if (reference?.path !== undefined) {
        result.push({
          path: safeRelativePath(reference.path, `Reference ${referenceId} path`),
          label: `Reference ${referenceId}`,
          reference,
          referenceId,
        });
      }
    }
  }
  return result;
}

export async function runTraceabilityValidation(options: TraceabilityCliOptions = {}): Promise<TraceabilityValidationReport> {
  const repositoryRoot = await realpath(path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT));
  const matrixRelative = safeRelativePath(options.matrixPath ?? DEFAULT_MATRIX_PATH, "Matrix path");
  const roadmapRelative = safeRelativePath(options.roadmapPath ?? DEFAULT_ROADMAP_PATH, "Roadmap path");
  const matrixFile = await regularRepositoryFile(repositoryRoot, matrixRelative, "Traceability matrix");
  const roadmapFile = await regularRepositoryFile(repositoryRoot, roadmapRelative, "Roadmap");
  let matrix: TraceabilityMatrix;
  try {
    matrix = JSON.parse((await boundedRead(matrixFile, MAX_MATRIX_BYTES, "Traceability matrix")).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Traceability matrix is not valid JSON");
    throw error;
  }
  const releaseRelative = options.releasePath === false || options.releasePath === undefined
    ? undefined
    : safeRelativePath(options.releasePath, "Release path");
  const release = releaseRelative ? await verifyExternalRelease(repositoryRoot, releaseRelative) : undefined;
  const existingPaths = new Set<string>();
  const executableAssertions = new Map<string, ReadonlySet<string>>();
  for (const entry of referencedPaths(matrix)) {
    const filePath = await regularRepositoryFile(repositoryRoot, entry.path, entry.label);
    existingPaths.add(entry.path);
    if (entry.reference?.kind === "immutable-artifact") {
      await verifyImmutableArtifact(filePath, entry.reference, entry.referenceId ?? "unknown");
    } else if (entry.reference?.kind === "automated-test") {
      const referenceId = entry.referenceId ?? "unknown";
      const source = (await boundedRead(filePath, MAX_AUTOMATED_TEST_BYTES, `Automated reference ${referenceId}`)).toString("utf8");
      executableAssertions.set(referenceId, extractExecutableTraceabilityAssertions(source, `Automated reference ${referenceId}`));
    }
  }
  const roadmapText = (await boundedRead(roadmapFile, MAX_ROADMAP_BYTES, "Roadmap")).toString("utf8");
  return validateTraceabilityMatrix(matrix, { roadmapText, existingPaths, executableAssertions, release });
}

interface ParsedArguments {
  help: boolean;
  matrixPath?: string;
  roadmapPath?: string;
  releasePath?: string;
  unbound: boolean;
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const parsed: ParsedArguments = { help: false, unbound: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--matrix" || argument === "--roadmap" || argument === "--release") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a repository-relative path`);
      if (argument === "--matrix") parsed.matrixPath = value;
      else if (argument === "--roadmap") parsed.roadmapPath = value;
      else parsed.releasePath = value;
      index += 1;
    } else if (argument === "--unbound") parsed.unbound = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (parsed.unbound && parsed.releasePath) throw new Error("--unbound and --release are mutually exclusive");
  return parsed;
}

function usage(): string {
  return [
    "Usage: /usr/bin/node dist/server-node/traceability.js [options]",
    "",
    "Options:",
    "  --matrix <path>   Matrix path (default: config/qualification-traceability.json)",
    "  --roadmap <path>  Roadmap path (default: docs/production-development-roadmap.md)",
    "  --release <path>  Bind to verified release metadata (default: dist/release.json)",
    "  --unbound         Validate the source registry without qualifying a release",
    "  --help            Show this help",
  ].join("\n");
}

async function main(): Promise<void> {
  if (process.execPath !== "/usr/bin/node") throw new Error(`Qualification requires /usr/bin/node; received ${process.execPath}`);
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await runTraceabilityValidation({
    matrixPath: parsed.matrixPath,
    roadmapPath: parsed.roadmapPath,
    releasePath: parsed.unbound ? false : (parsed.releasePath ?? "dist/release.json"),
  });
  process.stdout.write(`${JSON.stringify({ ...report, nodeExecutable: process.execPath }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
