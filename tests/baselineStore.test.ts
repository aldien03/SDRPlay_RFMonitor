import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BaselineFingerprintConflictError,
  BaselineGenerationConflictError,
  BaselineNotReviewableError,
  BaselineRestartCommitUncertainError,
  BaselineStore,
  ProtectedBaselineImmutableError,
  baselineFingerprintId,
  canonicalFingerprintJson,
  type BaselineFingerprint,
} from "../src/server/baselineStore";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fingerprint(overrides: Record<string, unknown> = {}): BaselineFingerprint {
  return {
    dataDomain: "field",
    targetId: "gnss-l1-combined",
    receiverId: "rspdx-1",
    deviceId: "serial-redacted",
    antennaId: "roof-a",
    fixedGainState: { lna: 4, gainReductionDb: 31 },
    centerHz: 1_575_420_000,
    spanHz: 10_000_000,
    confirmedSampleRateHz: 10_000_000,
    fftGrid: { startHz: 1_570_420_000, endHz: 1_580_420_000, bins: 4 },
    analysisMask: { startBin: 1, endBin: 2 },
    sdrconnectVersion: "1.0-test",
    spectrumReference: -30,
    spectrumBase: -120,
    catalogVersion: "catalog-v3",
    detectorVersion: "detector-v2",
    ...overrides,
  } as BaselineFingerprint;
}

async function fixture(options: Partial<Parameters<typeof BaselineStore.open>[0]> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-baseline-"));
  temporaryRoots.push(root);
  const filePath = path.join(root, "baselines.json");
  const store = await BaselineStore.open({ filePath, ...options });
  return { root, filePath, store };
}

describe("baseline fingerprinting and selection", () => {
  it("[trace:DET-200] uses canonical SHA-256 IDs and never selects a similar fingerprint", async () => {
    const files = await fixture();
    const original = fingerprint();
    const reordered = {
      dataDomain: "field",
      detectorVersion: "detector-v2",
      catalogVersion: "catalog-v3",
      spectrumBase: -120,
      spectrumReference: -30,
      sdrconnectVersion: "1.0-test",
      analysisMask: { endBin: 2, startBin: 1 },
      fftGrid: { bins: 4, endHz: 1_580_420_000, startHz: 1_570_420_000 },
      confirmedSampleRateHz: 10_000_000,
      spanHz: 10_000_000,
      centerHz: 1_575_420_000,
      fixedGainState: { gainReductionDb: 31, lna: 4 },
      antennaId: "roof-a",
      deviceId: "serial-redacted",
      receiverId: "rspdx-1",
      targetId: "gnss-l1-combined",
    } as BaselineFingerprint;

    expect(canonicalFingerprintJson(original)).toBe(canonicalFingerprintJson(reordered));
    expect(baselineFingerprintId(original)).toMatch(/^[a-f0-9]{64}$/);
    expect(baselineFingerprintId(original)).toBe(baselineFingerprintId(reordered));

    files.store.ensure(original);
    expect(files.store.resolve(reordered).lifecycle).toBe("learning");
    const stale = files.store.resolve(fingerprint({ spectrumBase: -119 }));
    expect(stale.lifecycle).toBe("stale");
    if (stale.lifecycle === "stale") expect(stale.previous).toHaveLength(1);
    await files.store.flush();
  });
});

