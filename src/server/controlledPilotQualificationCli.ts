#!/usr/bin/node
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  appendV9DailySummary,
  evaluateV9Pilot,
  finalizeV9Pilot,
  hashV9Record,
  initializeV9Pilot,
  verifyV9FinalBundle,
  verifyV9PilotEvidenceStatus,
  type V9Approval,
  type V9DailySummary,
  type V9InitializationPins,
  type V9OutOfBandPins,
  type V9PilotBinding,
  type V9TrustAnchors,
} from "./controlledPilotQualification";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function usage(): string {
  return [
    "Optional external V9 controlled-pilot record (site-owned; not a development gate)",
    "Usage: controlled-pilot-qualification <command> [options]",
    "",
    "Commands:",
    "  init      Create a new immutable V9 pilot from a binding record",
    "  collect   Verify and append one signed complete UTC-day summary",
    "  status    Verify the journal, fresh anchors, and all referenced evidence",
    "  evaluate  Freeze the 30-day evaluation for witness review",
    "  finalize  Verify an external witnessed approval and freeze the report",
    "  verify-final  Read-only verification; the only command that consumes a V9 pass",
    "",
    "Options:",
    "  --state-root PATH     Dedicated, non-existing pilot directory for init",
    "  --evidence-root PATH  Root containing immutable prerequisite/proof artifacts",
    "  --binding PATH        V9 binding JSON (init)",
    "  --pins PATH           Independently issued out-of-band pin record (init)",
    "  --pins-sha256 HASH    Independent pin-record SHA-256 (init/status/evaluate/finalize/verify-final)",
    "  --binding-sha256 HASH Independent binding SHA-256 (init/status/evaluate/finalize/verify-final)",
    "  --approval-witness-spki-sha256 HASH",
    "                       Independent approval-witness SPKI SHA-256 (all trust-verifying commands)",
    "  --prerequisite-witness-spki-sha256 HASH",
    "                       Independent prerequisite-witness SPKI SHA-256 (all trust-verifying commands)",
    "  --summary PATH        Signed daily summary JSON (collect)",
    "  --approval PATH       Signed external approval JSON (finalize)",
    "",
    "V9 uses real UTC and monotonic time. It cannot accelerate, backfill unsigned",
    "days, merge changed candidates/epochs, or issue its own witness approval.",
  ].join("\n");
}

