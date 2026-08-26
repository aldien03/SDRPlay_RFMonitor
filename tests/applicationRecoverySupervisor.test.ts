import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recoveryScript = path.join(repositoryRoot, "deploy/recover-application.sh");
const temporaryRoots: string[] = [];

async function executable(destination: string, lines: string[]): Promise<void> {
  await writeFile(destination, `${lines.join("\n")}\n`);
  await chmod(destination, 0o755);
}

async function harness(mode: "manual" | "automatic" | "invalid-audit", systemctlExit = 0) {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-application-recovery-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const requestDir = path.join(root, "request");
  const stateDir = path.join(root, "state");
  await execFile("mkdir", ["-p", bin, requestDir, stateDir]);
  const restarted = path.join(root, "restarted");
  const calls = path.join(root, "systemctl-calls");
  const audit = path.join(root, "config-audit.jsonl");
  const request = path.join(requestDir, "restart-application");
  await writeFile(calls, "");
  await writeFile(audit, `${JSON.stringify({
    entryHash: mode === "invalid-audit" ? "b".repeat(64) : "a".repeat(64),
    actor: "settings-admin",
    outcome: "applied",
    changedFields: ["runtime.software-restart"],
  })}\n`);
  if (mode !== "automatic") {
    await writeFile(request, `${JSON.stringify({
      schemaVersion: 1,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestedAt: "2026-08-23T09:00:00.000Z",
      source: "settings-admin",
      expectedConfigurationRevision: 1,
      previousBootId: "boot-old",
      auditEntryHash: "a".repeat(64),
    })}\n`, { mode: 0o600 });
  }
  await executable(path.join(bin, "curl"), [
    "#!/usr/bin/env bash",
    "if [[ \"${MOCK_MODE}\" == 'automatic' && ! -e \"${MOCK_RESTARTED}\" ]]; then exit 22; fi",
    "boot='boot-old'",
    "[[ -e \"${MOCK_RESTARTED}\" ]] && boot='boot-new'",
    "printf '{\"schemaVersion\":2,\"identity\":{\"serviceBootId\":\"%s\",\"configuration\":{\"configurationRevision\":1}}}\n' \"${boot}\"",
  ]);
  await executable(path.join(bin, "systemctl"), [
    "#!/usr/bin/env bash",
    "printf '%s\n' \"$*\" >> \"${MOCK_SYSTEMCTL_CALLS}\"",
    "touch \"${MOCK_RESTARTED}\"",
    "exit \"${MOCK_SYSTEMCTL_EXIT}\"",
  ]);
  await executable(path.join(bin, "sleep"), ["#!/usr/bin/env bash", "exit 0"]);
  await executable(path.join(bin, "logger"), ["#!/usr/bin/env bash", "exit 0"]);
  return {
    root,
    request,
    stateDir,
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      MOCK_MODE: mode,
      MOCK_RESTARTED: restarted,
      MOCK_SYSTEMCTL_CALLS: calls,
      MOCK_SYSTEMCTL_EXIT: String(systemctlExit),
      RFMON_REQUEST_RUNTIME_DIR: requestDir,
      RFMON_APPLICATION_RECOVERY_RUNTIME_DIR: stateDir,
      RFMON_CONFIG_AUDIT_FILE: audit,
      RFMON_APPLICATION_STALE_CHECKS_BEFORE_RECOVERY: "1",
      RFMON_APPLICATION_AUTOMATIC_COOLDOWN_SECONDS: "0",
      RFMON_APPLICATION_MANUAL_COOLDOWN_SECONDS: "0",
      RFMON_APPLICATION_RECOVERY_WINDOW_SECONDS: "3600",
      RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS: "3",
      RFMON_APPLICATION_CONFIRM_ATTEMPTS: "1",
      RFMON_APPLICATION_CONFIRM_INTERVAL_SECONDS: "0",
      RFMON_APPLICATION_STARTUP_GRACE_SECONDS: "0",
    },
  };
}

async function run(files: Awaited<ReturnType<typeof harness>>, overrides: NodeJS.ProcessEnv = {}) {
  await execFile("/bin/bash", [recoveryScript], { env: { ...files.env, ...overrides } });
}

