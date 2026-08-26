#!/usr/bin/node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { detectionRuleFingerprint } from "../shared/detection";
import { validateBandCatalog, validateOperationalSettings } from "../shared/settings";
import type { BandCatalog, OperationalSettings } from "../shared/types";
import { operationalConfigurationHash } from "./config";
import {
  runV5HeldOutReplay,
  sha256CanonicalV5,
  verifyV5ReplayBundle,
  verifyV5ReplayBundleAgainstCorpus,
  writeV5ReplayBundle,
  type V5CandidateContext,
  type V5WitnessContext,
} from "./heldOutReplayQualification";
import { readFrozenCandidateIdentity } from "./syntheticQualificationCampaign";

interface CliOptions {
  repositoryRoot: string;
  corpusRoot: string;
  outputRoot: string;
  catalogPath: string;
  operationalPath: string;
  protectedFieldRoot: string;
  witnessPublicKeyPath: string;
  witnessKeySha256: string;
  verifyBundleRoot?: string;
  runId?: string;
}

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

function usage(): string {
  return [
    "Usage: held-out-replay-qualification --corpus PATH [options]",
    "",
    "Required:",
    "  --corpus PATH          Independently sealed real normalized-uint8 FFT corpus",
    "  --witness-public-key PATH  Separately supplied pinned Ed25519 witness public key",
    "  --witness-key-sha256 HEX   Out-of-band approved SHA-256 of the public SPKI DER",
    "",
    "Options:",
    "  --repository-root PATH Frozen RF Monitor release candidate (default: current directory)",
    "  --catalog PATH          Exact schema-v3 catalog used by the candidate",
    "  --operational PATH      Exact schema-v3 operational settings used by the candidate",
    "  --field-root PATH       Protected field-data root checked byte-for-byte for isolation",
    "  --output-root PATH      Validation artifact root (default: artifacts/validation/v5)",
    "  --run-id ID             Stable run id for a controlled rerun",
    "  --verify-bundle PATH    Recompute and verify an existing result against the sealed corpus",
    "",
    "The command fails closed and writes no result when corpus, precommitment, truth,",
    "candidate, configuration, rule, receiver, grid, or fingerprint binding is missing.",
  ].join("\n");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(args: string[]): CliOptions {
  const known = new Set(["--repository-root", "--corpus", "--output-root", "--catalog", "--operational", "--field-root", "--witness-public-key", "--witness-key-sha256", "--run-id", "--verify-bundle"]);
  if (args.length % 2 !== 0) throw new Error(`Unexpected argument: ${args.at(-1)}`);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index])) throw new Error(`Unknown V5 option ${args[index]}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${args[index]} requires a value`);
  }
  const corpus = optionValue(args, "--corpus");
  if (!corpus) throw new Error("V5 is not run: --corpus must name an independently sealed held-out corpus");
  const witnessPublicKeyPath = optionValue(args, "--witness-public-key");
  const witnessKeySha256 = optionValue(args, "--witness-key-sha256");
  if (!witnessPublicKeyPath || !witnessKeySha256) throw new Error("V5 is not run: a separately supplied --witness-public-key and --witness-key-sha256 are required");
  const repositoryRoot = path.resolve(optionValue(args, "--repository-root") ?? process.cwd());
  const storageRoot = path.resolve(process.env.RF_MONITOR_STORAGE ?? path.join(repositoryRoot, "evidence"));
  return {
    repositoryRoot,
    corpusRoot: path.resolve(corpus),
    outputRoot: path.resolve(optionValue(args, "--output-root") ?? path.join(repositoryRoot, "artifacts", "validation", "v5")),
    catalogPath: path.resolve(optionValue(args, "--catalog") ?? process.env.RF_MONITOR_CATALOG_FILE ?? path.join(repositoryRoot, "config", "band-catalog.example.json")),
    operationalPath: path.resolve(optionValue(args, "--operational") ?? process.env.RF_MONITOR_OPERATIONAL_FILE ?? path.join(repositoryRoot, "config", "operational.example.json")),
    protectedFieldRoot: path.resolve(optionValue(args, "--field-root") ?? process.env.RF_MONITOR_FIELD_DATA_ROOT ?? path.join(storageRoot, "field")),
    witnessPublicKeyPath: path.resolve(witnessPublicKeyPath),
    witnessKeySha256,
    verifyBundleRoot: optionValue(args, "--verify-bundle") ? path.resolve(optionValue(args, "--verify-bundle")!) : undefined,
    runId: optionValue(args, "--run-id"),
  };
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const inverse = path.relative(right, left);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) || (!inverse.startsWith("..") && !path.isAbsolute(inverse));
}

