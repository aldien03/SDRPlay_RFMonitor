import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
// Ubuntu 24.04 can block unprivileged user namespaces by policy
// (kernel.apparmor_restrict_unprivileged_userns=1). That is a host restriction,
// not a support-bundle fault, so the isolation test reports itself as skipped.
const userNamespacesAvailable = await execFile("/usr/bin/unshare", ["-Ur", "/bin/true"]).then(() => true, () => false);
const modulePath = path.join(repositoryRoot, "deploy/ops-supervisor.mjs");
const ops = await import(pathToFileURL(modulePath).href) as {
  MAX_RECORD_BYTES: number;
  archiveHashedRecord(input: { archiveDir: string; kind: "daily" | "weekly" | "monthly"; payload: Record<string, unknown>; generatedAt?: Date; retain?: number }): Promise<{ path: string; envelope: Record<string, unknown> }>;
  configFromEnvironment(environment?: NodeJS.ProcessEnv): Record<string, unknown>;
  createHashedEnvelope(kind: "daily" | "weekly" | "monthly", payload: Record<string, unknown>, generatedAt?: Date): Record<string, unknown>;
  evaluateReadiness(snapshot: Record<string, any>, options?: Record<string, number>): { state: string; issues: Array<{ code: string; severity: string }> };
  mergeIssueLedger(issues: Array<Record<string, unknown>>, previous?: Array<Record<string, unknown>>, now?: Date): Array<Record<string, unknown>>;
  runDaily(config: Record<string, any>, now?: Date): Promise<Record<string, any>>;
  runWeekly(config: Record<string, any>, now?: Date): Promise<Record<string, any>>;
  runMonthly(config: Record<string, any>, now?: Date): Promise<Record<string, any>>;
  runProbe(config: Record<string, any>, now?: Date): Promise<Record<string, any>>;
  verifyHashedEnvelope(value: unknown): boolean;
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `rf-monitor-ops-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function healthySnapshot(now = "2026-08-23T12:00:00.000Z") {
  return {
    uptime: { available: true, schemaValid: true, currentState: "normal", productionReady: true },
    clock: { available: true, synchronized: true },
    certificate: { required: true, available: true, expiresAt: "2027-08-23T12:00:00.000Z" },
    disk: { available: true, availableBytes: 100_000, reserveBytes: 10_000, healthy: true },
    service: { available: true, active: true, restarts: 0 },
    recovery: [
      { name: "receiver", available: true, state: "live", observedAt: now },
      { name: "application", available: true, state: "live", observedAt: now },
    ],
    backup: { available: true, completedAt: now, outcome: "PASS" },
    schedule: { installedAt: "2026-01-01T00:00:00.000Z", lastWeeklyAt: now, lastMonthlyAt: now },
    change: { changed: false },
  };
}

describe("external operations readiness model", () => {
  it("returns Normal only when every independent readiness fact is current", () => {
    expect(ops.evaluateReadiness(healthySnapshot(), { nowMs: Date.parse("2026-08-23T12:00:00.000Z") }))
      .toEqual({ state: "normal", evaluatedAt: "2026-08-23T12:00:00.000Z", issues: [] });
  });

  it("turns lockout, disk reserve, clock, certificate, restart, backup, and missed jobs into bounded actionable findings", () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const snapshot: any = healthySnapshot();
    snapshot.clock = { available: true, synchronized: false };
    snapshot.certificate = { required: true, available: true, expiresAt: "2026-08-24T12:00:00.000Z" };
    snapshot.disk = { available: true, availableBytes: 1_000, reserveBytes: 10_000, healthy: true };
    snapshot.service = { available: true, active: true, restarts: 4 };
    snapshot.recovery[0] = { name: "receiver", available: true, state: "lockout", observedAt: "2026-08-23T11:59:00.000Z" };
    snapshot.backup = { available: true, completedAt: "2026-08-20T00:00:00.000Z", outcome: "PASS", lastAttemptOutcome: "FAIL" };
    snapshot.schedule.lastWeeklyAt = "2026-08-01T00:00:00.000Z";
    snapshot.schedule.lastMonthlyAt = "2026-06-01T00:00:00.000Z";
    snapshot.schedule.weeklyState = "critical";
    snapshot.schedule.monthlyState = "attention";
    snapshot.change.changed = true;
    snapshot.uptime.productionReady = false;
    const result = ops.evaluateReadiness(snapshot, { nowMs: now });
    expect(result.state).toBe("critical");
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "clock-not-synchronized",
      "certificate-expiring",
      "disk-below-reserve",
      "restart-count-high",
      "receiver-recovery-lockout",
      "backup-attempt-failed",
      "backup-stale",
      "weekly-verification-failed",
      "monthly-drill-incomplete",
      "weekly-verification-overdue",
      "monthly-drill-overdue",
      "recommissioning-required-after-change",
    ]));
    expect(result.issues.length).toBeLessThanOrEqual(32);
    expect(new Set(result.issues.map((entry) => entry.code)).size).toBe(result.issues.length);
  });

  it("allows a new installation one full schedule window before reporting a missed task", () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const snapshot = healthySnapshot();
    snapshot.schedule = { installedAt: "2026-08-23T11:00:00.000Z" } as any;
    expect(ops.evaluateReadiness(snapshot, { nowMs: now }).issues.map((entry) => entry.code))
      .not.toEqual(expect.arrayContaining(["weekly-verification-overdue", "monthly-drill-overdue"]));
  });

  it("keeps a stable issue epoch until a clean evaluation clears it", () => {
    const first = ops.mergeIssueLedger([
      { code: "backup-stale", severity: "attention", area: "backup", value: "40 hours", limit: "36 hours", action: "Back up." },
    ], [], new Date("2026-08-23T12:00:00.000Z"));
    const second = ops.mergeIssueLedger(first, first, new Date("2026-08-24T12:00:00.000Z"));
    expect(second[0]).toMatchObject({
      firstSeenAt: "2026-08-23T12:00:00.000Z",
      lastSeenAt: "2026-08-24T12:00:00.000Z",
      occurrences: 2,
    });
    expect(ops.mergeIssueLedger([], second, new Date("2026-08-25T12:00:00.000Z"))).toEqual([]);
  });
});

describe("bounded tamper-evident operations archive", () => {
  it("hashes records, detects tampering, and prunes only its bounded record names", async () => {
    const root = await temporaryRoot("archive");
    const archiveDir = path.join(root, "archive");
    await mkdir(archiveDir);
    let latest: Record<string, unknown> | undefined;
    for (let day = 1; day <= 5; day += 1) {
      latest = (await ops.archiveHashedRecord({
        archiveDir,
        kind: "daily",
        payload: { summary: { state: "normal", day } },
        generatedAt: new Date(Date.UTC(2026, 7, day)),
        retain: 3,
      })).envelope;
    }
    expect((await readdir(path.join(archiveDir, "daily"))).filter((entry) => entry.endsWith(".json"))).toHaveLength(3);
    expect(ops.verifyHashedEnvelope(latest)).toBe(true);
    const tampered = structuredClone(latest!);
    (tampered.payload as any).summary.state = "normal-but-not-hashed";
    expect(ops.verifyHashedEnvelope(tampered)).toBe(false);
    const retimed = structuredClone(latest!);
    retimed.generatedAt = "2036-08-23T12:00:00.000Z";
    expect(ops.verifyHashedEnvelope(retimed)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(latest))).toBeLessThan(ops.MAX_RECORD_BYTES);
  });

  it("refuses a symlinked archive root", async () => {
    const root = await temporaryRoot("symlink");
    const real = path.join(root, "real");
    const linked = path.join(root, "linked");
    await mkdir(real);
    await symlink(real, linked, "dir");
    await expect(ops.archiveHashedRecord({ archiveDir: linked, kind: "daily", payload: { summary: { state: "normal" } } }))
      .rejects.toThrow("ops-directory-symlink-or-nondirectory");
  });

  it("refuses records larger than 64 KiB", () => {
    expect(() => ops.createHashedEnvelope("daily", { unbounded: "x".repeat(ops.MAX_RECORD_BYTES) }))
      .toThrow("ops-record-size-bound");
  });
});

async function executable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, body);
  await chmod(filePath, 0o755);
}

async function jobFixture(label: string) {
  const root = await temporaryRoot(label);
  const archiveDir = path.join(root, "archive");
  const storageDir = path.join(root, "storage");
  const evidenceRoot = path.join(storageDir, "field", "evidence");
  const evidenceSession = path.join(evidenceRoot, "session-fixture");
  const backupRoot = path.join(root, "backup");
  const backupPath = path.join(backupRoot, "backup-fixture");
  const restoreStagingRoot = path.join(root, "restore-staging");
  const bin = path.join(root, "bin");
  await Promise.all([
    mkdir(archiveDir),
    mkdir(evidenceSession, { recursive: true }),
    mkdir(backupPath, { recursive: true }),
    mkdir(restoreStagingRoot),
    mkdir(bin),
  ]);
  await writeFile(path.join(evidenceSession, "manifest.json"), "{}\n");
  await writeFile(path.join(backupRoot, "rf-monitor-backup-audit.jsonl"), `${JSON.stringify({
    timestamp: "2026-08-23T11:00:00.000Z",
    operation: "create",
    state: "complete",
    outcome: "PASS",
    backupId: "backup-fixture",
    backupPath,
    auditDurable: true,
  })}\n`);
  const recovery = JSON.stringify({ schemaVersion: 1, state: "live", reasonCode: "healthy", observedAt: "2026-08-23T12:00:00.000Z" });
  const receiverRecoveryStatus = path.join(root, "receiver-recovery.json");
  const applicationRecoveryStatus = path.join(root, "application-recovery.json");
  await Promise.all([writeFile(receiverRecoveryStatus, recovery), writeFile(applicationRecoveryStatus, recovery)]);
  const systemctl = path.join(bin, "systemctl");
  const timedatectl = path.join(bin, "timedatectl");
  const node = path.join(bin, "node");
  await executable(systemctl, `#!/usr/bin/env bash
if [[ "$*" == *".timer"* ]]; then
  printf 'ActiveState=active\\nNextElapseUSecRealtime=Sun 2026-08-30 01:20:00 UTC\\n'
else
  printf 'ActiveState=active\\nSubState=running\\nNRestarts=0\\n'
fi
`);
  await executable(timedatectl, "#!/usr/bin/env bash\nprintf 'yes\\n'\n");
  await executable(node, `#!/usr/bin/env bash
if [[ "$1" == *"evidence-verifier.js" ]]; then
  printf '{"schemaVersion":1,"results":[{"path":"%s","outcome":"PASS","reasons":[]}]}\\n' "$3"
elif [[ "$2" == "verify" ]]; then
  printf '{"schemaVersion":1,"operation":"verify","state":"complete","outcome":"PASS","backupId":"backup-fixture","backupPath":"%s","files":12,"bytes":4096,"idempotent":false,"reasons":[]}\\n' "$4"
elif [[ "$2" == "restore" ]]; then
  printf '{"schemaVersion":1,"operation":"restore","state":"planned","outcome":"PASS","backupId":"backup-fixture","backupPath":"%s","restorePath":"%s","files":12,"bytes":4096,"idempotent":false,"reasons":[]}\\n' "$4" "$6"
else
  exit 1
fi
`);
  const health = {
    schemaVersion: 2,
    summary: { state: "normal" },
    productionReady: true,
    identity: {
      serviceBootId: "boot-fixture",
      release: { buildId: "build-fixture" },
      configuration: { configurationHash: "a".repeat(64) },
    },
    productionQualification: { state: "qualified", blockers: [] },
    disk: { pressure: false },
    evidence: { healthy: true, diskPressure: false },
  };
  const fetchImplementation = async () => new Response(JSON.stringify(health), { status: 200, headers: { "content-type": "application/json" } });
  return {
    archiveDir,
    storageDir,
    evidenceRoots: [evidenceRoot],
    backupRoot,
    restoreStagingRoot,
    healthUrl: "http://127.0.0.1:8080/api/health",
    fetchImplementation,
    tlsCertificate: undefined,
    diskReserveBytes: 1,
    systemctl,
    timedatectl,
    node,
    evidenceVerifier: "/fixture/evidence-verifier.js",
    backupCli: "/fixture/evidence-backup.js",
    receiverRecoveryStatus,
    applicationRecoveryStatus,
    verificationTimeoutMs: 5_000,
    weeklyJobMaxMs: 30_000,
    monthlyJobMaxMs: 30_000,
    retention: { daily: 3, weekly: 3, monthly: 3 },
    thresholds: {},
    health,
  };
}

describe("isolated scheduled-job fixtures", () => {
  it("runs daily, weekly, and monthly checks without mutating evidence or backup content", async () => {
    const fixture = await jobFixture("jobs");
    const evidenceBefore = await readFile(path.join(fixture.evidenceRoots[0], "session-fixture", "manifest.json"), "utf8");
    const backupAuditBefore = await readFile(path.join(fixture.backupRoot, "rf-monitor-backup-audit.jsonl"), "utf8");
    const now = new Date("2026-08-23T12:00:00.000Z");

    const probe = await ops.runProbe(fixture, now);
    expect(probe).toMatchObject({ kind: "probe", payload: { summary: { state: "normal", issueCount: 0 } } });
    expect((await readdir(fixture.archiveDir)).filter((entry) => entry.startsWith("probe-") && entry.endsWith(".json"))).toEqual([]);
    const weekly = await ops.runWeekly(fixture, now);
    expect(weekly.payload.summary).toEqual({ state: "normal", evidenceOutcome: "PASS", backupOutcome: "PASS" });
    const monthly = await ops.runMonthly(fixture, now);
    expect(monthly.payload.summary).toEqual({ state: "normal", recoveryOutcome: "PASS", restoreOutcome: "PASS" });
    const daily = await ops.runDaily(fixture, now);
    expect(daily.payload.summary).toEqual({ state: "normal", issueCount: 0 });
    expect(await readFile(path.join(fixture.evidenceRoots[0], "session-fixture", "manifest.json"), "utf8")).toBe(evidenceBefore);
    expect(await readFile(path.join(fixture.backupRoot, "rf-monitor-backup-audit.jsonl"), "utf8")).toBe(backupAuditBefore);
    expect(ops.verifyHashedEnvelope(JSON.parse(await readFile(path.join(fixture.archiveDir, "status.json"), "utf8")))).toBe(true);
  });

  it("keeps change-triggered recommissioning visible until that fingerprint qualifies", async () => {
    const fixture = await jobFixture("recommissioning");
    await ops.runProbe(fixture, new Date("2026-08-23T12:00:00.000Z"));
    fixture.health.identity.release.buildId = "build-changed";
    fixture.health.productionReady = false;
    let result = await ops.runProbe(fixture, new Date("2026-08-23T12:01:00.000Z"));
    expect(result.payload.issues.map((entry: any) => entry.code)).toContain("recommissioning-required-after-change");
    result = await ops.runProbe(fixture, new Date("2026-08-23T12:02:00.000Z"));
    expect(result.payload.issues.map((entry: any) => entry.code)).toContain("recommissioning-required-after-change");
    fixture.health.productionReady = true;
    result = await ops.runProbe(fixture, new Date("2026-08-23T12:03:00.000Z"));
    expect(result.payload.issues.map((entry: any) => entry.code)).not.toContain("recommissioning-required-after-change");
  });

  it("fails closed without buffering an oversized health response", async () => {
    const fixture = await jobFixture("oversized-health");
    fixture.fetchImplementation = async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 });
    const result = await ops.runProbe(fixture, new Date("2026-08-23T12:00:00.000Z"));
    expect(result.payload.summary.state).toBe("critical");
    expect(result.payload.issues.map((entry: any) => entry.code)).toContain("uptime-probe-failed");
  });

  it("refuses a symlinked backup audit without reading its target", async () => {
    const fixture = await jobFixture("backup-audit-symlink");
    const auditPath = path.join(fixture.backupRoot, "rf-monitor-backup-audit.jsonl");
    const victimPath = path.join(path.dirname(fixture.backupRoot), "outside-audit.jsonl");
    const victim = `${JSON.stringify({
      timestamp: "2026-08-23T11:59:00.000Z",
      operation: "create",
      state: "complete",
      outcome: "PASS",
      backupId: "backup-fixture",
      backupPath: path.join(fixture.backupRoot, "backup-fixture"),
    })}\n`;
    await ops.runProbe(fixture, new Date("2026-08-23T12:00:00.000Z"));
    await writeFile(victimPath, victim);
    await unlink(auditPath);
    await symlink(victimPath, auditPath);

    const result = await ops.runProbe(fixture, new Date("2026-08-25T12:00:00.000Z"));
    expect(result.payload.summary.state).toBe("attention");
    expect(result.payload.issues.map((entry: any) => entry.code)).toContain("backup-missing");
    expect(await readFile(victimPath, "utf8")).toBe(victim);
  });

  it("reports a tampered scheduled record immediately instead of treating it as not yet due", async () => {
    const fixture = await jobFixture("tampered-schedule");
    await writeFile(path.join(fixture.archiveDir, "weekly-latest.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "weekly",
      generatedAt: "2026-08-23T11:00:00.000Z",
      hashAlgorithm: "SHA-256",
      payloadSha256: "0".repeat(64),
      recordSha256: "0".repeat(64),
      payload: { summary: { state: "normal" } },
    })}\n`);
    const result = await ops.runProbe(fixture, new Date("2026-08-23T12:00:00.000Z"));
    expect(result.payload.issues.map((entry: any) => entry.code)).toContain("weekly-verification-failed");
  });

  it("refuses false PASS output when verifier exit, operation, or state contracts disagree", async () => {
    const fixture = await jobFixture("false-pass");
    await executable(fixture.node, `#!/usr/bin/env bash
if [[ "$1" == *"evidence-verifier.js" ]]; then
  printf '{"schemaVersion":1,"results":[{"path":"%s","outcome":"PASS","reasons":[]}]}\\n' "$3"
  exit 1
elif [[ "$2" == "verify" ]]; then
  printf '{"schemaVersion":1,"operation":"restore","state":"complete","outcome":"PASS","backupId":"backup-fixture","backupPath":"%s","files":12,"bytes":4096,"idempotent":true,"reasons":[]}\\n' "$4"
elif [[ "$2" == "restore" ]]; then
  printf '{"schemaVersion":1,"operation":"restore","state":"complete","outcome":"PASS","backupId":"backup-fixture","backupPath":"%s","restorePath":"%s","files":12,"bytes":4096,"idempotent":false,"reasons":[]}\\n' "$4" "$6"
else
  exit 1
fi
`);
    const now = new Date("2026-08-23T12:00:00.000Z");
    const weekly = await ops.runWeekly(fixture, now);
    expect(weekly.payload.summary).toEqual({ state: "critical", evidenceOutcome: "FAIL", backupOutcome: "FAIL" });
    expect(weekly.payload.evidence.reasons).toContain("evidence-verifier-failed");
    expect(weekly.payload.backup.reasons).toContain("backup-verifier-output-invalid");
    const monthly = await ops.runMonthly(fixture, now);
    expect(monthly.payload.summary).toEqual({ state: "critical", recoveryOutcome: "PASS", restoreOutcome: "FAIL" });
    expect(monthly.payload.restore.reasons).toContain("restore-drill-output-invalid");
  });

  it("binds a PASS to the selected backup and planned restore destination", async () => {
    const fixture = await jobFixture("path-binding");
    await executable(fixture.node, `#!/usr/bin/env bash
if [[ "$1" == *"evidence-verifier.js" ]]; then
  printf '{"schemaVersion":1,"results":[{"path":"%s","outcome":"PASS","reasons":[]}]}\\n' "$3"
elif [[ "$2" == "verify" ]]; then
  printf '{"schemaVersion":1,"operation":"verify","state":"complete","outcome":"PASS","backupId":"backup-fixture","backupPath":"/different/backup-fixture","files":12,"bytes":4096,"idempotent":false,"reasons":[]}\\n'
elif [[ "$2" == "restore" ]]; then
  printf '{"schemaVersion":1,"operation":"restore","state":"planned","outcome":"PASS","backupId":"backup-fixture","backupPath":"%s","restorePath":"/different/restore-root","files":12,"bytes":4096,"idempotent":false,"reasons":[]}\\n' "$4"
else
  exit 1
fi
`);
    const now = new Date("2026-08-23T12:00:00.000Z");
    const weekly = await ops.runWeekly(fixture, now);
    expect(weekly.payload.summary).toEqual({ state: "critical", evidenceOutcome: "PASS", backupOutcome: "FAIL" });
    expect(weekly.payload.backup.reasons).toContain("backup-verifier-output-invalid");
    const monthly = await ops.runMonthly(fixture, now);
    expect(monthly.payload.summary).toEqual({ state: "critical", recoveryOutcome: "PASS", restoreOutcome: "FAIL" });
    expect(monthly.payload.restore.reasons).toContain("restore-drill-output-invalid");
  });

  it("preserves labelled INCOMPLETE results when each CLI exits with code 2", async () => {
    const fixture = await jobFixture("incomplete-contract");
    await executable(fixture.node, `#!/usr/bin/env bash
if [[ "$1" == *"evidence-verifier.js" ]]; then
  printf '{"schemaVersion":1,"results":[{"path":"%s","outcome":"INCOMPLETE","reasons":["known-gap"]}]}\\n' "$3"
  exit 2
elif [[ "$2" == "verify" ]]; then
  printf '{"schemaVersion":1,"operation":"verify","state":"incomplete","outcome":"INCOMPLETE","backupId":"backup-fixture","backupPath":"%s","files":12,"bytes":4096,"idempotent":false,"reasons":["source-evidence-incomplete"]}\\n' "$4"
  exit 2
elif [[ "$2" == "restore" ]]; then
  printf '{"schemaVersion":1,"operation":"restore","state":"incomplete","outcome":"INCOMPLETE","backupId":"backup-fixture","backupPath":"%s","restorePath":"%s","files":12,"bytes":4096,"idempotent":false,"reasons":["source-evidence-incomplete"]}\\n' "$4" "$6"
  exit 2
else
  exit 1
fi
`);
    const now = new Date("2026-08-23T12:00:00.000Z");
    const weekly = await ops.runWeekly(fixture, now);
    expect(weekly.payload.summary).toEqual({ state: "attention", evidenceOutcome: "INCOMPLETE", backupOutcome: "INCOMPLETE" });
    const monthly = await ops.runMonthly(fixture, now);
    expect(monthly.payload.summary).toEqual({ state: "attention", recoveryOutcome: "PASS", restoreOutcome: "INCOMPLETE" });
  });
});

