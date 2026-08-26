#!/usr/bin/node
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { validateBandCatalog, validateOperationalSettings } from "../shared/settings";
import type { BandCatalog, OperationalSettings } from "../shared/types";
import { operationalConfigurationHash } from "./config";
import {
  runV6ConductedQualification,
  sha256CanonicalV6,
  validateV6ApprovedBinding,
  verifyV6ConductedBundle,
  writeV6ConductedBundle,
  type V6ApprovedBinding,
  type V6CandidateContext,
  type V6WitnessContext,
} from "./conductedRfQualification";
import { readFrozenCandidateIdentity } from "./syntheticQualificationCampaign";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

interface CliOptions {
  repositoryRoot: string;
  campaignRoot: string;
  outputRoot: string;
  catalogPath: string;
  operationalPath: string;
  approvedBindingPath: string;
  approvedBindingSha256: string;
  witnessPublicKeyPath: string;
  witnessKeySha256: string;
  runId?: string;
}

function usage(): string {
  return [
    "Usage: conducted-rf-qualification --campaign PATH --approved-binding PATH [options]",
    "",
    "Required:",
    "  --campaign PATH                  Sealed, read-only, witnessed conducted-RF campaign",
    "  --approved-binding PATH          Separately approved exact site/receiver/chain binding",
    "  --approved-binding-sha256 HEX    Out-of-band canonical SHA-256 of the approved binding",
    "  --witness-public-key PATH        Separately supplied Ed25519 public key",
    "  --witness-key-sha256 HEX         Out-of-band SHA-256 of the public SPKI DER",
    "",
    "Options:",
    "  --repository-root PATH           Frozen RF Monitor release candidate (default: current directory)",
    "  --catalog PATH                   Exact schema-v3 band catalog",
    "  --operational PATH               Exact schema-v3 operational settings",
    "  --output-root PATH               V6 result root (default: artifacts/validation/v6)",
    "  --run-id ID                      Stable run id for a controlled rerun",
    "",
    "The command fails closed before writing a result when candidate, V0-V5, site,",
    "receiver, chain, baseline, calibration, custody, tree, signature, or domain",
    "bindings are absent or stale. A mechanically failed physical campaign is retained",
    "as FAIL. A V6 result never makes the installation production-ready.",
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
  const known = new Set(["--repository-root", "--campaign", "--output-root", "--catalog", "--operational", "--approved-binding", "--approved-binding-sha256", "--witness-public-key", "--witness-key-sha256", "--run-id"]);
  if (args.length % 2 !== 0) throw new Error(`Unexpected argument: ${args.at(-1)}`);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index])) throw new Error(`Unknown V6 option ${args[index]}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${args[index]} requires a value`);
  }
  const campaign = optionValue(args, "--campaign");
  const approvedBinding = optionValue(args, "--approved-binding");
  const approvedBindingSha256 = optionValue(args, "--approved-binding-sha256");
  const witnessPublicKey = optionValue(args, "--witness-public-key");
  const witnessKeySha256 = optionValue(args, "--witness-key-sha256");
  if (!campaign) throw new Error("V6 is not run: --campaign is required");
  if (!approvedBinding || !approvedBindingSha256) throw new Error("V6 is not run: separately supplied --approved-binding and --approved-binding-sha256 are required");
  if (!witnessPublicKey || !witnessKeySha256) throw new Error("V6 is not run: separately supplied --witness-public-key and --witness-key-sha256 are required");
  const repositoryRoot = path.resolve(optionValue(args, "--repository-root") ?? process.cwd());
  return {
    repositoryRoot,
    campaignRoot: path.resolve(campaign),
    outputRoot: path.resolve(optionValue(args, "--output-root") ?? path.join(repositoryRoot, "artifacts", "validation", "v6")),
    catalogPath: path.resolve(optionValue(args, "--catalog") ?? process.env.RF_MONITOR_CATALOG_FILE ?? path.join(repositoryRoot, "config", "band-catalog.example.json")),
    operationalPath: path.resolve(optionValue(args, "--operational") ?? process.env.RF_MONITOR_OPERATIONAL_FILE ?? path.join(repositoryRoot, "config", "operational.example.json")),
    approvedBindingPath: path.resolve(approvedBinding),
    approvedBindingSha256,
    witnessPublicKeyPath: path.resolve(witnessPublicKey),
    witnessKeySha256,
    runId: optionValue(args, "--run-id"),
  };
}