describe("bounded learning reservoir", () => {
  it("keeps one packed reservoir at or below 256 observations", async () => {
    const files = await fixture({ random: () => 0 });
    const key = fingerprint({ fftGrid: { bins: 1 }, analysisMask: "all" });
    files.store.ensure(key);
    for (let index = 0; index < 300; index += 1) files.store.observe(key, Uint8Array.of(index % 256));
    const selected = files.store.resolve(key);
    expect(selected.lifecycle).toBe("learning");
    if (selected.lifecycle !== "stale") {
      expect(selected.baseline.reservoirCount).toBe(256);
      expect(selected.baseline.reservoirSeen).toBe(300);
      expect(selected.baseline.binCount).toBe(1);
    }
    expect(files.store.getAllocationBytes()).toBeGreaterThanOrEqual(258);
    await files.store.flush();

    const persisted = JSON.parse(await readFile(files.filePath, "utf8"));
    expect(Buffer.from(persisted.records[0].reservoirBase64, "base64")).toHaveLength(256);
    expect(files.store.checkpointStatus.pendingLatest).toBe(false);
    expect(files.store.checkpointStatus.coalesced).toBeGreaterThan(0);
    expect(files.store.checkpointStatus.writes).toBeLessThanOrEqual(2);
    expect((await readdir(files.root)).some((name) => name.includes(".partial-"))).toBe(false);
  });

  it("counts missing visits against coverage without training the reservoir", async () => {
    const files = await fixture();
    const key = fingerprint();
    files.store.ensure(key);
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let index = 0; index < 64; index += 1) {
      files.store.observe(key, Uint8Array.of(40, 41, 42, 43), {
        observedAt: start + Math.round(index * (30 * 60_000) / 63),
        exposureMs: 1_000,
      });
    }
    files.store.recordGap(key, { observedAt: start + 31 * 60_000, missedVisits: 17, reason: "insufficient-frames" });
    const selected = files.store.resolve(key);
    expect(selected.lifecycle).toBe("learning");
    if (selected.lifecycle !== "stale") {
      expect(selected.baseline.coverageRatio).toBeLessThan(0.8);
      expect(selected.baseline.reservoirCount).toBe(64);
      expect(selected.baseline.reservoirSeen).toBe(64);
    }
    await files.store.flush();
  });

  it("continues filling a partially used packed reservoir after restart", async () => {
    const files = await fixture({ reservoirCapacity: 8, random: () => 0.5 });
    const key = fingerprint();
    files.store.ensure(key);
    files.store.observe(key, Uint8Array.of(40, 41, 42, 43));
    files.store.observe(key, Uint8Array.of(44, 45, 46, 47));
    await files.store.flush();

    const reopened = await BaselineStore.open({
      filePath: files.filePath,
      reservoirCapacity: 8,
      random: () => 0.5,
    });
    expect(() => reopened.observe(key, Uint8Array.of(48, 49, 50, 51))).not.toThrow();
    const selected = reopened.resolve(key);
    expect(selected.lifecycle).toBe("learning");
    if (selected.lifecycle !== "stale") expect(selected.baseline.reservoirCount).toBe(3);
    await reopened.flush();
  });
});

