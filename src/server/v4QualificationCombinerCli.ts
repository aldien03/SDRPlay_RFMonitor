#!/usr/bin/node
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectionRuleFingerprint } from "../shared/detection";
import { validateBandCatalog, validateOperationalSettings } from "../shared/settings";
import type { BandCatalog, OperationalSettings } from "../shared/types";
import { operationalConfigurationHash } from "./config";
import { readFrozenCandidateIdentity } from "./syntheticQualificationCampaign";
import {
  combineV4Qualification,
  sha256CanonicalV4,
  verifyV4CombinedBundle,
  type V4CombinedIdentity,
} from "./v4QualificationCombiner";

interface CombineCommand {
  command: "combine";
  repositoryRoot: string;
  packagedBundle: string;
  detectorBundle: string;
  catalogPath: string;
  operationalPath: string;
  outputRoot: string;
  resultId?: string;
}

interface VerifyCommand {
  command: "verify";
  bundlePath: string;
}

interface HelpCommand { command: "help" }

export type V4CombineCliCommand = CombineCommand | VerifyCommand | HelpCommand;

export const V4_COMBINE_HELP = [
  "Usage:",
  "  npm run validate:v4 -- combine --packaged-bundle PATH --detector-bundle PATH [options]",
  "  npm run validate:v4 -- verify --bundle PATH",
  "  npm run validate:v4 -- --help",
  "",
  "Combine required options:",
  "  --packaged-bundle PATH  Immutable passing packaged V4 sub-gate bundle",
  "  --detector-bundle PATH  Immutable passing 16,040-case detector bundle",
  "",
  "Combine options:",
  "  --repository-root PATH  Frozen candidate root (default: current directory)",
  "  --catalog PATH          Exact catalog loaded by both sub-gates",
  "  --operational PATH      Exact operational configuration loaded by packaged V4",
  "  --output-root PATH      Combined artifact root (default: artifacts/validation/v4)",
  "  --result-id ID          Immutable output name (default: timestamp-build-id)",
  "",
  "The command only combines and independently verifies existing sub-gates. It does",
  "not run either sub-gate. V4 is synthetic software evidence and cannot satisfy the",
  "live field-domain V5, V6, bounded 24-hour V7, or production-readiness gates.",
].join("\n");

