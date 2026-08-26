import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recoveryScript = path.join(repositoryRoot, "deploy/recover-sdrconnect.sh");
const supervisorVerifier = path.join(repositoryRoot, "deploy/verify-recovery-supervisor.sh");
const temporaryRoots: string[] = [];

interface Harness {
  root: string;
  requestDir: string;
  stateDir: string;
  requestFile: string;
  statusFile: string;
  systemctlCalls: string;
  env: NodeJS.ProcessEnv;
}

async function executable(destination: string, lines: string[]): Promise<void> {
  await writeFile(destination, `${lines.join("\n")}\n`);
  await chmod(destination, 0o755);
}

async function createHarness(curlMode: "offline" | "recovers", systemctlExit: number): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-recovery-helper-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const requestDir = path.join(root, "request");
  const stateDir = path.join(root, "state");
  await Promise.all([writeFile(path.join(root, "curl-count"), "0\n"), writeFile(path.join(root, "systemctl-calls"), "")]);
  await execFile("mkdir", ["-p", bin, requestDir, stateDir]);
  await executable(path.join(bin, "lsusb"), ["#!/usr/bin/env bash", "printf '%s\\n' 'Bus 001 Device 002: ID 1df7:0001 SDRplay'"]);
  await executable(path.join(bin, "curl"), [
    "#!/usr/bin/env bash",
    "count=$(cat \"${MOCK_CURL_COUNTER}\")",
    "count=$((count + 1))",
    "printf '%s\\n' \"${count}\" > \"${MOCK_CURL_COUNTER}\"",
    "if [[ \"${MOCK_CURL_MODE}\" == 'recovers' && ${count} -ge 2 ]]; then",
    "  printf '%s\\n' '{\"monitoringReady\":true,\"receivers\":[{\"streamState\":\"live\",\"transportState\":\"connected\"}]}'",
    "else",
    "  printf '%s\\n' '{\"monitoringReady\":false,\"receivers\":[{\"streamState\":\"stalled\",\"transportState\":\"offline\"}]}'",
    "fi",
  ]);
  await executable(path.join(bin, "systemctl"), [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$*\" >> \"${MOCK_SYSTEMCTL_CALLS}\"",
    "exit \"${MOCK_SYSTEMCTL_EXIT}\"",
  ]);
  await executable(path.join(bin, "logger"), ["#!/usr/bin/env bash", "exit 0"]);
  await executable(path.join(bin, "sleep"), ["#!/usr/bin/env bash", "exit 0"]);
  const requestFile = path.join(requestDir, "recover-sdrconnect");
  await writeFile(requestFile, '{"schemaVersion":1,"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","requestedAt":"2026-08-23T09:00:00.000Z","source":"operator"}\n', { mode: 0o600 });
  return {
    root,
    requestDir,
    stateDir,
    requestFile,
    statusFile: path.join(stateDir, "status.json"),
    systemctlCalls: path.join(root, "systemctl-calls"),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      MOCK_CURL_COUNTER: path.join(root, "curl-count"),
      MOCK_CURL_MODE: curlMode,
      MOCK_SYSTEMCTL_CALLS: path.join(root, "systemctl-calls"),
      MOCK_SYSTEMCTL_EXIT: String(systemctlExit),
      RFMON_REQUEST_RUNTIME_DIR: requestDir,
      RFMON_RECOVERY_RUNTIME_DIR: stateDir,
      RFMON_STALE_CHECKS_BEFORE_RECOVERY: "1",
      RFMON_AUTOMATIC_RECOVERY_COOLDOWN_SECONDS: "0",
      RFMON_MANUAL_RECOVERY_COOLDOWN_SECONDS: "120",
      RFMON_RECOVERY_WINDOW_SECONDS: "3600",
      RFMON_MAX_RECOVERY_ATTEMPTS: "3",
      RFMON_RECOVERY_CONFIRM_ATTEMPTS: "1",
      RFMON_RECOVERY_CONFIRM_INTERVAL_SECONDS: "0",
      RFMON_RECEIVER_STARTUP_GRACE_SECONDS: "0",
    },
  };
}

async function runRecovery(harness: Harness, overrides: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFile("/bin/bash", [recoveryScript], { env: { ...harness.env, ...overrides } });
}

async function status(harness: Harness): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(harness.statusFile, "utf8"));
}