describe("baseline lifecycle and immutable protection", () => {
  it("counts a representative hour after an isolated rejected visit when valid coverage stays above 80%", async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const files = await fixture({ now: () => start, random: () => 0.5 });
    const key = fingerprint();
    files.store.ensure(key);

    for (let index = 0; index < 64; index += 1) {
      files.store.observe(key, Uint8Array.of(40, 42, 44, 46), {
        observedAt: start + Math.round(index * (30 * 60_000) / 63),
        exposureMs: 1_000,
      });
    }
    files.store.recordGap(key, { observedAt: start + 15 * 60_000, reason: "insufficient-frames" });

    expect(files.store.resolve(key)).toMatchObject({
      lifecycle: "provisional",
      baseline: {
        coverageRatio: 64 / 65,
        representativeUtcHours: 1,
      },
    });
    await files.store.flush();
  });

  it("[trace:DET-201] requires 30 minutes, 64 observations, 80% coverage, and 24 UTC hours before approval", async () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const files = await fixture({ now: () => now, random: () => 0.5 });
    const key = fingerprint();
    const initial = files.store.ensure(key);

    for (let index = 0; index < 64; index += 1) {
      const at = now + Math.round(index * (30 * 60_000) / 63);
      files.store.observe(key, Uint8Array.of(40, 42, 44, 46), { observedAt: at, exposureMs: 1_000 });
    }
    let selected = files.store.resolve(key);
    expect(selected.lifecycle).toBe("provisional");
    if (selected.lifecycle !== "stale") {
      expect(selected.baseline.totalValidObservations).toBe(64);
      expect(selected.baseline.coverageRatio).toBe(1);
      expect(selected.baseline.representativeUtcHours).toBe(1);
    }

    for (let hour = 1; hour < 24; hour += 1) {
      for (let visit = 0; visit < 10; visit += 1) {
        files.store.observe(key, Uint8Array.of(40, 42, 44, 46), {
          observedAt: now + hour * 60 * 60_000 + Math.round(visit * (30 * 60_000) / 9),
          exposureMs: 1_000,
        });
      }
    }
    selected = files.store.resolve(key);
    expect(selected.lifecycle).toBe("reviewable");
    if (selected.lifecycle !== "stale") {
      expect(selected.baseline.representativeUtcHours).toBe(24);
      expect([...selected.baseline.median]).toEqual([40, 42, 44, 46]);
      expect([...selected.baseline.mad]).toEqual([0, 0, 0, 0]);
    }

    now += 24 * 60 * 60_000;
    const protectedBaseline = files.store.approve({
      fingerprint: key,
      expectedFingerprintId: initial.fingerprintId,
      expectedGeneration: initial.generation,
      approvedBy: "commissioning-operator",
    });
    expect(protectedBaseline.lifecycle).toBe("protected");
    expect(protectedBaseline.reservoirCount).toBe(0);
    expect(() => files.store.observe(key, Uint8Array.of(40, 42, 44, 46))).toThrow(ProtectedBaselineImmutableError);

    const restarted = files.store.restart(key, protectedBaseline.generation);
    expect(restarted.lifecycle).toBe("learning");
    expect(restarted.generation).toBe(protectedBaseline.generation + 1);
    expect(files.store.list(key.targetId).map((entry) => entry.lifecycle)).toEqual(["protected", "learning"]);
    await files.store.flush();

    const reopened = await BaselineStore.open({ filePath: files.filePath, now: () => now, random: () => 0.5 });
    expect(reopened.list(key.targetId).map((entry) => [entry.generation, entry.lifecycle])).toEqual([
      [protectedBaseline.generation, "protected"],
      [restarted.generation, "learning"],
    ]);
  });

  it("keeps an explicitly source-unsafe hour excluded with a persisted reason", async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const files = await fixture({ now: () => start, random: () => 0.5 });
    const key = fingerprint();
    files.store.ensure(key);
    for (let index = 0; index < 64; index += 1) {
      files.store.observe(key, Uint8Array.of(40, 42, 44, 46), {
        observedAt: start + Math.round(index * (30 * 60_000) / 63),
        exposureMs: 1_000,
      });
    }
    for (let hour = 1; hour < 24; hour += 1) {
      files.store.recordGap(key, {
        observedAt: start + hour * 60 * 60_000,
        missedVisits: 99,
        reason: "receiver-unhealthy",
        disqualifyHourReason: "source-integrity-unsafe",
      });
      files.store.observe(key, Uint8Array.of(40, 42, 44, 46), {
        observedAt: start + hour * 60 * 60_000 + 30 * 60_000,
        exposureMs: 1_000,
      });
    }

    expect(files.store.resolve(key)).toMatchObject({
      lifecycle: "learning",
      baseline: {
        representativeUtcHours: 1,
        learningExclusions: {
          rejectedVisits: 2_277,
          rejectedByReason: { "receiver-unhealthy": 2_277 },
          disqualifiedHours: 23,
          disqualifiedByReason: { "source-integrity-unsafe": 23 },
        },
      },
    });
    await files.store.flush();

    const persisted = JSON.parse(await readFile(files.filePath, "utf8"));
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.records[0].hourBuckets[1]).toMatchObject({
      rejectedByReason: { "receiver-unhealthy": 99 },
      disqualificationReasons: ["source-integrity-unsafe"],
    });
    const reopened = await BaselineStore.open({ filePath: files.filePath });
    expect(reopened.resolve(key)).toMatchObject({
      lifecycle: "learning",
      baseline: { representativeUtcHours: 1, learningExclusions: { disqualifiedHours: 23 } },
    });
  });

  it("rejects stale fingerprint, generation, and lifecycle approvals", async () => {
    const files = await fixture();
    const key = fingerprint();
    const active = files.store.ensure(key);
    expect(() => files.store.approve({ fingerprint: key, expectedFingerprintId: active.fingerprintId, expectedGeneration: active.generation }))
      .toThrow(BaselineNotReviewableError);
    expect(() => files.store.approve({ fingerprint: key, expectedFingerprintId: "0".repeat(64), expectedGeneration: active.generation }))
      .toThrow(BaselineFingerprintConflictError);
    expect(() => files.store.restart(key, active.generation + 1)).toThrow(BaselineGenerationConflictError);
    await files.store.flush();
  });
});

