import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaselineStore, type BaselineFingerprint } from "../src/server/baselineStore";
import {
  assertSeparatedDomainRoots,
  acquireDataDomainLease,
  clearTestDomain,
  createDataDomainPaths,
  ensureDomainRoot,
  inspectLegacyBaseline,
  repairInterruptedTestClear,
} from "../src/server/dataDomains";
import { EvidenceStore } from "../src/server/evidenceStore";
import type { PersistedSpectrumFrame } from "../src/shared/types";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-domains-"));
  roots.push(root);
  return {
    root,
    paths: createDataDomainPaths({
      baseRoot: root,
      legacyBaselineFile: path.join(root, "legacy", "baselines-v1.json"),
    }),
  };
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      hash.update(path.relative(root, absolute));
      if (entry.isDirectory()) await walk(absolute);
      else hash.update(await readFile(absolute));
    }
  };
  await walk(root);
  return hash.digest("hex");
}

function fingerprint(): BaselineFingerprint {
  return {
    dataDomain: "test",
    targetId: "gnss-l1-e1-b1c-sbas",
    receiverId: "synthetic-0",
    centerHz: 1_575_420_000,
  };
}

function persistedFrame(dataDomain: "field" | "test", source: "sdrconnect" | "simulation"): PersistedSpectrumFrame {
  return {
    id: "frame-domain-test",
    dataDomain,
    timestamp: "2026-08-23T12:00:00.000Z",
    receiver: 0,
    bandId: "gps-l1",
    targetId: "gnss-l1-e1-b1c-sbas",
    scanWindowId: "gnss-l1-e1-b1c-sbas",
    startHz: 1_570_420_000,
    endHz: 1_580_420_000,
    bins: Uint8Array.of(30, 31, 32, 33),
    inputBinCount: 4,
    binning: "native",
    source,
    calibrated: false,
    configurationEpoch: 1,
    tuneEpoch: 1,
    visitEpoch: 1,
    visitId: "visit-1",
    receivedMonotonicMs: 1,
    requestedCenterHz: 1_575_420_000,
    confirmedCenterHz: 1_575_420_000,
    confirmedSampleRateHz: 10_000_000,
    analysisStartBin: 0,
    analysisEndBin: 4,
    analysisSpanHz: 8_000_000,
    captureSpanHz: 10_000_000,
    tuneConfirmedAt: "2026-08-23T11:59:59.750Z",
  };
}