interface SupervisorHarness {
  root: string;
  unitDir: string;
  statusFile: string;
  env: NodeJS.ProcessEnv;
}

async function createSupervisorHarness(): Promise<SupervisorHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-supervisor-verifier-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const unitDir = path.join(root, "systemd");
  const configFile = path.join(root, "rf-monitor.env");
  const statusFile = path.join(root, "status.json");
  await Promise.all([mkdir(bin), mkdir(unitDir), writeFile(configFile, "RF_MONITOR_PORT=8080\n")]);
  await copyFile(path.join(repositoryRoot, "deploy/rf-monitor-sdr-recovery.timer"), path.join(unitDir, "rf-monitor-sdr-recovery.timer"));
  const serviceTemplate = await readFile(path.join(repositoryRoot, "deploy/rf-monitor-sdr-recovery.service.template"), "utf8");
  expect(serviceTemplate).toContain("Group=@@SERVICE_GROUP@@");
  await writeFile(
    path.join(unitDir, "rf-monitor-sdr-recovery.service"),
    serviceTemplate
      .replaceAll("@@INSTALL_DIR@@", repositoryRoot)
      .replaceAll("@@CONFIG_FILE@@", configFile)
      .replaceAll("@@SERVICE_GROUP@@", "rfmonitor-test"),
  );
  await Promise.all([
    chmod(path.join(unitDir, "rf-monitor-sdr-recovery.timer"), 0o644),
    chmod(path.join(unitDir, "rf-monitor-sdr-recovery.service"), 0o644),
  ]);
  await writeFile(statusFile, `${JSON.stringify({
    schemaVersion: 1,
    state: "live",
    reasonCode: "monitoring-ready",
    source: "automatic",
    observedAt: new Date().toISOString(),
  })}\n`);
  await executable(path.join(bin, "systemctl"), [
    "#!/usr/bin/env bash",
    "case \"$1\" in",
    "  is-enabled|is-active)",
    "    [[ \"${MOCK_TIMER_AVAILABLE:-true}\" == 'true' ]]",
    "    exit",
    "    ;;",
    "  show)",
    "    unit=\"$2\"",
    "    property=''",
    "    for argument in \"$@\"; do",
    "      case \"${argument}\" in --property=*) property=\"${argument#--property=}\" ;; esac",
    "    done",
    "    case \"${property}\" in",
    "      LoadState) printf '%s\\n' \"${MOCK_LOAD_STATE:-loaded}\" ;;",
    "      FragmentPath) printf '%s/%s\\n' \"${MOCK_UNIT_DIR}\" \"${unit}\" ;;",
    "      NeedDaemonReload) printf '%s\\n' \"${MOCK_NEED_RELOAD:-no}\" ;;",
    "      DropInPaths) printf '%s\\n' \"${MOCK_DROP_INS:-}\" ;;",
    "      NextElapseUSecRealtime)",
    "        if [[ \"${MOCK_HAS_NEXT_RUN:-true}\" == 'true' ]]; then date --utc --date='+2 minutes' '+%Y-%m-%dT%H:%M:%SZ'; fi",
    "        ;;",
    "    esac",
    "    ;;",
    "  *) exit 1 ;;",
    "esac",
  ]);
  const owner = (await execFile("stat", ["-c", "%U:%G", path.join(unitDir, "rf-monitor-sdr-recovery.timer")])).stdout.trim();
  return {
    root,
    unitDir,
    statusFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      MOCK_UNIT_DIR: unitDir,
      RFMON_INSTALL_DIR: repositoryRoot,
      RFMON_CONFIG_FILE: configFile,
      RFMON_SERVICE_GROUP: "rfmonitor-test",
      RFMON_SYSTEMD_UNIT_DIR: unitDir,
      RFMON_RECOVERY_STATUS_FILE: statusFile,
      RFMON_EXPECT_UNIT_OWNER: owner,
    },
  };
}