describe("fail-closed persistence", () => {
  it("migrates schema v2 ineligible hours conservatively without rehabilitating them", async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const files = await fixture({ now: () => start, random: () => 0.5 });
    const key = fingerprint();
    files.store.ensure(key);
    for (let index = 0; index < 64; index += 1) {
      files.store.observe(key, Uint8Array.of(40, 42, 44, 46), {
        observedAt: start + Math.round(index * (30 * 60_000) / 63),
        exposureMs: 1_000,
      });
    }
    files.store.recordGap(key, { observedAt: start + 15 * 60_000, reason: "insufficient-frames" });
    await files.store.flush();
    const legacy = JSON.parse(await readFile(files.filePath, "utf8"));
    legacy.schemaVersion = 2;
    for (const bucket of legacy.records[0].hourBuckets) {
      bucket.eligible = false;
      delete bucket.rejectedByReason;
      delete bucket.disqualificationReasons;
    }
    await writeFile(files.filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const reopened = await BaselineStore.open({ filePath: files.filePath });
    expect(reopened.resolve(key)).toMatchObject({
      lifecycle: "provisional",
      baseline: {
        representativeUtcHours: 0,
        learningExclusions: {
          rejectedVisits: 1,
          rejectedByReason: { "legacy-unclassified": 1 },
          disqualifiedHours: 1,
          disqualifiedByReason: { "legacy-unclassified": 1 },
        },
      },
    });
    reopened.observe(key, Uint8Array.of(40, 42, 44, 46), { observedAt: start + 31 * 60_000, exposureMs: 1_000 });
    await reopened.flush();
    const migrated = JSON.parse(await readFile(files.filePath, "utf8"));
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.records[0].hourBuckets[0]).toMatchObject({
      rejectedByReason: { "legacy-unclassified": 1 },
      disqualificationReasons: ["legacy-unclassified"],
    });
  });

  it("rolls back the in-memory generation when the atomic restart write fails", async () => {
    const files = await fixture();
    const key = fingerprint();
    const first = files.store.ensure(key);
    files.store.observe(key, Uint8Array.of(40, 41, 42, 43));
    await files.store.flush();
    const persistedBefore = await readFile(files.filePath, "utf8");

    const failedWriteAt = Date.UTC(2026, 7, 23, 12, 30, 0);
    await mkdir(`${files.filePath}.partial-${process.pid}-${failedWriteAt}`);
    vi.spyOn(Date, "now").mockReturnValue(failedWriteAt);

    await expect(files.store.restartAndFlush(key, first.generation)).rejects.toMatchObject({ code: "EEXIST" });

    const selected = files.store.resolve(key);
    expect(selected).toMatchObject({ lifecycle: "learning", baseline: { generation: first.generation, reservoirCount: 1 } });
    expect(files.store.list(key.targetId)).toHaveLength(1);
    expect(await readFile(files.filePath, "utf8")).toBe(persistedBefore);
  });

  it("classifies a failure after rename as a committed generation requiring durability recovery", async () => {
    let armed = false;
    const files = await fixture({
      injectAtomicWriteFault(point) {
        if (armed && point === "after-rename-before-directory-sync") {
          armed = false;
          throw new Error("injected directory fsync failure");
        }
      },
    });
    const key = fingerprint();
    const first = files.store.ensure(key);
    files.store.observe(key, Uint8Array.of(40, 41, 42, 43));
    await files.store.flush();
    armed = true;

    const error = await files.store.restartAndFlush(key, first.generation).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BaselineRestartCommitUncertainError);
    expect(error).toMatchObject({ committed: true, descriptor: { generation: 2, lifecycle: "learning" } });
    expect(files.store.resolve(key)).toMatchObject({ lifecycle: "learning", baseline: { generation: 2, reservoirCount: 0 } });
    const reopened = await BaselineStore.open({ filePath: files.filePath });
    expect(reopened.resolve(key)).toMatchObject({ lifecycle: "learning", baseline: { generation: 2, reservoirCount: 0 } });
    await files.store.confirmStorageDurability();
  });

  it("backs up a corrupt file and refuses to start from an empty baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-baseline-corrupt-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "baselines.json");
    await writeFile(filePath, "{not-json", "utf8");

    await expect(BaselineStore.open({ filePath })).rejects.toThrow(/must remain in Checking/);
    expect((await readdir(root)).some((name) => /^baselines\.json\.invalid-.*\.bak$/.test(name))).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("{not-json");
  });

  it("rejects unbounded persisted learning-rejection reason keys", async () => {
    const files = await fixture();
    const key = fingerprint();
    files.store.ensure(key);
    files.store.observe(key, Uint8Array.of(40, 41, 42, 43), { observedAt: Date.UTC(2026, 0, 1), exposureMs: 1_000 });
    await files.store.flush();
    const persisted = JSON.parse(await readFile(files.filePath, "utf8"));
    persisted.records[0].hourBuckets[0].rejectedByReason = { "unbounded-user-value": 1 };
    await writeFile(files.filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    await expect(BaselineStore.open({ filePath: files.filePath })).rejects.toThrow(/must remain in Checking/);
    expect((await readdir(files.root)).some((name) => /^baselines\.json\.invalid-.*\.bak$/.test(name))).toBe(true);
  });
});