describe("field/test storage boundary", () => {
  it("rejects overlapping roots and a conflicting on-disk marker", async () => {
    const { root } = await fixture();
    expect(() => assertSeparatedDomainRoots(path.join(root, "field"), path.join(root, "field", "test"))).toThrow(/separate, non-nested/);
    expect(() => createDataDomainPaths({
      baseRoot: path.join(root, "field-control-conflict"),
      fieldRoot: path.join(root, "field-control-conflict"),
      testRoot: path.join(root, "separate-test"),
      legacyBaselineFile: path.join(root, "legacy.json"),
    })).toThrow(/control root must remain outside/);
    const selected = path.join(root, "selected");
    await ensureDomainRoot(selected, "field");
    await expect(ensureDomainRoot(selected, "test")).rejects.toThrow(/conflicting domain marker/);
  });

  it("[trace:DOM-020] keeps the field tree byte-identical across 100,000 test observations", async () => {
    const { paths } = await fixture();
    await ensureDomainRoot(paths.field.root, "field");
    await mkdir(path.join(paths.field.root, "evidence"), { recursive: true });
    await writeFile(path.join(paths.field.root, "evidence", "field-sentinel.bin"), Buffer.from("immutable-field-data"));
    const before = await treeHash(paths.field.root);

    await ensureDomainRoot(paths.test.root, "test");
    const store = await BaselineStore.open({ filePath: paths.test.baselineFile, dataDomain: "test", random: () => 0.99999 });
    store.ensure(fingerprint());
    for (let index = 0; index < 100_000; index += 1) {
      store.observe(fingerprint(), Uint8Array.of(index % 31), { observedAt: index + 1 });
    }
    await store.flush();

    expect(await treeHash(paths.field.root)).toBe(before);
    expect(store.resolve(fingerprint())).toMatchObject({ baseline: { reservoirCount: 256, reservoirSeen: 100_000 } });
  }, 30_000);

  it("[trace:TRUTH-003] rejects unscoped, cross-domain, and simulated field evidence", async () => {
    const { paths } = await fixture();
    const field = new EvidenceStore(paths.field.evidenceRoot, { dataDomain: "field" });
    await field.initialize({ config: {}, sdrconnect: {} });
    await expect(field.recordFrame(persistedFrame("test", "simulation"), {})).rejects.toThrow(/not field/);
    await expect(field.recordFrame(persistedFrame("field", "simulation"), {})).rejects.toThrow(/Simulation frames cannot enter field/);
    const unscoped = { ...persistedFrame("field", "sdrconnect"), dataDomain: undefined } as unknown as PersistedSpectrumFrame;
    await expect(field.recordFrame(unscoped, {})).rejects.toThrow(/unscoped/);
    expect(field.currentSession?.frameCount).toBe(0);
  });

  it("preserves and reports unscoped v1 learning instead of selecting or deleting it", async () => {
    const { paths } = await fixture();
    await mkdir(path.dirname(paths.legacyBaselineFile), { recursive: true });
    const legacy = JSON.stringify({ schemaVersion: 1, updatedAt: "2026-08-22T00:00:00.000Z", records: [{ targetId: "gnss-l1-e1-b1c-sbas" }] });
    await writeFile(paths.legacyBaselineFile, legacy);
    const status = await inspectLegacyBaseline(paths.legacyBaselineFile);
    expect(status).toMatchObject({ state: "ignored", reason: "unscoped-data-domain", recordCount: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await readFile(paths.legacyBaselineFile, "utf8")).toBe(legacy);
  });

  it("[trace:DOM-030] clears only the test tree and records the protected maintenance boundary", async () => {
    const { paths } = await fixture();
    await ensureDomainRoot(paths.field.root, "field");
    await ensureDomainRoot(paths.test.root, "test");
    await writeFile(path.join(paths.field.root, "field.txt"), "field");
    await writeFile(path.join(paths.test.root, "test.txt"), "test");
    const before = await treeHash(paths.field.root);

    const result = await clearTestDomain(paths, "settings-admin");

    expect(result).toMatchObject({ domain: "test", previousDataPresent: true });
    expect(await treeHash(paths.field.root)).toBe(before);
    await expect(stat(path.join(paths.test.root, "test.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(paths.test.root, ".rf-monitor-data-domain.json"), "utf8"))).toMatchObject({ dataDomain: "test" });
    expect(await readFile(path.join(paths.baseRoot, "domain-maintenance-audit.jsonl"), "utf8")).toContain('"type":"test-data-cleared"');
  });

  it("refuses to clear test data while a runtime holds the domain lease", async () => {
    const { paths } = await fixture();
    const lease = await acquireDataDomainLease(paths.test.root, "test");
    await expect(clearTestDomain(paths)).rejects.toThrow(/active in process/);
    await lease.release();
    await expect(clearTestDomain(paths)).resolves.toMatchObject({ domain: "test" });
  });

  it.each([
    "before-prepared-audit" as const,
    "before-commit-rename" as const,
  ])("leaves the original test tree and field tree byte-identical on a %s failure", async (faultPoint) => {
    const { paths } = await fixture();
    await ensureDomainRoot(paths.field.root, "field");
    await ensureDomainRoot(paths.test.root, "test");
    await writeFile(path.join(paths.field.root, "field.bin"), "field-original");
    await writeFile(path.join(paths.test.root, "test.bin"), "test-original");
    const fieldBefore = await treeHash(paths.field.root);
    const testBefore = await treeHash(paths.test.root);

    await expect(clearTestDomain(paths, {
      actor: "settings-admin",
      operationId: `precommit-${faultPoint === "before-prepared-audit" ? "audit" : "rename"}-0001`,
      injectFault(point) {
        if (point === faultPoint) throw new Error(`injected ${point}`);
      },
    })).rejects.toThrow(`injected ${faultPoint}`);

    expect(await treeHash(paths.field.root)).toBe(fieldBefore);
    expect(await treeHash(paths.test.root)).toBe(testBefore);
    await expect(repairInterruptedTestClear(paths)).resolves.toEqual({ found: false, committed: false });
    expect(await treeHash(paths.field.root)).toBe(fieldBefore);
    expect(await treeHash(paths.test.root)).toBe(testBefore);
    await expect(clearTestDomain(paths, {
      actor: "settings-admin",
      operationId: `retry-${faultPoint === "before-prepared-audit" ? "audit" : "rename"}-0001`,
    })).resolves.toMatchObject({ state: "complete", committed: true });
    expect(await treeHash(paths.field.root)).toBe(fieldBefore);
    await expect(stat(path.join(paths.test.root, "test.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a crash immediately after the destructive rename without restoring old test data", async () => {
    const { paths } = await fixture();
    await ensureDomainRoot(paths.field.root, "field");
    await ensureDomainRoot(paths.test.root, "test");
    await writeFile(path.join(paths.field.root, "field.bin"), "field-original");
    await writeFile(path.join(paths.test.root, "test.bin"), "test-original");
    const fieldBefore = await treeHash(paths.field.root);

    const result = await clearTestDomain(paths, {
      actor: "settings-admin",
      operationId: "post-rename-crash-0001",
      injectFault(point) {
        if (point === "after-commit-rename") throw new Error("injected process crash");
      },
    });

    expect(result).toMatchObject({ committed: true, state: "recovery-required", cleanupPending: true, auditDurable: false });
    await expect(stat(paths.test.root)).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = await repairInterruptedTestClear(paths);
    expect(recovered).toMatchObject({ found: true, committed: true, result: { state: "complete", operationId: result.operationId } });
    expect(await treeHash(paths.field.root)).toBe(fieldBefore);
    await expect(stat(path.join(paths.test.root, "test.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(paths.test.root, ".rf-monitor-test-generation.json"), "utf8"))).toMatchObject({
      clearOperationId: result.operationId,
      dataDomain: "test",
    });
  });

  it.each([
    ["before-replacement-create", true, false],
    ["before-cleanup", true, false],
    ["after-cleanup", false, false],
    ["before-completion-audit", false, false],
    ["before-journal-cleanup", false, true],
  ] as const)("reports committed recovery at %s and completes it idempotently", async (faultPoint, cleanupPending, auditDurable) => {
    const { paths } = await fixture();
    await ensureDomainRoot(paths.field.root, "field");
    await ensureDomainRoot(paths.test.root, "test");
    await writeFile(path.join(paths.field.root, "field.bin"), "field-original");
    await writeFile(path.join(paths.test.root, "test.bin"), "test-original");
    const fieldBefore = await treeHash(paths.field.root);

    const result = await clearTestDomain(paths, {
      actor: "settings-admin",
      operationId: `boundary-${faultPoint.replaceAll("-", "")}-0001`,
      injectFault(point) {
        if (point === faultPoint) throw new Error(`injected ${point}`);
      },
    });

    expect(result).toMatchObject({ committed: true, state: "recovery-required", cleanupPending, auditDurable });
    expect(await treeHash(paths.field.root)).toBe(fieldBefore);
    const recovered = await repairInterruptedTestClear(paths);
    expect(recovered).toMatchObject({ found: true, committed: true, result: { state: "complete" } });
    await expect(repairInterruptedTestClear(paths)).resolves.toEqual({ found: false, committed: false });
    expect(await treeHash(paths.field.root)).toBe(fieldBefore);
    await expect(stat(path.join(paths.test.root, "test.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await readFile(path.join(paths.baseRoot, "domain-maintenance-audit.jsonl"), "utf8");
    expect(audit).toContain(`\"operationId\":\"${result.operationId}\"`);
    expect(audit).toContain('"type":"test-data-cleared"');
  });

  it("fails closed when an interrupted committed clear finds an unverified replacement tree", async () => {
    const { paths } = await fixture();
    await ensureDomainRoot(paths.test.root, "test");
    await writeFile(path.join(paths.test.root, "test.bin"), "old");
    const result = await clearTestDomain(paths, {
      operationId: "ambiguous-replacement-0001",
      injectFault(point) {
        if (point === "after-commit-rename") throw new Error("crash");
      },
    });
    expect(result.state).toBe("recovery-required");
    await ensureDomainRoot(paths.test.root, "test");
    await writeFile(path.join(paths.test.root, "unknown.bin"), "not-journaled");
    await expect(repairInterruptedTestClear(paths)).rejects.toThrow(/unverified replacement tree/);
  });
});