async function readBoundedJson<T>(filePath: string, label: string): Promise<T> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds its file bound`);
    const bytes = Buffer.allocUnsafe(details.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) throw new Error(`${label} was truncated while reading`);
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  } finally {
    await handle.close();
  }
}

async function readBoundedBytes(filePath: string, label: string, maximumBytes: number): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) throw new Error(`${label} exceeds its file bound`);
    const bytes = Buffer.allocUnsafe(details.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) throw new Error(`${label} was truncated while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function candidateContext(options: CliOptions): Promise<V5CandidateContext> {
  const [release, rawCatalog, rawOperational] = await Promise.all([
    readFrozenCandidateIdentity(options.repositoryRoot),
    readBoundedJson<BandCatalog>(options.catalogPath, "V5 catalog"),
    readBoundedJson<OperationalSettings>(options.operationalPath, "V5 operational settings"),
  ]);
  const catalog = validateBandCatalog(rawCatalog);
  const operationalSettings = validateOperationalSettings(rawOperational, catalog);
  return {
    release,
    catalog,
    operationalSettings,
    configurationHash: operationalConfigurationHash(operationalSettings, catalog.catalogVersion),
    catalogHash: sha256CanonicalV5(catalog),
    detectorRuleHash: detectionRuleFingerprint(operationalSettings.detection),
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (process.execPath !== "/usr/bin/node") throw new Error(`V5 qualification requires /usr/bin/node; current executable is ${process.execPath}`);
  const options = parseOptions(process.argv.slice(2));
  if (pathsOverlap(options.outputRoot, options.corpusRoot)) throw new Error("V5 output root must be outside the immutable corpus root");
  if (pathsOverlap(options.outputRoot, options.protectedFieldRoot)) throw new Error("V5 output root must be outside protected field data");
  const candidate = await candidateContext(options);
  const witness: V5WitnessContext = {
    publicKeyPem: await readBoundedBytes(options.witnessPublicKeyPath, "V5 witness public key", 64 * 1024),
    expectedKeySha256: options.witnessKeySha256,
  };
  if (options.verifyBundleRoot) {
    const verified = await verifyV5ReplayBundleAgainstCorpus(options.verifyBundleRoot, {
      corpusRoot: options.corpusRoot,
      protectedFieldRoot: options.protectedFieldRoot,
      candidate,
      witness,
    });
    process.stdout.write(`V5 bundle: ${options.verifyBundleRoot}\n`);
    process.stdout.write(`Corpus tree: ${verified.corpusTreeSha256}\n`);
    process.stdout.write(`Independent replay: PASS\n`);
    process.stdout.write(`V5 decision: ${verified.gateDecision.toUpperCase()}\n`);
    process.stdout.write("Production ready: NO (live V6 and V7 remain)\n");
    if (verified.gateDecision !== "passed") process.exitCode = 1;
    return;
  }
  process.stdout.write(`V5 held-out FFT replay: ${options.corpusRoot}\n`);
  process.stdout.write(`Frozen candidate: ${candidate.release.buildId}\n`);
  const report = await runV5HeldOutReplay({
    corpusRoot: options.corpusRoot,
    protectedFieldRoot: options.protectedFieldRoot,
    candidate,
    witness,
    runId: options.runId,
  });
  const bundle = await writeV5ReplayBundle(options.outputRoot, report);
  const bundleVerification = await verifyV5ReplayBundle(bundle, witness);
  process.stdout.write(`Sessions: ${report.counts.sessions}\n`);
  process.stdout.write(`Unknown: ${report.counts.unknown}; unobserved: ${report.counts.unobserved}\n`);
  process.stdout.write(`Artifact: ${bundle}\n`);
  process.stdout.write(`Artifact verification: ${bundleVerification.outcome} (${bundleVerification.filesVerified} hashed payload files)\n`);
  process.stdout.write(`V5 decision: ${report.result.gateDecision.toUpperCase()}\n`);
  process.stdout.write("Production ready: NO (live V6 and V7 remain)\n");
  if (report.result.gateDecision !== "passed") process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`V5 NOT RUN: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