function takeOptions(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.has(name)) throw new Error(`Unknown V4 combine option ${name}`);
    if (options.has(name)) throw new Error(`Duplicate V4 combine option ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options.set(name, value);
    index += 1;
  }
  return options;
}

export function parseV4CombineArguments(args: string[], cwd = process.cwd()): V4CombineCliCommand {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "help" };
  const command = args[0];
  if (command !== "combine" && command !== "verify") throw new Error(command ? `Unknown V4 combine command ${command}` : "V4 combine command is required");
  if (args.length === 2 && ["--help", "-h"].includes(args[1])) return { command: "help" };
  if (args.slice(1).some((value) => value === "--help" || value === "-h")) throw new Error("--help must be used alone or immediately after the command");
  if (command === "verify") {
    const options = takeOptions(args.slice(1), new Set(["--bundle"]));
    const bundle = options.get("--bundle");
    if (!bundle) throw new Error("verify requires --bundle");
    return { command, bundlePath: path.resolve(cwd, bundle) };
  }
  const allowed = new Set(["--repository-root", "--packaged-bundle", "--detector-bundle", "--catalog", "--operational", "--output-root", "--result-id"]);
  const options = takeOptions(args.slice(1), allowed);
  const repositoryRoot = path.resolve(cwd, options.get("--repository-root") ?? ".");
  const packagedBundle = options.get("--packaged-bundle");
  const detectorBundle = options.get("--detector-bundle");
  if (!packagedBundle || !detectorBundle) throw new Error("combine requires --packaged-bundle and --detector-bundle");
  return {
    command,
    repositoryRoot,
    packagedBundle: path.resolve(cwd, packagedBundle),
    detectorBundle: path.resolve(cwd, detectorBundle),
    catalogPath: path.resolve(cwd, options.get("--catalog") ?? path.join(repositoryRoot, "config", "band-catalog.example.json")),
    operationalPath: path.resolve(cwd, options.get("--operational") ?? path.join(repositoryRoot, "config", "operational.example.json")),
    outputRoot: path.resolve(cwd, options.get("--output-root") ?? path.join(repositoryRoot, "artifacts", "validation", "v4")),
    resultId: options.get("--result-id"),
  };
}

async function readBoundedJson<T>(filePath: string, label: string): Promise<T> {
  const resolved = path.resolve(filePath);
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > 16 * 1024 * 1024
      || await realpath(resolved) !== resolved) throw new Error(`${label} is linked or outside its byte bound`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(resolved, constants.O_RDONLY | noFollow);
  try {
    const bytes = Buffer.allocUnsafe(details.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) throw new Error(`${label} changed while reading`);
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  } finally {
    await handle.close();
  }
}

async function readClientBuildId(repositoryRoot: string): Promise<string> {
  const clientIndexPath = path.join(repositoryRoot, "dist", "client", "index.html");
  const details = await lstat(clientIndexPath);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > 4 * 1024 * 1024
      || await realpath(clientIndexPath) !== clientIndexPath) throw new Error("Packaged client index is linked or outside its byte bound");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(clientIndexPath, constants.O_RDONLY | noFollow);
  const bytes = Buffer.allocUnsafe(details.size);
  try {
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) throw new Error("Packaged client index changed while reading");
  } finally {
    await handle.close();
  }
  const html = bytes.toString("utf8");
  const matches = [...html.matchAll(/<meta name="rf-monitor-client-build-id" content="([^"]+)"\s*\/?\s*>/g)].map((match) => match[1]);
  if (matches.length !== 1) throw new Error("Packaged client build identity is absent or ambiguous");
  return matches[0];
}

async function currentIdentity(command: CombineCommand): Promise<V4CombinedIdentity> {
  const [release, rawCatalog, rawOperational, clientBuildId] = await Promise.all([
    readFrozenCandidateIdentity(command.repositoryRoot),
    readBoundedJson<BandCatalog>(command.catalogPath, "V4 catalog"),
    readBoundedJson<OperationalSettings>(command.operationalPath, "V4 operational configuration"),
    readClientBuildId(command.repositoryRoot),
  ]);
  const catalog = validateBandCatalog(rawCatalog);
  const operational = validateOperationalSettings(rawOperational, catalog);
  if (clientBuildId !== release.buildId) throw new Error("Packaged client build does not match the frozen V4 release");
  return {
    release,
    clientBuildId,
    configurationSha256: operationalConfigurationHash(operational, catalog.catalogVersion),
    catalogVersion: catalog.catalogVersion,
    catalogSha256: sha256CanonicalV4(catalog),
    detectorRuleSetId: operational.detection.ruleSetId,
    detectorRuleSha256: detectionRuleFingerprint(operational.detection),
    expectedSampleRateHz: 10_000_000,
  };
}

function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

async function main(): Promise<void> {
  const command = parseV4CombineArguments(process.argv.slice(2));
  if (command.command === "help") {
    process.stdout.write(`${V4_COMBINE_HELP}\n`);
    return;
  }
  if (process.execPath !== "/usr/bin/node") throw new Error(`V4 combine requires /usr/bin/node; current executable is ${process.execPath}`);
  if (command.command === "verify") {
    const verification = await verifyV4CombinedBundle(command.bundlePath);
    process.stdout.write(`V4 bundle verification: PASS (${verification.files} files, ${verification.bytes} bytes)\n`);
    process.stdout.write("V4 decision: PASS\nProduction ready: NO (live field-domain V5-V7 remain)\n");
    return;
  }
  const identity = await currentIdentity(command);
  const resultId = command.resultId ?? `${timestampId()}-${identity.release.buildId}`;
  const combined = await combineV4Qualification({
    packagedBundle: command.packagedBundle,
    detectorBundle: command.detectorBundle,
    outputRoot: command.outputRoot,
    resultId,
    dependencies: { readCurrentIdentity: () => currentIdentity(command) },
  });
  process.stdout.write(`V4 combined bundle: ${combined.bundlePath}\n`);
  process.stdout.write(`V4 bundle verification: PASS (${combined.verification.files} files, ${combined.verification.bytes} bytes)\n`);
  process.stdout.write("V4 decision: PASS\nProduction ready: NO (live field-domain V5-V7 remain)\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(`V4 NOT RUN: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