async function runSupervisorVerifier(harness: SupervisorHarness, env: NodeJS.ProcessEnv = {}, arguments_: string[] = []): Promise<{ code: number; output: string }> {
  try {
    const result = await execFile("/bin/bash", [supervisorVerifier, ...arguments_], { env: { ...harness.env, ...env } });
    return { code: 0, output: result.stdout };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded SDRconnect recovery supervisor", () => {
  it("rejects a symlinked privileged request without invoking systemctl", async () => {
    const harness = await createHarness("offline", 0);
    const target = path.join(harness.root, "untrusted-request.json");
    await writeFile(target, await readFile(harness.requestFile, "utf8"));
    await unlink(harness.requestFile);
    await symlink(target, harness.requestFile);

    await runRecovery(harness);

    expect(await readFile(harness.systemctlCalls, "utf8")).toBe("");
    expect(await status(harness)).toMatchObject({ state: "failed", reasonCode: "invalid-request-file", requestRetained: false });
  });

  it("suppresses automatic receiver recovery while host memory is pressured", async () => {
    const harness = await createHarness("offline", 0);
    await unlink(harness.requestFile);
    const memoryState = path.join(harness.root, "host-memory-state");
    await writeFile(memoryState, "pressure\n");
    await runRecovery(harness, { RFMON_HOST_MEMORY_STATE_FILE: memoryState });

    expect(await readFile(harness.systemctlCalls, "utf8")).toBe("");
    expect(await status(harness)).toMatchObject({ state: "suppressed", reasonCode: "host-memory-pressure", attemptsInWindow: 0 });
  });

  it("resets stale state and waits through a new SDRconnect process epoch", async () => {
    const harness = await createHarness("offline", 0);
    const systemctl = path.join(harness.root, "bin", "systemctl");
    await executable(systemctl, [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  *--property=MainPID*) printf '4321\\n' ;;",
      "  *--property=ActiveEnterTimestamp*) date '+%Y-%m-%d %H:%M:%S %Z' ;;",
      "  *) printf '%s\\n' \"$*\" >> \"${MOCK_SYSTEMCTL_CALLS}\" ;;",
      "esac",
    ]);
    await runRecovery(harness, { RFMON_RECEIVER_STARTUP_GRACE_SECONDS: "90" });

    expect(await readFile(harness.systemctlCalls, "utf8")).toBe("");
    expect(await status(harness)).toMatchObject({ state: "suppressed", reasonCode: "receiver-startup-grace", attemptsInWindow: 0 });
    expect(await readFile(path.join(harness.stateDir, "process-epoch"), "utf8")).toContain("4321|");
  });

  it("retains an accepted request when systemd rejects the restart", async () => {
    const harness = await createHarness("offline", 1);

    await runRecovery(harness);

    expect(await readFile(harness.requestFile, "utf8")).toContain('"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"');
    expect(await status(harness)).toMatchObject({
      schemaVersion: 1,
      state: "failed",
      reasonCode: "systemd-restart-failed",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestRetained: true,
      systemdResult: "failed",
    });
    expect((await readFile(harness.systemctlCalls, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readdir(harness.stateDir)).filter((entry) => entry.includes(".partial."))).toEqual([]);
  });

  it("honors cooldown and then enters lockout without a restart loop", async () => {
    const harness = await createHarness("offline", 1);
    await runRecovery(harness, { RFMON_MANUAL_RECOVERY_COOLDOWN_SECONDS: "0", RFMON_MAX_RECOVERY_ATTEMPTS: "2" });
    await runRecovery(harness, { RFMON_MANUAL_RECOVERY_COOLDOWN_SECONDS: "0", RFMON_MAX_RECOVERY_ATTEMPTS: "2" });
    await runRecovery(harness, { RFMON_MANUAL_RECOVERY_COOLDOWN_SECONDS: "0", RFMON_MAX_RECOVERY_ATTEMPTS: "2" });
    await runRecovery(harness, { RFMON_MANUAL_RECOVERY_COOLDOWN_SECONDS: "0", RFMON_MAX_RECOVERY_ATTEMPTS: "2" });

    expect((await readFile(harness.systemctlCalls, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await status(harness)).toMatchObject({
      state: "lockout",
      reasonCode: "attempt-limit",
      attemptsInWindow: 2,
      maxAttempts: 2,
      requestRetained: true,
    });
  });

  it("removes the request only after live frames are confirmed", async () => {
    const harness = await createHarness("recovers", 0);

    await runRecovery(harness);

    await expect(readFile(harness.requestFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await status(harness)).toMatchObject({
      state: "live",
      reasonCode: "recovery-confirmed",
      requestRetained: false,
      systemdResult: "success",
    });
    expect((await readFile(path.join(harness.stateDir, "recovery-attempts"), "utf8")).trim()).toMatch(/^\d+$/);
  });

  it("keeps a manual request pending during the bounded cooldown", async () => {
    const harness = await createHarness("offline", 1);
    await runRecovery(harness);
    await runRecovery(harness);

    expect((await readFile(harness.systemctlCalls, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await status(harness)).toMatchObject({
      state: "failed",
      reasonCode: "recovery-cooldown",
      requestRetained: true,
    });
  });
});

describe("recovery deployment contract", () => {
  it("uses a persistent calendar timer and loads the exact release units", async () => {
    const harness = await createSupervisorHarness();
    const result = await runSupervisorVerifier(harness);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Recovery timer content matches this RF Monitor release.");
    expect(result.output).toContain("systemd loaded the release recovery service with no pending reload or drop-ins.");
    expect(result.output).toContain("Receiver recovery timer has a future run:");
    expect(result.output).toContain("Receiver recovery helper produced a fresh structured result.");
  });

  it("fails closed for stale installed content or manager state", async () => {
    const harness = await createSupervisorHarness();
    await writeFile(path.join(harness.unitDir, "rf-monitor-sdr-recovery.timer"), "# stale local timer\n", { flag: "a" });

    const result = await runSupervisorVerifier(harness, { MOCK_NEED_RELOAD: "yes", MOCK_DROP_INS: "/etc/systemd/system/rf-monitor-sdr-recovery.timer.d/local.conf" });

    expect(result.code).toBe(1);
    expect(result.output).toContain("Recovery timer content differs from this RF Monitor release.");
    expect(result.output).toContain("systemd did not load the exact release recovery timer");
  });

  it("rejects an inactive timer, missing future run, or pre-trigger status", async () => {
    const harness = await createSupervisorHarness();
    const futureEpoch = Math.floor(Date.now() / 1_000) + 120;

    const result = await runSupervisorVerifier(
      harness,
      { MOCK_TIMER_AVAILABLE: "false", MOCK_HAS_NEXT_RUN: "false" },
      ["--minimum-status-epoch", String(futureEpoch)],
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain("Receiver recovery timer is not enabled.");
    expect(result.output).toContain("Receiver recovery timer is not active.");
    expect(result.output).toContain("Receiver recovery timer has no real future run.");
    expect(result.output).toContain("earlier than the required first trigger");
  });

  it("forces daemon reload and timer restart before bounded first-result verification", async () => {
    const timer = await readFile(path.join(repositoryRoot, "deploy/rf-monitor-sdr-recovery.timer"), "utf8");
    const doctor = await readFile(path.join(repositoryRoot, "deploy/doctor.sh"), "utf8");
    const installer = await readFile(path.join(repositoryRoot, "deploy/install-ubuntu.sh"), "utf8");
    const serviceSection = installer.slice(installer.indexOf('say "Enabling UTC clock synchronization and services"'));

    expect(timer).toContain("OnCalendar=*-*-* *:*:15,45");
    expect(timer).toContain("Persistent=true");
    expect(timer).not.toContain("OnUnitActiveSec=");
    expect(doctor).toContain("verify-recovery-supervisor.sh");
    expect(doctor).toContain('recovery_state="$(jq -r');
    expect(serviceSection.indexOf("systemctl daemon-reload")).toBeLessThan(serviceSection.indexOf("systemctl enable --now rf-monitor-sdr-recovery.timer"));
    expect(serviceSection.indexOf("systemctl enable --now rf-monitor-sdr-recovery.timer")).toBeLessThan(serviceSection.indexOf("systemctl restart rf-monitor-sdr-recovery.timer"));
    expect(serviceSection.indexOf("systemctl restart rf-monitor-sdr-recovery.timer")).toBeLessThan(serviceSection.indexOf("systemctl start rf-monitor-sdr-recovery.service"));
    expect(serviceSection.indexOf("systemctl start rf-monitor-sdr-recovery.service")).toBeLessThan(serviceSection.indexOf("verify-recovery-supervisor.sh"));
    expect(serviceSection).toContain('--minimum-status-epoch "${recovery_first_trigger_epoch}"');
    expect(serviceSection).toContain("--wait-status 30");
    expect(await readFile(recoveryScript, "utf8")).toContain("RFMON_STALE_CHECKS_BEFORE_RECOVERY:-2");
    expect(await readFile(recoveryScript, "utf8")).toContain("RFMON_RECEIVER_STARTUP_GRACE_SECONDS:-90");
    expect(await readFile(recoveryScript, "utf8")).toContain("flock --nonblock");
  });
});
