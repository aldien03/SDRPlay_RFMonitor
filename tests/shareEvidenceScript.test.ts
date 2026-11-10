import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../deploy/share-evidence.sh");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-share-script-"));
  roots.push(root);
  const config = path.join(root, "rf-monitor.env");
  await writeFile(config, "RF_MONITOR_PORT=8080\nRF_MONITOR_STORAGE=/var/lib/rf-monitor/evidence\n", { mode: 0o640 });
  const state = path.join(root, "install.conf");
  await writeFile(state, [
    "INSTALL_ROOT=/opt/rf-monitor", "DATA_ROOT=/var/lib/rf-monitor", "STORAGE_DIR=/var/lib/rf-monitor/evidence",
    "RUNTIME_CONFIG_DIR=/var/lib/rf-monitor/config", "CONFIG_DIR=/etc/rf-monitor", `CONFIG_FILE=${config}`,
    "SERVICE_USER=rfmonitor", "SERVICE_GROUP=rfmonitor",
  ].join("\n"));
  return { root, config, state };
}

function run(state: string, args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { env: { PATH: process.env.PATH, RFMON_STATE_FILE: state }, encoding: "utf8" });
}

const user = os.userInfo().username;

describe("share-evidence command", () => {
  it.each([
    [["--folder", "/home/someone/Documents/evidence", "--dry-run"], "cannot be inside /home"],
    [["--folder", "relative/path", "--dry-run"], "absolute path"],
    [["--folder", "/srv/with space", "--dry-run"], "letters, digits"],
    [["--folder", "/srv/../etc/x", "--dry-run"], "clean path"],
    [["--folder", "/tmp/evidence", "--dry-run"], "cannot be inside /tmp"],
    [["--folder", "/var/lib/rf-monitor/evidence/share", "--dry-run"], "separate from the evidence store"],
    [["--folder", "/var/lib/rf-monitor", "--dry-run"], "separate from the evidence store"],
    [["--folder", "/srv/rf-evidence", "--user", "root", "--dry-run"], "Say who should get access"],
    [["--folder", "/srv/rf-evidence", "--user", "no-such-user-here", "--dry-run"], "No such user"],
    [["--folder", "/srv/nonexistent-parent-dir/evidence", "--user", user, "--dry-run"], "parent folder"],
  ])("refuses %j", async (args, message) => {
    const { state } = await fixture();
    const result = run(state, args as string[]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it("refuses to change anything without root, and tells the person how to run it", async () => {
    const { state, config } = await fixture();
    const before = await readFile(config, "utf8");
    const result = run(state, ["--folder", "/srv/rf-evidence", "--user", user]);
    if (process.getuid?.() === 0) return;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sudo rf-monitor share-evidence");
    expect(await readFile(config, "utf8")).toBe(before);
  });

  it("shows its plan on a dry run and changes nothing", async () => {
    if (!existsSync("/srv")) return;
    const { state, config, root } = await fixture();
    const before = await readFile(config, "utf8");
    const result = run(state, ["--folder", "/srv/rf-monitor-evidence-dryrun-test", "--user", user, "--dry-run"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Folder:          /srv/rf-monitor-evidence-dryrun-test");
    expect(result.stdout).toContain("through the rf-evidence-readers group only");
    expect(result.stdout).toMatch(/usermod -aG rf-evidence-readers/);
    expect(result.stdout).toMatch(/install -d -m 2750 -o rfmonitor -g rf-evidence-readers \/srv\/rf-monitor-evidence-dryrun-test/);
    expect(result.stdout).toContain("would set RF_MONITOR_SHARE_DIR=/srv/rf-monitor-evidence-dryrun-test");
    expect(result.stdout).toContain("Documents/RF-Monitor-Evidence");
    expect(result.stdout).toContain("sudo rf-monitor deploy-release");
    // The service group is never given to the person.
    expect(result.stdout).not.toMatch(/usermod -aG rfmonitor/);
    expect(await readFile(config, "utf8")).toBe(before);
    expect(existsSync("/srv/rf-monitor-evidence-dryrun-test")).toBe(false);
    expect(existsSync(path.join(root, "x"))).toBe(false);
  });

  it("can switch sharing off, keeping files", async () => {
    const { state } = await fixture();
    const result = run(state, ["--stop", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would remove RF_MONITOR_SHARE_DIR");
    expect(result.stdout).toContain("Files already in the share folder are kept");
  });

  it("updates the setting in place, keeps the file's mode, and removes it again", async () => {
    const { root, config } = await fixture();
    // Run the function on its own, against a file the test owns.
    const functionText = (await readFile(SCRIPT, "utf8")).match(/set_env_value\(\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(functionText).toBeTruthy();
    const harness = path.join(root, "harness.sh");
    await writeFile(harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\nDRY_RUN=false\ndie() { echo "$*" >&2; exit 1; }\n${functionText}\nset_env_value "$1" "$2" "$3"\n`);
    await chmod(harness, 0o755);
    const call = (value: string) => spawnSync("bash", [harness, config, "RF_MONITOR_SHARE_DIR", value], { encoding: "utf8" });
    expect(call("/srv/a").status).toBe(0);
    expect(await readFile(config, "utf8")).toBe("RF_MONITOR_PORT=8080\nRF_MONITOR_STORAGE=/var/lib/rf-monitor/evidence\nRF_MONITOR_SHARE_DIR=/srv/a\n");
    expect(call("/srv/b").status).toBe(0);
    expect((await readFile(config, "utf8")).match(/RF_MONITOR_SHARE_DIR=/g)).toHaveLength(1);
    expect(await readFile(config, "utf8")).toContain("RF_MONITOR_SHARE_DIR=/srv/b");
    expect(((await stat(config)).mode & 0o777).toString(8)).toBe("640");
    expect(call("").status).toBe(0);
    expect(await readFile(config, "utf8")).toBe("RF_MONITOR_PORT=8080\nRF_MONITOR_STORAGE=/var/lib/rf-monitor/evidence\n");
  });
});