function pathsOverlap(left: string, right: string): boolean {
  const forward = path.relative(left, right);
  const reverse = path.relative(right, left);
  return forward === "" || (!forward.startsWith("..") && !path.isAbsolute(forward)) || (!reverse.startsWith("..") && !path.isAbsolute(reverse));
}

async function readRegularNoSymlink(filePath: string, label: string, maximumBytes: number): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0 || details.size > maximumBytes) throw new Error(`${label} is missing, linked, or outside its byte bound`);
  if (await realpath(resolved) !== resolved) throw new Error(`${label} may not use symlinked path components`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(resolved, constants.O_RDONLY | noFollow);
  try {
    const bytes = Buffer.allocUnsafe(details.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readJson<T>(filePath: string, label: string): Promise<T> {
  const bytes = await readRegularNoSymlink(filePath, label, MAX_JSON_BYTES);
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw new Error(`${label} is not valid JSON`); }
}

async function candidateContext(options: CliOptions): Promise<V6CandidateContext> {
  const [release, rawCatalog, rawOperational] = await Promise.all([
    readFrozenCandidateIdentity(options.repositoryRoot),
    readJson<BandCatalog>(options.catalogPath, "V6 catalog"),
    readJson<OperationalSettings>(options.operationalPath, "V6 operational settings"),
  ]);
  const catalog = validateBandCatalog(rawCatalog);
  const operational = validateOperationalSettings(rawOperational, catalog);
  return {
    release,
    catalog,
    configurationSha256: operationalConfigurationHash(operational, catalog.catalogVersion),
    catalogSha256: sha256CanonicalV6(catalog),
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (process.execPath !== "/usr/bin/node") throw new Error(`V6 qualification requires /usr/bin/node; current executable is ${process.execPath}`);
  const options = parseOptions(process.argv.slice(2));
  if (pathsOverlap(options.outputRoot, options.campaignRoot)) throw new Error("V6 output root must be outside the sealed campaign tree");
  if (pathsOverlap(options.campaignRoot, options.approvedBindingPath) || pathsOverlap(options.campaignRoot, options.witnessPublicKeyPath)) throw new Error("V6 approved binding and witness key must be supplied outside the campaign tree");
  const [candidate, approvedBinding, witnessKeyBytes] = await Promise.all([
    candidateContext(options),
    readJson<V6ApprovedBinding>(options.approvedBindingPath, "V6 approved binding"),
    readRegularNoSymlink(options.witnessPublicKeyPath, "V6 witness public key", MAX_KEY_BYTES),
  ]);
  validateV6ApprovedBinding(approvedBinding, candidate);
  if (sha256CanonicalV6(approvedBinding) !== options.approvedBindingSha256) throw new Error("V6 approved binding does not match its out-of-band pinned hash");
  const witness: V6WitnessContext = { publicKeyPem: witnessKeyBytes, expectedKeySha256: options.witnessKeySha256 };
  process.stdout.write(`V6 installed-chain campaign: ${options.campaignRoot}\n`);
  process.stdout.write(`Frozen candidate: ${candidate.release.buildId}\n`);
  process.stdout.write(`Receiver: ${approvedBinding.receiver.model} / ${approvedBinding.receiver.serialSha256.slice(0, 12)}…\n`);
  const report = await runV6ConductedQualification({
    campaignRoot: options.campaignRoot,
    candidate,
    approvedBinding,
    approvedBindingSha256: options.approvedBindingSha256,
    witness,
    runId: options.runId,
  });
  const bundle = await writeV6ConductedBundle(options.outputRoot, report);
  const verification = await verifyV6ConductedBundle(bundle, witness);
  process.stdout.write(`Cases: ${report.counts.cases}; failed: ${report.counts.failed}; unknown: ${report.counts.unknown}\n`);
  process.stdout.write(`Artifact: ${bundle}\n`);
  process.stdout.write(`Artifact verification: ${verification.outcome}\n`);
  process.stdout.write(`V6 decision: ${report.result.gateDecision.toUpperCase()}\n`);
  process.stdout.write("Development qualified: NO (V7 and exact external V0-V7 approval remain separate)\n");
  if (report.result.gateDecision !== "passed") process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`V6 NOT RUN: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
