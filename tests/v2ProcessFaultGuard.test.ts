import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/server/evidenceStore";

const temporaryRoots: string[] = [];
const environmentNames = [
  "NODE_ENV",
  "RF_MONITOR_ALLOW_TEST_PROCESS_FAULTS",
  "RF_MONITOR_TEST_PROCESS_FAULT_POINT",
  "RF_MONITOR_TEST_PROCESS_FAULT_ROOT",
  "RF_MONITOR_TEST_PROCESS_FAULT_ARM_FILE",
  "RF_MONITOR_TEST_PROCESS_FAULT_MARKER_FILE",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

afterEach(async () => {
  for (const name of environmentNames) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v2-fault-guard-"));
  temporaryRoots.push(root);
  return root;
}

describe("packaged V2 process-fault guard", () => {
  it("rejects a crash point unless the explicit test-only acknowledgement is present", async () => {
    const root = await sandbox();
    process.env.NODE_ENV = "production";
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_POINT = "frame-after-raw-append";
    expect(() => new EvidenceStore(path.join(root, "field", "evidence"))).toThrow(/test-only acknowledgement/);
  });

  it("rejects fault paths outside one temporary sandbox", async () => {
    const root = await sandbox();
    process.env.NODE_ENV = "test";
    process.env.RF_MONITOR_ALLOW_TEST_PROCESS_FAULTS = "v2-qualification-only";
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_POINT = "finalization-fsync";
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_ROOT = root;
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_ARM_FILE = path.join(root, "fault", "armed");
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_MARKER_FILE = path.join(os.tmpdir(), "outside-marker.json");
    expect(() => new EvidenceStore(path.join(root, "field", "evidence"))).toThrow(/one temporary V2 sandbox/);
  });

  it("accepts a fully confined, unarmed harness configuration without affecting normal storage", async () => {
    const root = await sandbox();
    process.env.NODE_ENV = "test";
    process.env.RF_MONITOR_ALLOW_TEST_PROCESS_FAULTS = "v2-qualification-only";
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_POINT = "rotation-after-next-session";
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_ROOT = root;
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_ARM_FILE = path.join(root, "fault", "not-created");
    process.env.RF_MONITOR_TEST_PROCESS_FAULT_MARKER_FILE = path.join(root, "fault", "marker.json");
    const store = new EvidenceStore(path.join(root, "field", "evidence"), { dataDomain: "field" });
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    expect(session).toMatchObject({ lifecycle: "Active", dataDomain: "field" });
    await store.closeActive();
  });
});