describe("shipped supervision policy", () => {
  it("uses persistent bounded schedules and hardened unprivileged services", async () => {
    const schedules = [
      ["probe", "OnCalendar=*-*-* *:*:08"],
      ["daily", "OnCalendar=*-*-* 00:20:00"],
      ["weekly", "OnCalendar=Sun *-*-* 01:20:00"],
      ["monthly", "OnCalendar=*-*-01 02:20:00"],
    ] as const;
    for (const [name, calendar] of schedules) {
      const timer = await readFile(path.join(repositoryRoot, `deploy/rf-monitor-ops-${name}.timer`), "utf8");
      const service = await readFile(path.join(repositoryRoot, `deploy/rf-monitor-ops-${name}.service.template`), "utf8");
      expect(timer).toContain(calendar);
      expect(timer).toContain("Persistent=true");
      expect(timer).toContain("RandomizedDelaySec=");
      expect(service).toContain("User=@@SERVICE_USER@@");
      expect(service).toContain("ExecStart=/usr/bin/node @@INSTALL_DIR@@/deploy/ops-supervisor.mjs");
      expect(service).toContain("NoNewPrivileges=true");
      expect(service).toContain("ProtectSystem=strict");
      expect(service).toMatch(/MemoryMax=(?:128|256)M/);
      expect(service).not.toMatch(/sudo|runuser|systemctl (?:start|stop|restart)/);
    }
  });

  it("bounds and redacts the support bundle without copying evidence or command lines", async () => {
    const support = await readFile(path.join(repositoryRoot, "deploy/support-bundle.sh"), "utf8");
    expect(support).toContain("RFMON_SUPPORT_MAX_ENTRY_BYTES:-262144");
    expect(support).toContain("RFMON_SUPPORT_MAX_BUNDLE_BYTES:-8388608");
    expect(support).toContain("RFMON_SUPPORT_MAX_OUTPUT_BYTES:-12582912");
    expect(support).toContain("[MAC REDACTED]");
    expect(support).toContain("[IP REDACTED]");
    expect(support).toContain("operations-status.json");
    expect(support).not.toContain("ss -ltnp");
    expect(support).not.toMatch(/cp .*evidence/);
    expect(support).not.toMatch(/journalctl .*--no-pager\s*$/m);
  });

  it.skipIf(!userNamespacesAvailable)("creates a bounded redacted bundle in an isolated user namespace", async () => {
    const root = await temporaryRoot("support-bundle");
    const output = path.join(root, "output");
    const install = path.join(root, "install");
    const deploy = path.join(install, "deploy");
    const config = path.join(root, "rf-monitor.env");
    const operational = path.join(root, "operational.json");
    const catalog = path.join(root, "catalog.json");
    const state = path.join(root, "install.conf");
    const journalConfig = path.join(root, "journald.conf");
    const symlinkVictim = path.join(root, "support-publish-victim.txt");
    const bin = path.join(root, "bin");
    await Promise.all([mkdir(output), mkdir(deploy, { recursive: true }), mkdir(bin)]);
    await writeFile(path.join(deploy, "doctor.sh"), `#!/usr/bin/env bash
printf 'doctor token=supersecret 10.2.3.4 00:11:22:33:44:55\\n'
printf 'Authorization: Bearer bearer-secret\\n'
printf '%s\\n' '-----BEGIN PRIVATE KEY-----' 'private-key-secret-body' '-----END PRIVATE KEY-----'
`);
    await writeFile(catalog, JSON.stringify({ serial: "device-secret", centerHz: 1_575_420_000 }));
    await writeFile(operational, JSON.stringify({ site: { password: "supersecret", label: "Bridge" }, revision: 1 }));
    await writeFile(path.join(root, "config-audit.jsonl"), '{"token":"supersecret","action":"fixture"}\n');
    await writeFile(journalConfig, "SystemMaxUse=512M\n");
    await writeFile(symlinkVictim, "preserve-support-publish-victim\n");
    await writeFile(config, [
      "RF_MONITOR_PASSWORD=supersecret",
      `RF_MONITOR_CATALOG_FILE=\"${catalog}\"`,
      `RF_MONITOR_OPERATIONAL_FILE=\"${operational}\"`,
    ].join("\n") + "\n");
    await writeFile(state, [
      `INSTALL_DIR=${install}`,
      `CONFIG_FILE=${config}`,
      `JOURNAL_CONFIG_FILE=${journalConfig}`,
    ].join("\n") + "\n");
    const noisy = `#!/usr/bin/env bash
for index in $(seq 1 200); do
  printf 'password=supersecret Authorization:Bearer-secret 10.2.3.4 00:11:22:33:44:55\\n'
done
`;
    for (const command of ["systemctl", "timedatectl", "df", "free", "lsusb", "ss", "ufw", "nginx", "journalctl", "uname"]) {
      await executable(path.join(bin, command), noisy);
    }
    const supportScript = path.join(repositoryRoot, "deploy/support-bundle.sh");
    await execFile("/usr/bin/unshare", [
      "-Ur",
      "/usr/bin/env",
      `PATH=${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      `RFMON_STATE_FILE=${state}`,
      `RFMON_SUPPORT_OUTPUT_DIR=${output}`,
      "RFMON_SUPPORT_MAX_ENTRY_BYTES=1024",
      "RFMON_SUPPORT_MAX_BUNDLE_BYTES=1048576",
      "RFMON_SUPPORT_MAX_OUTPUT_BYTES=2097152",
      "RFMON_SUPPORT_CAPTURE_TIMEOUT_SECONDS=5",
      `SUPPORT_SCRIPT=${supportScript}`,
      `SUPPORT_OUTPUT=${output}`,
      `SUPPORT_SYMLINK_VICTIM=${symlinkVictim}`,
      "/bin/bash",
      "-c",
      `
/bin/bash "$SUPPORT_SCRIPT" &
support_pid=$!
for delta in -2 -1 0 1 2; do
  support_stamp="$(date --utc --date="\${delta} seconds" +%Y%m%dT%H%M%SZ)"
  ln -s "$SUPPORT_SYMLINK_VICTIM" "$SUPPORT_OUTPUT/rf-monitor-support-\${support_stamp}-\${support_pid}.tar.gz.partial" 2>/dev/null || true
done
support_status=0
wait "$support_pid" || support_status=$?
find "$SUPPORT_OUTPUT" -maxdepth 1 -type l -name '*.partial' -delete
exit "$support_status"
`,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(await readFile(symlinkVictim, "utf8")).toBe("preserve-support-publish-victim\n");
    const archives = (await readdir(output)).filter((entry) => entry.endsWith(".tar.gz"));
    expect(archives).toHaveLength(1);
    const archive = path.join(output, archives[0]);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect((await readdir(output)).some((entry) => entry.endsWith(".partial"))).toBe(false);
    expect((await readdir(output)).some((entry) => entry.includes(".partial-"))).toBe(false);
    const listing = await execFile("/usr/bin/tar", ["-tzf", archive], { maxBuffer: 1024 * 1024 });
    expect(listing.stdout).not.toMatch(/evidence|private.*key/i);
    const contents = await execFile("/usr/bin/tar", ["-xOzf", archive], { maxBuffer: 2 * 1024 * 1024 });
    expect(contents.stdout).not.toContain("supersecret");
    expect(contents.stdout).not.toContain("bearer-secret");
    expect(contents.stdout).not.toContain("private-key-secret-body");
    expect(contents.stdout).not.toContain("10.2.3.4");
    expect(contents.stdout).not.toContain("00:11:22:33:44:55");
    expect(contents.stdout).toContain("[REDACTED]");
    expect(contents.stdout).toContain("[IP REDACTED]");
    expect(contents.stdout).toContain("[MAC REDACTED]");
  });

  it("rejects unsafe numeric environment configuration", () => {
    expect(() => ops.configFromEnvironment({ RFMON_OPS_DAILY_RECORDS: "-1" })).toThrow("daily-retention-invalid");
    expect(() => ops.configFromEnvironment({ RFMON_OPS_DISK_RESERVE_BYTES: "1.5" })).toThrow("disk-reserve-invalid");
  });
});
