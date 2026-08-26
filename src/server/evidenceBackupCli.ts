#!/usr/bin/env node
import {
  backupStatus,
  createBackup,
  restoreBackup,
  verifyBackup,
  type BackupConfigRoot,
  type BackupResult,
} from "./evidenceBackup";

const USAGE = `Usage:
  evidence-backup create --data-root ABS --config LABEL=ABS [--config LABEL=ABS ...] --destination ABS --backup-id ID [--minimum-free-bytes N] [--dry-run] [--recover] [--json]
  evidence-backup verify --backup ABS [--json]
  evidence-backup restore --backup ABS --destination ABS [--minimum-free-bytes N] [--dry-run] [--recover] [--json]
  evidence-backup status --destination ABS --backup-id ID [--json]

Paths must be absolute and must not contain symlinks. Create is an offline operation:
field and test data-domain leases must be absent. Restore never overwrites a target.`;

interface ParsedArguments {
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const booleanFlags = new Set(["dry-run", "recover", "json", "help"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    if (!token.startsWith("--")) throw new Error(`unexpected-argument:${token}`);
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      flags.add(name);
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`argument-value-required:${name}`);
    index += 1;
    const current = values.get(name) ?? [];
    current.push(value);
    values.set(name, current);
  }
  return { values, flags };
}

function one(parsed: ParsedArguments, name: string): string {
  const values = parsed.values.get(name) ?? [];
  if (values.length !== 1) throw new Error(values.length ? `argument-repeated:${name}` : `argument-required:${name}`);
  return values[0];
}

function optionalNumber(parsed: ParsedArguments, name: string): number | undefined {
  const values = parsed.values.get(name) ?? [];
  if (!values.length) return undefined;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0])) throw new Error(`argument-integer-invalid:${name}`);
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value)) throw new Error(`argument-integer-invalid:${name}`);
  return value;
}

function configs(parsed: ParsedArguments): BackupConfigRoot[] {
  return (parsed.values.get("config") ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new Error("config-format-invalid");
    return { label: value.slice(0, separator), path: value.slice(separator + 1) };
  });
}

function assertOnly(parsed: ParsedArguments, allowedValues: string[], allowedFlags: string[]): void {
  for (const key of parsed.values.keys()) if (!allowedValues.includes(key)) throw new Error(`argument-unknown:${key}`);
  for (const key of parsed.flags) if (!allowedFlags.includes(key)) throw new Error(`argument-unknown:${key}`);
}

function resultExitCode(result: BackupResult): number {
  if (result.state === "recovery-required") return 3;
  if (result.outcome === "FAIL" || result.state === "refused") return 1;
  if (result.outcome === "INCOMPLETE" || result.state === "incomplete") return 2;
  return 0;
}

function printResult(result: BackupResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const location = result.restorePath ?? result.backupPath ?? "-";
  process.stdout.write([
    `Operation: ${result.operation}`,
    `State: ${result.state}`,
    `Outcome: ${result.outcome}`,
    `Location: ${location}`,
    `Files: ${result.files}`,
    `Bytes: ${result.bytes}`,
    ...(result.availableBytes === undefined ? [] : [`Available bytes: ${result.availableBytes}`]),
    ...(result.requiredBytes === undefined ? [] : [`Required bytes: ${result.requiredBytes}`]),
    ...(result.minimumFreeBytes === undefined ? [] : [`Free-space reserve: ${result.minimumFreeBytes}`]),
    `Evidence packages: ${result.evidencePackages}`,
    `Incomplete evidence: ${result.incompleteEvidence}`,
    `Secrets excluded: ${result.excludedSecrets}`,
    `Other config files excluded: ${result.excludedConfigFiles}`,
    `Recovered partials: ${result.recoveredPartials}`,
    `Pending partials: ${result.pendingPartials}`,
    `Idempotent: ${result.idempotent ? "yes" : "no"}`,
    `Audit durable: ${result.auditDurable ? "yes" : "no"}`,
    ...(result.reasons.length ? [`Reasons: ${result.reasons.join(", ")}`] : []),
  ].join("\n") + "\n");
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const parsed = parseArguments(process.argv.slice(3));
  if (parsed.flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let result: BackupResult;
  if (command === "create") {
    assertOnly(parsed, ["data-root", "config", "destination", "backup-id", "minimum-free-bytes"], ["dry-run", "recover", "json"]);
    result = await createBackup({
      dataRoot: one(parsed, "data-root"),
      configRoots: configs(parsed),
      destinationRoot: one(parsed, "destination"),
      backupId: one(parsed, "backup-id"),
      minimumFreeBytes: optionalNumber(parsed, "minimum-free-bytes"),
      dryRun: parsed.flags.has("dry-run"),
      recover: parsed.flags.has("recover"),
    });
  } else if (command === "verify") {
    assertOnly(parsed, ["backup"], ["json"]);
    result = await verifyBackup(one(parsed, "backup"));
  } else if (command === "restore") {
    assertOnly(parsed, ["backup", "destination", "minimum-free-bytes"], ["dry-run", "recover", "json"]);
    result = await restoreBackup({
      backupPath: one(parsed, "backup"),
      destinationPath: one(parsed, "destination"),
      minimumFreeBytes: optionalNumber(parsed, "minimum-free-bytes"),
      dryRun: parsed.flags.has("dry-run"),
      recover: parsed.flags.has("recover"),
    });
  } else if (command === "status") {
    assertOnly(parsed, ["destination", "backup-id"], ["json"]);
    result = await backupStatus(one(parsed, "destination"), one(parsed, "backup-id"));
  } else {
    throw new Error(`command-unknown:${command}`);
  }
  printResult(result, parsed.flags.has("json"));
  return resultExitCode(result);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`RF Monitor backup refused: ${error instanceof Error ? error.message : "unexpected-error"}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
