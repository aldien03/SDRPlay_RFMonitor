import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupStatus,
  createBackup,
  restoreBackup,
  verifyBackup,
  type BackupCreateOptions,
} from "../src/server/evidenceBackup";
import { ensureDomainRoot } from "../src/server/dataDomains";
import { EvidenceStore } from "../src/server/evidenceStore";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `rf-monitor-backup-${label}-`));
  roots.push(root);
  return root;
}

async function writeLegacySession(root: string, complete = true): Promise<void> {
  await mkdir(root, { recursive: true });
  const payload = Buffer.from("legacy-v1-evidence\n");
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  await writeFile(path.join(root, "payload.bin"), payload);
  const manifest = JSON.stringify({
    schemaVersion: 1,
    sessionId: `session-${path.basename(root).replace(/^session-/, "")}`,
    generatedAt: "2026-08-23T00:00:00.000Z",
    hashAlgorithm: "SHA-256",
    files: [{ path: "payload.bin", bytes: payload.byteLength, sha256: payloadSha256 }],
    complete,
    evidenceGap: !complete,
  }, null, 2);
  await writeFile(path.join(root, "manifest.json"), manifest);
  await writeFile(
    path.join(root, "SHA256SUMS.txt"),
    `${payloadSha256}  payload.bin\n${createHash("sha256").update(manifest).digest("hex")}  manifest.json\n`,
  );
}

interface Fixture {
  root: string;
  dataRoot: string;
  configRoot: string;
  destinationRoot: string;
  restoreParent: string;
  v1Path: string;
  v2Path: string;
}

async function fixture(label: string, v1Complete = true): Promise<Fixture> {
  const root = await temporaryRoot(label);
  const dataRoot = path.join(root, "source-data");
  const configRoot = path.join(root, "source-config");
  const destinationRoot = path.join(root, "off-host-media");
  const restoreParent = path.join(root, "restore-staging");
  await Promise.all([mkdir(configRoot), mkdir(destinationRoot), mkdir(restoreParent)]);
  await ensureDomainRoot(path.join(dataRoot, "field"), "field");
  await ensureDomainRoot(path.join(dataRoot, "test"), "test");
  const v1Path = path.join(dataRoot, "field", "evidence", "session-legacy-v1");
  await writeLegacySession(v1Path, v1Complete);
  const v2Store = new EvidenceStore(path.join(dataRoot, "test", "evidence"), { dataDomain: "test" });
  const v2 = await v2Store.initialize({ config: { fixture: "v2" }, sdrconnect: { sampleRate: 10_000_000 } });
  await v2Store.closeActive();
  await Promise.all([
    writeFile(path.join(configRoot, "operational.json"), "{\"revision\":9}\n"),
    writeFile(path.join(configRoot, "config-audit.jsonl"), "{\"action\":\"fixture\"}\n"),
    writeFile(path.join(configRoot, "admin.json"), "{\"credential\":\"must-not-copy\"}\n"),
    writeFile(path.join(configRoot, ".env"), "PRIVATE_VALUE=must-not-copy\n"),
    writeFile(path.join(configRoot, "notes.txt"), "not part of the configuration allowlist\n"),
  ]);
  return { root, dataRoot, configRoot, destinationRoot, restoreParent, v1Path, v2Path: v2.path };
}

function createOptions(input: Fixture, backupId = "fixture-001"): BackupCreateOptions {
  return {
    dataRoot: input.dataRoot,
    configRoots: [{ label: "site", path: input.configRoot }],
    destinationRoot: input.destinationRoot,
    backupId,
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  };
}

