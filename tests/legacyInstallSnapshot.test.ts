import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureLegacyInstallSnapshot,
  collectLegacyTree,
  verifyCurrentLegacyInstall,
  verifyLegacyRestorePreflight,
  verifyLegacyInstallSnapshot,
} from "../deploy/legacy-install-snapshot.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPORARY_ROOTS: string[] = [];

async function thaw(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const details = await lstat(current).catch(() => undefined);
    if (!details) continue;
    if (details.isDirectory() && !details.isSymbolicLink()) {
      await chmod(current, 0o755).catch(() => undefined);
      for (const child of await readdir(current).catch(() => [])) pending.push(path.join(current, child));
    } else if (!details.isSymbolicLink()) await chmod(current, 0o644).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const root of TEMPORARY_ROOTS.splice(0)) {
    await thaw(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; source: string; unit: string; config: string; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-legacy-snapshot-"));
  TEMPORARY_ROOTS.push(root);
  const source = path.join(root, "legacy");
  const unit = path.join(root, "rf-monitor.service");
  const config = path.join(root, "rf-monitor.env");
  const output = path.join(root, "snapshot");
  await mkdir(path.join(source, "dist/server-node"), { recursive: true });
  await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
  await Promise.all([
    writeFile(path.join(source, "package.json"), "{\"name\":\"rf-monitor\",\"version\":\"legacy\"}\n"),
    writeFile(path.join(source, "dist/server-node/index.js"), "console.log('legacy');\n", { mode: 0o755 }),
    writeFile(path.join(source, "worker.js"), "export {};\n"),
    writeFile(unit, "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/dist/server-node/index.js\n"),
    writeFile(config, "RFMON_PRIVATE_VALUE=must-never-be-copied\n", { mode: 0o600 }),
  ]);
  await symlink("../../dist/server-node/index.js", path.join(source, "node_modules/.bin/rf-monitor"));
  return { root, source, unit, config, output };
}

function liveObservation() {
  return {
    healthUrl: "http://127.0.0.1:8080/api/health",
    capturedAt: "2026-08-23T18:00:00.000Z",
    serviceState: "normal",
    receiverModel: "RSPdx",
    receiverIdentitySha256: "a".repeat(64),
    usb: "present",
    transport: "connected",
    frames: "live",
    confirmedSampleRateHz: 10_000_000,
    sampleRateMatches: true,
    simulation: false,
    dataDomain: "field",
    qualificationUse: "legacy-unbound-not-eligible",
  };
}

describe("legacy installation snapshot", () => {
  it("captures and verifies an immutable package/unit rollback bundle without copying protected configuration", async () => {
    const prepared = await fixture();
    const source = await collectLegacyTree(prepared.source);
    const result = await captureLegacyInstallSnapshot({
      source: prepared.source,
      unit: prepared.unit,
      output: prepared.output,
      candidateRoot: REPOSITORY_ROOT,
      config: prepared.config,
      liveObservation: liveObservation(),
    });
    expect(result).toMatchObject({
      valid: true,
      treeSha256: source.treeSha256,
      migrationCutoverReady: true,
      liveReceiver: "RSPdx",
    });
    expect(await verifyLegacyInstallSnapshot(prepared.output)).toEqual(result);
    const manifest = JSON.parse(await readFile(path.join(prepared.output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      protectedConfiguration: { availability: "available", migrationCutoverReady: true },
      rollbackScope: { protectedConfigurationCopied: false, fieldEvidenceCopied: false, fieldEvidenceMustRemainInPlace: true },
      liveObservation: { simulation: false, dataDomain: "field", qualificationUse: "legacy-unbound-not-eligible" },
    });
    expect(JSON.stringify(manifest)).not.toContain("must-never-be-copied");
    expect(await readFile(path.join(prepared.output, "package/dist/server-node/index.js"), "utf8")).toContain("legacy");
    expect(await readFile(path.join(prepared.output, "unit/rf-monitor.service"), "utf8")).toContain("/opt/rf-monitor");
    expect((await lstat(path.join(prepared.output, "package/dist/server-node/index.js"))).mode & 0o222).toBe(0);
  });

  it("detects tampering and refuses to overwrite an existing snapshot", async () => {
    const prepared = await fixture();
    await captureLegacyInstallSnapshot({
      source: prepared.source,
      unit: prepared.unit,
      output: prepared.output,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: liveObservation(),
    });
    await expect(captureLegacyInstallSnapshot({
      source: prepared.source,
      unit: prepared.unit,
      output: prepared.output,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: liveObservation(),
    })).rejects.toThrow(/already exists/i);
    const stored = path.join(prepared.output, "package/worker.js");
    await chmod(stored, 0o644);
    await writeFile(stored, "tampered\n");
    await expect(verifyLegacyInstallSnapshot(prepared.output)).rejects.toThrow(/does not match/i);
  });

  it("rechecks the exact package, unit, protected config, candidate, and live receiver before cutover", async () => {
    const prepared = await fixture();
    await captureLegacyInstallSnapshot({
      source: prepared.source,
      unit: prepared.unit,
      output: prepared.output,
      candidateRoot: REPOSITORY_ROOT,
      config: prepared.config,
      liveObservation: liveObservation(),
    });
    const input = {
      bundle: prepared.output,
      source: prepared.source,
      unit: prepared.unit,
      config: prepared.config,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: liveObservation(),
    };
    await expect(verifyCurrentLegacyInstall(input)).resolves.toMatchObject({
      valid: true,
      currentMatchesSnapshot: true,
      liveReceiver: "RSPdx",
      qualificationUse: "migration-cutover-preflight-only",
    });

    await writeFile(prepared.config, "RFMON_PRIVATE_VALUE=changed\n", { mode: 0o600 });
    await expect(verifyCurrentLegacyInstall(input)).rejects.toThrow(/protected configuration does not match/i);
    await writeFile(prepared.config, "RFMON_PRIVATE_VALUE=must-never-be-copied\n", { mode: 0o600 });

    await writeFile(path.join(prepared.source, "worker.js"), "changed\n");
    await expect(verifyCurrentLegacyInstall(input)).rejects.toThrow(/legacy package does not match/i);
    await writeFile(path.join(prepared.source, "worker.js"), "export {};\n");

    await writeFile(prepared.unit, "[Service]\nExecStart=/usr/bin/node /tmp/wrong.js\n");
    await expect(verifyCurrentLegacyInstall(input)).rejects.toThrow(/service unit does not match/i);
    await writeFile(prepared.unit, "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/dist/server-node/index.js\n");

    await expect(verifyCurrentLegacyInstall({
      ...input,
      liveObservation: { ...liveObservation(), receiverIdentitySha256: "b".repeat(64) },
    })).rejects.toThrow(/receiver identity does not match/i);
  });

  it("permits only named immutable deployment-control paths after sealed preflight", async () => {
    const prepared = await fixture();
    await captureLegacyInstallSnapshot({
      source: prepared.source,
      unit: prepared.unit,
      output: prepared.output,
      candidateRoot: REPOSITORY_ROOT,
      config: prepared.config,
      liveObservation: liveObservation(),
    });
    await mkdir(path.join(prepared.source, "releases/candidate"), { recursive: true });
    await writeFile(path.join(prepared.source, "releases/candidate/manifest.json"), "{}\n");
    await mkdir(path.join(prepared.source, "deployment-records"));
    await symlink("releases/candidate", path.join(prepared.source, "active"));
    const input = {
      bundle: prepared.output,
      source: prepared.source,
      unit: prepared.unit,
      config: prepared.config,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: liveObservation(),
    };
    await expect(verifyCurrentLegacyInstall(input)).rejects.toThrow(/legacy package does not match/i);
    await expect(verifyCurrentLegacyInstall({ ...input, allowMigrationLayout: true })).resolves.toMatchObject({
      currentMatchesSnapshot: true,
      migrationLayoutExcluded: true,
    });
    await writeFile(prepared.unit, "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/active/dist/server-node/index.js\n");
    await expect(verifyLegacyRestorePreflight({
      bundle: prepared.output,
      source: prepared.source,
      config: prepared.config,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: liveObservation(),
    })).resolves.toMatchObject({
      valid: true,
      candidateBuildId: expect.any(String),
      qualificationUse: "manual-legacy-restore-preflight-only",
      currentReceiverVerified: true,
    });
    await expect(verifyLegacyRestorePreflight({
      bundle: prepared.output,
      source: prepared.source,
      config: prepared.config,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: { ...liveObservation(), frames: "stalled" },
      allowUnavailableCurrentReceiver: true,
    })).resolves.toMatchObject({ valid: true, currentReceiverVerified: false });
    await writeFile(path.join(prepared.source, "unexpected.txt"), "not an approved deployment path\n");
    await expect(verifyCurrentLegacyInstall({ ...input, allowMigrationLayout: true })).rejects.toThrow(/legacy package does not match/i);
  });

  it("rejects escaping links and any non-live or simulated receiver observation", async () => {
    const prepared = await fixture();
    await symlink("/etc/passwd", path.join(prepared.source, "escape"));
    await expect(collectLegacyTree(prepared.source)).rejects.toThrow(/absolute symlink/i);
    await rm(path.join(prepared.source, "escape"));
    await expect(captureLegacyInstallSnapshot({
      source: prepared.source,
      unit: prepared.unit,
      output: prepared.output,
      candidateRoot: REPOSITORY_ROOT,
      liveObservation: { ...liveObservation(), simulation: true },
    })).rejects.toThrow(/field-domain/i);
    await expect(lstat(prepared.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes a bounded read-only CLI and keeps capture distinct from qualification", () => {
    const script = path.join(REPOSITORY_ROOT, "deploy/legacy-install-snapshot.mjs");
    const help = spawnSync("/usr/bin/node", [script, "--help"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toMatch(/never stops, starts,\s+restarts, tunes, or edits the receiver/u);
    expect(help.stdout).toContain("not ready for migration cutover");
    expect(help.stdout).toContain("verify-current");
    const invalid = spawnSync("/usr/bin/node", [script, "capture", "--source", "/tmp/only"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("capture requires --source, --unit, and --output");
  });
});
