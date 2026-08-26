#!/usr/bin/node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateBandCatalog } from "../shared/settings";
import type { BandCatalog } from "../shared/types";
import {
  executeV4DetectorCampaign,
  readFrozenCandidateIdentity,
  verifyV4CampaignBundle,
} from "./syntheticQualificationCampaign";

interface CliOptions {
  repositoryRoot: string;
  outputRoot: string;
  catalogPath: string;
  protectedFieldRoot: string;
  campaignId?: string;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(args: string[]): CliOptions {
  const known = new Set(["--repository-root", "--output-root", "--catalog", "--field-root", "--campaign-id"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index])) throw new Error(`Unknown V4 option ${args[index]}`);
    if (!args[index + 1]) throw new Error(`${args[index]} requires a value`);
  }
  const repositoryRoot = path.resolve(optionValue(args, "--repository-root") ?? process.cwd());
  const storageRoot = path.resolve(process.env.RF_MONITOR_STORAGE ?? path.join(repositoryRoot, "evidence"));
  return {
    repositoryRoot,
    outputRoot: path.resolve(optionValue(args, "--output-root") ?? path.join(repositoryRoot, "artifacts", "validation", "v4")),
    catalogPath: path.resolve(optionValue(args, "--catalog") ?? process.env.RF_MONITOR_CATALOG_FILE ?? path.join(repositoryRoot, "config", "band-catalog.example.json")),
    protectedFieldRoot: path.resolve(optionValue(args, "--field-root") ?? process.env.RF_MONITOR_FIELD_DATA_ROOT ?? path.join(storageRoot, "field")),
    campaignId: optionValue(args, "--campaign-id"),
  };
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

async function main(): Promise<void> {
  if (process.execPath !== "/usr/bin/node") throw new Error(`V4 qualification requires /usr/bin/node; current executable is ${process.execPath}`);
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: synthetic-qualification-campaign [--repository-root PATH] [--output-root PATH] [--catalog PATH] [--field-root PATH] [--campaign-id ID]\n");
    process.stdout.write("Runs the frozen 16,040-case conditional detector campaign. Overall V4 remains not-passed until packaged end-to-end qualification.\n");
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const candidate = await readFrozenCandidateIdentity(options.repositoryRoot);
  const catalog = validateBandCatalog(JSON.parse(await readFile(options.catalogPath, "utf8")) as BandCatalog);
  const campaignId = options.campaignId ?? `${timestampId(new Date())}-${candidate.buildId}`;
  process.stdout.write(`V4 conditional detector campaign ${campaignId}\n`);
  process.stdout.write(`Frozen candidate ${candidate.buildId} ${candidate.sourceDigest}\n`);
  process.stdout.write("Planned cases 16040 (40 deterministic + 16000 randomized)\n");
  let lastReported = 0;
  const result = await executeV4DetectorCampaign({
    repositoryRoot: options.repositoryRoot,
    outputRoot: options.outputRoot,
    campaignId,
    catalog,
    candidate,
    readCandidate: () => readFrozenCandidateIdentity(options.repositoryRoot),
    protectedFieldRoot: options.protectedFieldRoot,
    onProgress: (completed, total) => {
      if (completed === total || completed - lastReported >= 500) {
        lastReported = completed;
        process.stdout.write(`Completed ${completed}/${total}\n`);
      }
    },
  });
  if (result.state !== "complete" || !result.report) throw new Error(`V4 campaign paused at ${result.completedCases}/${result.totalCases}`);
  const verification = await verifyV4CampaignBundle(result.bundlePath);
  process.stdout.write(`Bundle ${result.bundlePath}\n`);
  process.stdout.write(`Bundle verification PASS (${verification.files} hashed files)\n`);
  process.stdout.write(`Conditional detector statistical sub-gate ${result.report.result.detectorStatisticalSubGate.toUpperCase()}\n`);
  process.stdout.write(`Overall V4 ${result.report.result.overallV4.toUpperCase()}\n`);
  if (result.report.result.detectorStatisticalSubGate !== "passed") process.exitCode = 1;
}

await main();