async function status(files: Awaited<ReturnType<typeof harness>>) {
  return JSON.parse(await readFile(path.join(files.stateDir, "status.json"), "utf8"));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded RF Monitor application recovery", () => {
  it("executes only a durably audited request and confirms a new application boot", async () => {
    const files = await harness("manual");
    await run(files);

    await expect(readFile(files.request, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(files.calls, "utf8")).trim()).toBe("--no-block restart rf-monitor.service");
    expect(await status(files)).toMatchObject({
      state: "live",
      reasonCode: "restart-confirmed",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestRetained: false,
      systemdResult: "success",
    });
  });

  it("refuses an unaudited request without invoking systemctl", async () => {
    const files = await harness("invalid-audit");
    await run(files);

    expect(await readFile(files.calls, "utf8")).toBe("");
    expect(await readFile(files.request, "utf8")).toContain("auditEntryHash");
    expect(await status(files)).toMatchObject({ state: "failed", reasonCode: "audit-not-verified", requestRetained: true });
  });

  it("bounds automatic heartbeat recovery attempts and enters visible lockout", async () => {
    const files = await harness("automatic", 1);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await unlink(path.join(files.root, "restarted")).catch(() => undefined);
      await run(files, { RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS: "2" });
    }

    expect((await readFile(files.calls, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await status(files)).toMatchObject({
      state: "lockout",
      reasonCode: "attempt-limit",
      attemptsInWindow: 2,
      maxAttempts: 2,
    });
  });

  it("retains attempts across a briefly healthy flap and cannot enter a restart loop", async () => {
    const files = await harness("automatic", 0);
    await run(files, { RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS: "2" });
    const attemptsFile = path.join(files.stateDir, "recovery-attempts");
    expect((await readFile(attemptsFile, "utf8")).trim().split("\n")).toHaveLength(1);

    // A healthy heartbeat must not erase the previous restart from the window.
    await run(files, { RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS: "2" });
    expect((await readFile(attemptsFile, "utf8")).trim().split("\n")).toHaveLength(1);

    await unlink(path.join(files.root, "restarted"));
    await run(files, { RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS: "2", MOCK_SYSTEMCTL_EXIT: "1" });
    await unlink(path.join(files.root, "restarted"));
    await run(files, { RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS: "2", MOCK_SYSTEMCTL_EXIT: "1" });
    expect((await readFile(files.calls, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await status(files)).toMatchObject({ state: "lockout", attemptsInWindow: 2, maxAttempts: 2 });
  });

  it("treats a changed boot identity as external confirmation and never replays the restart", async () => {
    const files = await harness("manual");
    await writeFile(path.join(files.root, "restarted"), "already restarted\n");
    await run(files);

    expect(await readFile(files.calls, "utf8")).toBe("");
    await expect(readFile(files.request, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await status(files)).toMatchObject({ state: "live", reasonCode: "restart-already-observed", systemdResult: "success" });
  });

  it("suppresses automatic restart while the host is under memory pressure", async () => {
    const files = await harness("automatic");
    const memoryState = path.join(files.root, "host-memory-state");
    await writeFile(memoryState, "critical\n");
    await run(files, { RFMON_HOST_MEMORY_STATE_FILE: memoryState });

    expect(await readFile(files.calls, "utf8")).toBe("");
    expect(await status(files)).toMatchObject({ state: "suppressed", reasonCode: "host-memory-pressure", attemptsInWindow: 0 });
  });

  it("keeps the request and reports a bounded pending-job timeout when the new boot never appears", async () => {
    const files = await harness("manual", 0);
    const binSystemctl = path.join(files.root, "bin", "systemctl");
    await executable(binSystemctl, [
      "#!/usr/bin/env bash",
      "printf '%s\n' \"$*\" >> \"${MOCK_SYSTEMCTL_CALLS}\"",
      "exit 0",
    ]);
    await run(files, { RFMON_APPLICATION_CONFIRM_ATTEMPTS: "2", RFMON_APPLICATION_CONFIRM_INTERVAL_SECONDS: "0" });

    expect((await readFile(files.calls, "utf8")).trim()).toBe("--no-block restart rf-monitor.service");
    expect(await readFile(files.request, "utf8")).toContain("previousBootId");
    expect(await status(files)).toMatchObject({
      state: "failed",
      reasonCode: "heartbeat-confirmation-timeout",
      requestRetained: true,
      systemdResult: "accepted",
    });
  });

  it("ships bounded service restart policy and a persistent external heartbeat timer", async () => {
    const service = await readFile(path.join(repositoryRoot, "deploy/rf-monitor.service.template"), "utf8");
    const timer = await readFile(path.join(repositoryRoot, "deploy/rf-monitor-application-recovery.timer"), "utf8");
    expect(service).toContain("StartLimitIntervalSec=3600");
    expect(service).toContain("StartLimitBurst=5");
    expect(service).toContain("Restart=on-failure");
    expect(timer).toContain("OnCalendar=*-*-* *:*:00,30");
    expect(timer).toContain("Persistent=true");
    const watchdog = await readFile(path.join(repositoryRoot, "deploy/recover-application.sh"), "utf8");
    expect(watchdog).toContain('RFMON_APPLICATION_STALE_CHECKS_BEFORE_RECOVERY:-2');
    expect(watchdog).toContain("--max-filesize 65536");
    const watchdogUnit = await readFile(path.join(repositoryRoot, "deploy/rf-monitor-application-recovery.service.template"), "utf8");
    expect(watchdogUnit).toContain("Group=@@SERVICE_GROUP@@");
    expect(watchdogUnit).toContain("TimeoutStartSec=150s");
    expect(watchdog).toContain("RFMON_APPLICATION_CONFIRM_ATTEMPTS:-30");
    expect(watchdog).toContain("RFMON_APPLICATION_STARTUP_GRACE_SECONDS:-60");
    expect(watchdog).toContain("host-memory-pressure");
    expect(watchdog).toContain("flock --nonblock");
    expect(watchdog).toContain("systemctl --no-block restart rf-monitor.service");
  });
});