function parseOptions(args: string[]): { command: string; options: Map<string, string> } {
  const command = args[0];
  if (!command || !["init", "collect", "status", "evaluate", "finalize", "verify-final"].includes(command)) throw new Error("A V9 command is required");
  const rest = args.slice(1);
  if (rest.length % 2) throw new Error(`Unexpected V9 argument: ${rest.at(-1)}`);
  const allowed = new Set([
    "--state-root",
    "--evidence-root",
    "--binding",
    "--pins",
    "--pins-sha256",
    "--binding-sha256",
    "--approval-witness-spki-sha256",
    "--prerequisite-witness-spki-sha256",
    "--summary",
    "--approval",
  ]);
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(`Invalid or duplicate V9 option: ${key}`);
    options.set(key, value);
  }
  return { command, options };
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function requiredValue(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJson<T>(filePath: string, label: string): Promise<T> {
  if (await realpath(filePath) !== path.resolve(filePath)) throw new Error(`${label} path contains a symbolic link`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds its file bound`);
    const bytes = Buffer.allocUnsafe(details.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) throw new Error(`${label} changed while it was read`);
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  } finally {
    await handle.close();
  }
}

function trustAnchors(options: Map<string, string>): V9TrustAnchors {
  return {
    expectedPinsSha256: requiredValue(options, "--pins-sha256"),
    expectedBindingSha256: requiredValue(options, "--binding-sha256"),
    expectedApprovalWitnessSpkiSha256: requiredValue(options, "--approval-witness-spki-sha256"),
    expectedPrerequisiteWitnessSpkiSha256: requiredValue(options, "--prerequisite-witness-spki-sha256"),
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (process.execPath !== "/usr/bin/node") throw new Error(`V9 qualification requires /usr/bin/node; current executable is ${process.execPath}`);
  const { command, options } = parseOptions(process.argv.slice(2));
  const stateRoot = requiredOption(options, "--state-root");
  const permittedByCommand: Record<string, Set<string>> = {
    init: new Set([
      "--state-root",
      "--evidence-root",
      "--binding",
      "--pins",
      "--pins-sha256",
      "--binding-sha256",
      "--approval-witness-spki-sha256",
      "--prerequisite-witness-spki-sha256",
    ]),
    collect: new Set(["--state-root", "--evidence-root", "--summary"]),
    status: new Set(["--state-root", "--evidence-root", "--pins-sha256", "--binding-sha256", "--approval-witness-spki-sha256", "--prerequisite-witness-spki-sha256"]),
    evaluate: new Set(["--state-root", "--evidence-root", "--pins-sha256", "--binding-sha256", "--approval-witness-spki-sha256", "--prerequisite-witness-spki-sha256"]),
    finalize: new Set(["--state-root", "--evidence-root", "--approval", "--pins-sha256", "--binding-sha256", "--approval-witness-spki-sha256", "--prerequisite-witness-spki-sha256"]),
    "verify-final": new Set(["--state-root", "--evidence-root", "--pins-sha256", "--binding-sha256", "--approval-witness-spki-sha256", "--prerequisite-witness-spki-sha256"]),
  };
  for (const name of options.keys()) if (!permittedByCommand[command].has(name)) throw new Error(`${name} is not valid for V9 ${command}`);
  if (command === "init") {
    const evidenceRoot = requiredOption(options, "--evidence-root");
    const binding = await readJson<V9PilotBinding>(requiredOption(options, "--binding"), "V9 binding");
    const pins = await readJson<V9OutOfBandPins>(requiredOption(options, "--pins"), "V9 out-of-band pins");
    const authority: V9InitializationPins = { pins, ...trustAnchors(options) };
    const snapshot = await initializeV9Pilot(stateRoot, evidenceRoot, binding, authority);
    process.stdout.write(`V9 pilot initialized: ${snapshot.manifest.pilotId}\n`);
    process.stdout.write(`Manifest SHA-256: ${snapshot.manifestSha256}\n`);
    process.stdout.write("V9 result: NOT RUN (30 real days and external approval remain)\n");
    return;
  }
  if (command === "collect") {
    const evidenceRoot = requiredOption(options, "--evidence-root");
    const summary = await readJson<V9DailySummary>(requiredOption(options, "--summary"), "V9 daily summary");
    const snapshot = await appendV9DailySummary(stateRoot, evidenceRoot, summary);
    process.stdout.write(`V9 daily summaries: ${snapshot.entries.length}/30\n`);
    process.stdout.write(`Journal head: ${snapshot.journalHeadSha256}\n`);
    process.stdout.write(`Retained atomic tails: ${snapshot.recoveredAtomicTailCount}\n`);
    process.stdout.write("V9 result: NOT RUN\n");
    if (snapshot.recoveredAtomicTailCount) process.exitCode = 1;
    return;
  }
  if (command === "status") {
    const snapshot = await verifyV9PilotEvidenceStatus(stateRoot, requiredOption(options, "--evidence-root"), trustAnchors(options));
    process.stdout.write(`V9 pilot: ${snapshot.manifest.pilotId}\n`);
    process.stdout.write(`Verified daily summaries: ${snapshot.entries.length}/30\n`);
    process.stdout.write(`Journal head: ${snapshot.journalHeadSha256 ?? "none"}\n`);
    process.stdout.write(`Retained atomic tails: ${snapshot.recoveredAtomicTailCount}\n`);
    process.stdout.write("V9 result: NOT RUN (journal and referenced evidence verified; use verify-final to consume a pass)\n");
    if (snapshot.recoveredAtomicTailCount) process.exitCode = 1;
    return;
  }
  const evidenceRoot = requiredOption(options, "--evidence-root");
  if (command === "evaluate") {
    const evaluation = await evaluateV9Pilot(stateRoot, evidenceRoot, trustAnchors(options));
    process.stdout.write(`V9 evaluation: ${evaluation.decision}\n`);
    process.stdout.write(`Evaluation SHA-256: ${hashV9Record(evaluation)}\n`);
    process.stdout.write(`Blockers: ${evaluation.blockers.length ? evaluation.blockers.join(", ") : "none"}\n`);
    process.stdout.write("Production ready: NO (external witnessed approval remains)\n");
    if (evaluation.decision !== "eligible-for-witness-review") process.exitCode = 1;
    return;
  }
  if (command === "verify-final") {
    const verified = await verifyV9FinalBundle(stateRoot, evidenceRoot, trustAnchors(options));
    process.stdout.write("V9 decision: VERIFIED PASSED\n");
    process.stdout.write(`Final commit SHA-256: ${verified.commitSha256}\n`);
    process.stdout.write(`Verified files: ${verified.verifiedFileCount}\n`);
    process.stdout.write("Production ready: NO (a separate site qualification approval must still be installed)\n");
    return;
  }
  const approval = await readJson<V9Approval>(requiredOption(options, "--approval"), "V9 approval");
  const report = await finalizeV9Pilot(stateRoot, evidenceRoot, trustAnchors(options), approval);
  process.stdout.write("V9 final bundle created; run verify-final before consuming the result\n");
  process.stdout.write(`Final report SHA-256: ${hashV9Record(report)}\n`);
  process.stdout.write("Production ready: NO (a separate site qualification approval must still be installed)\n");
}

await main().catch((error: unknown) => {
  process.stderr.write(`V9 NOT RUN: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