async function digest(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("verified evidence backup and restore", { timeout: 60_000 }, () => {
  it("publishes a verified v1/v2 backup without mutating source data or copying secrets", async () => {
    const input = await fixture("pass");
    const before = await Promise.all([
      digest(path.join(input.v1Path, "payload.bin")),
      digest(path.join(input.v2Path, "manifest.json")),
      digest(path.join(input.configRoot, "operational.json")),
    ]);

    const created = await createBackup(createOptions(input));

    expect(created).toMatchObject({
      operation: "create",
      state: "complete",
      outcome: "PASS",
      evidencePackages: 2,
      incompleteEvidence: 0,
      excludedSecrets: 2,
      excludedConfigFiles: 1,
      auditDurable: true,
      reasons: [],
    });
    expect(await verifyBackup(path.join(input.destinationRoot, "fixture-001"))).toMatchObject({
      state: "complete",
      outcome: "PASS",
      evidencePackages: 2,
    });
    expect(await Promise.all([
      digest(path.join(input.v1Path, "payload.bin")),
      digest(path.join(input.v2Path, "manifest.json")),
      digest(path.join(input.configRoot, "operational.json")),
    ])).toEqual(before);
    await expect(stat(path.join(input.destinationRoot, "fixture-001", "payload", "config", "site", "admin.json"))).rejects.toThrow();
    await expect(stat(path.join(input.destinationRoot, "fixture-001", "payload", "config", "site", ".env"))).rejects.toThrow();
    expect(await readFile(path.join(input.destinationRoot, "rf-monitor-backup-audit.jsonl"), "utf8")).toContain('"state":"complete"');
  });

  it("publishes incomplete legacy evidence only with an explicit INCOMPLETE result", async () => {
    const input = await fixture("incomplete", false);
    const created = await createBackup(createOptions(input));
    expect(created).toMatchObject({ state: "incomplete", outcome: "INCOMPLETE", incompleteEvidence: 1 });
    expect(created.reasons).toContain("source-evidence-incomplete");
    expect(await verifyBackup(path.join(input.destinationRoot, "fixture-001"))).toMatchObject({
      state: "incomplete",
      outcome: "INCOMPLETE",
      incompleteEvidence: 1,
    });
  });

  it("refuses corrupt evidence and never publishes the backup ID", async () => {
    const input = await fixture("corrupt");
    await writeFile(path.join(input.v1Path, "payload.bin"), "corrupted\n");
    const created = await createBackup(createOptions(input));
    expect(created).toMatchObject({ state: "refused", outcome: "FAIL", auditDurable: true });
    expect(created.reasons[0]).toContain("source-evidence-failed");
    await expect(stat(path.join(input.destinationRoot, "fixture-001"))).rejects.toThrow();
  });

  it("retains a torn partial until explicit recovery and then completes", async () => {
    const input = await fixture("torn");
    let injected = false;
    const torn = await createBackup({
      ...createOptions(input),
      faultInjector: (point) => {
        if (!injected && point === "after-copy") {
          injected = true;
          throw new Error("power-loss-after-copy");
        }
      },
    });
    expect(torn).toMatchObject({ state: "recovery-required", outcome: "FAIL" });
    expect((await backupStatus(input.destinationRoot, "fixture-001"))).toMatchObject({
      state: "recovery-required",
      pendingPartials: 1,
      recoveredPartials: 0,
    });
    expect(await createBackup({ ...createOptions(input), recover: true, dryRun: true })).toMatchObject({
      state: "planned",
      pendingPartials: 1,
      recoveredPartials: 0,
    });
    expect((await backupStatus(input.destinationRoot, "fixture-001"))).toMatchObject({ pendingPartials: 1 });
    expect(await createBackup({ ...createOptions(input), recover: true })).toMatchObject({
      state: "complete",
      outcome: "PASS",
      recoveredPartials: 1,
    });
  });

  it("refuses symlinked and non-absolute source paths and nested restore paths", async () => {
    const input = await fixture("paths");
    const linkedData = path.join(input.root, "linked-data");
    await symlink(input.dataRoot, linkedData, "dir");
    expect(await createBackup({ ...createOptions(input), dataRoot: linkedData })).toMatchObject({
      state: "refused",
      reasons: [expect.stringContaining("symlink-path-refused")],
    });
    expect(await createBackup({ ...createOptions(input), dataRoot: "relative/data" })).toMatchObject({
      state: "refused",
      reasons: ["path-must-be-absolute:relative/data"],
    });
    await expect(createBackup({ ...createOptions(input), destinationRoot: path.parse(input.root).root })).rejects.toThrow("destination-filesystem-root-refused");
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS" });
    expect(await restoreBackup({
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: path.join(input.destinationRoot, "fixture-001", "escape"),
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ state: "refused", reasons: ["backup-restore-paths-must-be-separate"] });
    const manifestPath = path.join(input.destinationRoot, "fixture-001", "backup-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].path = "payload/../escaped";
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect(await verifyBackup(path.join(input.destinationRoot, "fixture-001"))).toMatchObject({
      state: "refused",
      outcome: "FAIL",
      reasons: [expect.stringMatching(/backup-path-(?:invalid|escape)/)],
    });
  });

  it("checks destination and restore capacity before writing", async () => {
    const input = await fixture("capacity");
    expect(await createBackup({ ...createOptions(input), availableBytes: async () => 0, dryRun: true })).toMatchObject({
      state: "refused",
      reasons: [expect.stringContaining("insufficient-destination-capacity")],
    });
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS" });
    const restorePath = path.join(input.restoreParent, "rebuilt");
    expect(await restoreBackup({
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: restorePath,
      availableBytes: async () => 0,
      dryRun: true,
    })).toMatchObject({ state: "refused", reasons: [expect.stringContaining("insufficient-restore-capacity")] });
    await expect(stat(restorePath)).rejects.toThrow();
  });

  it("is idempotent for the same immutable backup and restored bare root", async () => {
    const input = await fixture("idempotent");
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS", idempotent: false });
    await writeFile(path.join(input.destinationRoot, "rf-monitor-backup-audit.jsonl"), `${"x".repeat(2 * 1024 * 1024)}\n`);
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS", idempotent: true, auditDurable: true });
    expect((await stat(path.join(input.destinationRoot, "rf-monitor-backup-audit.jsonl"))).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    const restorePath = path.join(input.restoreParent, "bare-root");
    const restoreOptions = {
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: restorePath,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      now: () => new Date("2026-08-23T13:00:00.000Z"),
    };
    expect(await restoreBackup(restoreOptions)).toMatchObject({ state: "complete", outcome: "PASS", idempotent: false, auditDurable: true });
    expect(await restoreBackup(restoreOptions)).toMatchObject({ state: "complete", outcome: "PASS", idempotent: true, auditDurable: true });
    expect(JSON.parse(await readFile(path.join(restorePath, ".rf-monitor-restore.json"), "utf8"))).toMatchObject({
      backupId: "fixture-001",
      evidenceOutcome: "PASS",
      files: expect.any(Number),
      bytes: expect.any(Number),
      result: { operation: "restore", state: "complete", outcome: "PASS", auditDurable: true },
    });
    expect(JSON.parse(await readFile(path.join(restorePath, "data", "field", ".rf-monitor-data-domain.json"), "utf8"))).toMatchObject({ dataDomain: "field" });
    expect(JSON.parse(await readFile(path.join(restorePath, "data", "test", ".rf-monitor-data-domain.json"), "utf8"))).toMatchObject({ dataDomain: "test" });
    expect(await readFile(path.join(restorePath, "config", "site", "operational.json"), "utf8")).toContain("revision");
    await expect(stat(path.join(restorePath, "config", "site", "admin.json"))).rejects.toThrow();
  });

  it("serializes concurrent audit rotation without losing either result", async () => {
    const input = await fixture("concurrent-audit");
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS", auditDurable: true });
    const auditPath = path.join(input.destinationRoot, "rf-monitor-backup-audit.jsonl");
    await writeFile(auditPath, `${"x".repeat(2 * 1024 * 1024)}\n`);
    const [first, second] = await Promise.all([
      createBackup({ ...createOptions(input), now: () => new Date("2026-08-23T12:01:00.000Z") }),
      createBackup({ ...createOptions(input), now: () => new Date("2026-08-23T12:02:00.000Z") }),
    ]);
    expect(first).toMatchObject({ outcome: "PASS", idempotent: true, auditDurable: true });
    expect(second).toMatchObject({ outcome: "PASS", idempotent: true, auditDurable: true });
    const records = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.timestamp)).toEqual(expect.arrayContaining([
      "2026-08-23T12:01:00.000Z",
      "2026-08-23T12:02:00.000Z",
    ]));
    await expect(stat(path.join(input.destinationRoot, "rf-monitor-backup-audit.lock"))).rejects.toThrow();
  });

  it("recovers an owned stale audit lock but never leaves the recovery marker behind", async () => {
    const input = await fixture("stale-audit-lock");
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS", auditDurable: true });
    const lockPath = path.join(input.destinationRoot, "rf-monitor-backup-audit.lock");
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      type: "rf-monitor-backup-audit-lock",
      pid: 2_147_483_647,
      nonce: "00000000-0000-4000-8000-000000000000",
      createdAt: "2020-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    await utimes(lockPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    expect(await createBackup({ ...createOptions(input), now: () => new Date("2026-08-23T12:03:00.000Z") }))
      .toMatchObject({ outcome: "PASS", idempotent: true, auditDurable: true });
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("recovers a torn restore only when requested and refuses an existing unowned target", async () => {
    const input = await fixture("restore-recovery");
    expect(await createBackup(createOptions(input))).toMatchObject({ outcome: "PASS" });
    const restorePath = path.join(input.restoreParent, "rebuild");
    let injected = false;
    const torn = await restoreBackup({
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: restorePath,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      faultInjector: (point) => {
        if (!injected && point === "restore-after-copy") {
          injected = true;
          throw new Error("power-loss-restore-after-copy");
        }
      },
    });
    expect(torn).toMatchObject({ state: "recovery-required" });
    expect(await restoreBackup({
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: restorePath,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ state: "refused", reasons: ["interrupted-partial-present-use-recover"] });
    expect(await restoreBackup({
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: restorePath,
      recover: true,
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ state: "complete", recoveredPartials: 1 });

    const existing = path.join(input.restoreParent, "existing");
    await mkdir(existing);
    expect(await restoreBackup({
      backupPath: path.join(input.destinationRoot, "fixture-001"),
      destinationPath: existing,
    })).toMatchObject({ state: "refused", reasons: ["restore-destination-not-empty-or-owned"] });
  });

  it("supports read-only dry-run/status and refuses a leased live data domain", async () => {
    const input = await fixture("dry-run");
    expect(await createBackup({ ...createOptions(input), dryRun: true })).toMatchObject({
      state: "planned",
      outcome: "PASS",
      auditDurable: false,
    });
    expect(await backupStatus(input.destinationRoot, "fixture-001")).toMatchObject({ state: "refused", reasons: ["backup-not-found"] });
    const unownedPartial = path.join(input.destinationRoot, ".fixture-001.partial-unowned");
    await mkdir(unownedPartial);
    await writeFile(path.join(unownedPartial, "keep.txt"), "not created by the backup tool\n");
    expect(await createBackup({ ...createOptions(input), recover: true })).toMatchObject({
      state: "refused",
      reasons: ["unowned-partial-refused:.fixture-001.partial-unowned"],
    });
    expect(await readFile(path.join(unownedPartial, "keep.txt"), "utf8")).toContain("not created");
    await rm(unownedPartial, { recursive: true });
    await writeFile(path.join(input.dataRoot, "field", ".rf-monitor-active.json"), "{}\n");
    expect(await createBackup(createOptions(input))).toMatchObject({ state: "refused", reasons: ["active-domain-refused:field"] });
    expect((await readdir(input.destinationRoot)).sort()).toEqual(["rf-monitor-backup-audit.jsonl"]);
  });
});
