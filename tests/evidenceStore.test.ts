import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceStore } from "../src/server/evidenceStore";
import { verifyEvidenceDirectory, verifyMultipartEvidenceDirectories } from "../src/server/evidenceVerifier";
import type { DetectionEvent, PersistedSpectrumFrame } from "../src/shared/types";

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(sessionId: string, overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  const timestamp = "2026-01-01T12:00:00.000Z";
  return {
    id: "event-1",
    dataDomain: "field",
    sessionId,
    kind: "wideband-noise-rise",
    status: "interference-likely",
    severity: "medium",
    evidenceStrength: "Medium",
    evidenceBasis: "Repeated relative RF anomaly against a protected baseline.",
    baselineFingerprintId: "b".repeat(64),
    ruleSetId: "rules-commissioning-v1",
    observationId: "observation-1",
    service: "startrack",
    bandId: "startrack-410-470",
    targetId: "startrack-window",
    bandLabel: "StarTrack radio",
    affectedRangeHz: [410_000_000, 470_000_000],
    observed: "Wide noise rise across band.",
    recommendedAction: "Continue recording.",
    startedAt: timestamp,
    lastSeenAt: timestamp,
    notes: [],
    metrics: {
      timestamp,
      bandId: "startrack-410-470",
      meanLevel: 95,
      peakLevel: 220,
      baselineLevel: 30,
      baselineDelta: 65,
      occupiedRatio: 0.5,
      overload: false,
    },
    ...overrides,
  };
}

function frame(overrides: Partial<PersistedSpectrumFrame> = {}): PersistedSpectrumFrame {
  const bins = overrides.bins ?? Uint8Array.of(10, 20, 30, 40);
  return {
    id: "frame-1",
    dataDomain: "field",
    timestamp: "2026-01-01T12:00:00.000Z",
    receiver: 0,
    bandId: "startrack-410-470",
    targetId: "startrack-window",
    startHz: 410_000_000,
    endHz: 470_000_000,
    bins,
    inputBinCount: overrides.inputBinCount ?? bins.length,
    binning: "native",
    source: "sdrconnect",
    calibrated: false,
    configurationEpoch: 1,
    tuneEpoch: 1,
    visitEpoch: 1,
    visitId: "visit-1",
    scanWindowId: "startrack-window",
    receivedMonotonicMs: 1,
    requestedCenterHz: 440_000_000,
    confirmedCenterHz: 440_000_000,
    confirmedSampleRateHz: 10_000_000,
    analysisStartBin: 0,
    analysisEndBin: overrides.analysisEndBin ?? bins.length,
    analysisSpanHz: 8_000_000,
    captureSpanHz: 10_000_000,
    tuneConfirmedAt: "2026-01-01T11:59:59.500Z",
    ...overrides,
  };
}

const syntheticExercise = {
  synthetic: true as const,
  runId: "run-1",
  scenarioId: "wideband",
  scenarioVersion: "1.0.0",
  scenarioHash: "a".repeat(64),
  validationProtocolVersion: "rf-synthetic-validation-1",
  generatorVersion: "relative-fft-generator-1",
};

interface StoredZipEntry {
  method: number;
  contents: Buffer;
}

function storedZipEntries(zip: Buffer): Map<string, StoredZipEntry> {
  const entries = new Map<string, StoredZipEntry>();
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let cursor = zip.indexOf(centralSignature);
  while (cursor >= 0 && cursor + 46 <= zip.byteLength && zip.readUInt32LE(cursor) === 0x02014b50) {
    const method = zip.readUInt16LE(cursor + 10);
    const compressedBytes = zip.readUInt32LE(cursor + 20);
    const nameBytes = zip.readUInt16LE(cursor + 28);
    const extraBytes = zip.readUInt16LE(cursor + 30);
    const commentBytes = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8");
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameBytes = zip.readUInt16LE(localOffset + 26);
    const localExtraBytes = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    entries.set(name, { method, contents: zip.subarray(dataOffset, dataOffset + compressedBytes) });
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  return entries;
}

function singleExportPath(result: string | string[]): string {
  expect(Array.isArray(result)).toBe(false);
  if (Array.isArray(result)) throw new Error("Expected a single test export part");
  return result;
}

describe("evidence store", { timeout: 60_000 }, () => {
  it("rejects synthetic evidence absolutely at a field-store boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-synthetic-field-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root, { dataDomain: "field" });
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await expect(store.recordFrame(frame({ source: "simulation", syntheticExercise }), {})).rejects.toThrow(/isolated test-domain store/);
    await expect(store.recordFrame(frame({ dataDomain: "test", source: "simulation", syntheticExercise }), {})).rejects.toThrow(/isolated test-domain store/);
    await expect(store.recordEvent(event(session.id, { syntheticExercise }))).rejects.toThrow(/isolated test-domain store/);
    await expect(store.recordOperationalAction({
      type: "synthetic-target-visit-completed",
      dataDomain: "field",
      syntheticExercise,
    })).rejects.toThrow(/isolated test-domain store/);
    expect(store.currentSession).toMatchObject({ frameCount: 0, eventCount: 0 });
  });

  it("rejects mixed-domain, non-simulation, and malformed synthetic test evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-synthetic-mixed-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root, { dataDomain: "test" });
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await expect(store.recordFrame(frame({ source: "simulation", syntheticExercise }), {})).rejects.toThrow(/test-domain payload/);
    await expect(store.recordFrame(frame({ dataDomain: "test", source: "sdrconnect", syntheticExercise }), {})).rejects.toThrow(/simulation source/);
    await expect(store.recordFrame(frame({
      dataDomain: "test",
      source: "simulation",
      syntheticExercise: { ...syntheticExercise, synthetic: false } as unknown as typeof syntheticExercise,
    }), {})).rejects.toThrow(/synthetic marker is invalid/);
    await expect(store.recordEvent(event(session.id, { dataDomain: "field", syntheticExercise }))).rejects.toThrow(/test-domain payload/);
    await expect(store.recordOperationalAction({
      type: "synthetic-target-visit-unknown",
      dataDomain: "field",
      syntheticExercise,
    })).rejects.toThrow(/test-domain payload/);
    expect(store.currentSession).toMatchObject({ frameCount: 0, eventCount: 0 });
  });

  it("persists bounded synthetic frames, events, and gaps only in test evidence with deterministic verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-synthetic-test-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root, { dataDomain: "test" });
    const session = await store.initialize({ config: { mode: "simulation" }, sdrconnect: { source: "synthetic" } });
    await store.recordFrame(frame({ dataDomain: "test", source: "simulation", syntheticExercise }), { evidenceState: "test" });
    await store.recordEvent(event(session.id, { dataDomain: "test", syntheticExercise }));
    await store.recordOperationalAction({
      type: "synthetic-target-visit-unknown",
      dataDomain: "test",
      visit: { id: "visit-1", targetId: "startrack-window", outcome: "unknown", failureReason: "insufficient-frames" },
      syntheticExercise,
    });
    const closed = await store.closeActive();
    expect(closed).toMatchObject({ dataDomain: "test", lifecycle: "Complete", frameCount: 1, eventCount: 1 });

    const [firstVerification, secondVerification] = await Promise.all([
      verifyEvidenceDirectory(session.path, { expectedDataDomain: "test" }),
      verifyEvidenceDirectory(session.path, { expectedDataDomain: "test" }),
    ]);
    expect(firstVerification).toEqual(secondVerification);
    expect(firstVerification).toMatchObject({ outcome: "PASS", dataDomain: "test" });
    const frameIndex = await readFile(path.join(session.path, "spectrum", "frames.jsonl"), "utf8");
    const eventIndex = await readFile(path.join(session.path, "events", "events.jsonl"), "utf8");
    const operations = await readFile(path.join(session.path, "operations.jsonl"), "utf8");
    for (const contents of [frameIndex, eventIndex, operations]) {
      expect(contents).toContain('"syntheticExercise"');
      expect(contents).toContain('"runId":"run-1"');
      expect(contents).toContain('"dataDomain":"test"');
    }
  });

  it("accepts only detector analysis that matches the stored frame grid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-detector-grid-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    await store.initialize({ config: {}, sdrconnect: {} });
    const detectorAnalysis = {
      schemaVersion: 1 as const,
      source: "relative-mad-detector" as const,
      observationId: "observation-1",
      ruleSetId: "rf-relative-mad-v1",
      disposition: "anomalous" as const,
      analyzedRangeHz: [436_000_000, 444_000_000] as [number, number],
      analysisStartBin: 0,
      analysisEndBin: 4,
      baselineAvailable: true,
      overload: false,
      anomalyKind: "narrowband-spike" as const,
      anomalyBinRanges: [{ startBin: 1, endBin: 2 }],
    };
    await store.recordFrame(frame({ detectorAnalysis }), {});
    await expect(store.recordFrame(frame({
      id: "bad-detector-frame",
      detectorAnalysis: { ...detectorAnalysis, anomalyBinRanges: [{ startBin: 3, endBin: 5 }] },
    }), {})).rejects.toThrow(/escapes the analyzed grid/);
    await expect(store.recordFrame(frame({
      id: "bad-overload-frame",
      detectorAnalysis: { ...detectorAnalysis, overload: true },
    }), {})).rejects.toThrow(/overload cannot carry RF anomaly ranges/);
  });

  it("appends same-hour frames to one indexed raw chunk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-chunk-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: { mode: "test" }, sdrconnect: { api: "mock" } });
    const first = frame();
    const second = frame({ id: "frame-2", timestamp: "2026-01-01T12:00:01.000Z" });
    await store.recordFrame(first, { meanLevel: 25 });
    await store.recordFrame(second, { meanLevel: 26 });
    const manifest = await store.createManifest();
    const chunks = manifest.files.filter((entry) => entry.path.startsWith("spectrum/raw/") && entry.path.endsWith(".bin"));
    expect(chunks).toEqual([expect.objectContaining({ bytes: 8 })]);
    const lines = (await readFile(path.join(session.path, "spectrum", "frames.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.rawOffset, line.rawLength])).toEqual([[0, 4], [4, 4]]);
  });

  it("rolls an hourly raw chunk before its 128 MiB production bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-roll-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root, { rawChunkMaxBytes: 6 });
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame({ id: "frame-1" }), {});
    await store.recordFrame(frame({ id: "frame-2", timestamp: "2026-01-01T12:00:01.000Z" }), {});
    await store.recordFrame(frame({ id: "frame-3", timestamp: "2026-01-01T12:00:02.000Z" }), {});

    const chunks = (await readdir(path.join(session.path, "spectrum", "raw"))).sort();
    expect(chunks).toEqual([
      "frames-2026-01-01T12-part-001.bin",
      "frames-2026-01-01T12-part-002.bin",
      "frames-2026-01-01T12-part-003.bin",
    ]);
    const lines = (await readFile(path.join(session.path, "spectrum", "frames.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.rawFile, line.rawOffset])).toEqual(chunks.map((name) => [`spectrum/raw/${name}`, 0]));
    await expect(store.recordFrame(frame({ bins: [1, 2, 3, 4] as unknown as Uint8Array }), {})).rejects.toThrow(/Uint8Array/);
  });

  it("flushes at most 240 reduced prehistory frames through one bounded batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-prehistory-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const frames = Array.from({ length: 240 }, (_, index) => ({
      frame: frame({
        id: `prehistory-${index}`,
        timestamp: new Date(Date.parse("2026-01-01T12:00:00.000Z") + index).toISOString(),
        bins: Uint8Array.of(index % 256),
      }),
      summary: { evidenceState: "prehistory" },
    }));
    await store.recordPrehistory(frames);
    expect(store.currentSession).toMatchObject({ frameCount: 240 });
    expect((await stat(path.join(session.path, "spectrum", "raw", "frames-2026-01-01T12-part-001.bin"))).size).toBe(240);
    expect((await readFile(path.join(session.path, "spectrum", "frames.jsonl"), "utf8")).trim().split("\n")).toHaveLength(240);

    await expect(store.recordPrehistory([...frames, frames[0]])).rejects.toThrow(/cannot exceed 240/);
    expect(store.currentSession).toMatchObject({ frameCount: 240 });
  });

  it("writes raw bins, JSONL records, and SHA-256 manifests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-evidence-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const runtimeIdentity = {
      schemaVersion: 1,
      serviceBootId: "00000000-0000-4000-8000-000000000001",
      serviceStartedAt: "2026-01-01T00:00:00.000Z",
      nodeVersion: "v22.0.0",
      release: {
        schemaVersion: 1,
        product: "rf-monitor",
        releaseVersion: "1.0.0",
        buildId: "release-test",
        serverBuildId: "release-test",
        clientBuildId: "release-test",
        sourceDigest: "a".repeat(64),
        packageDigest: "b".repeat(64),
        dependencyLockDigest: "c".repeat(64),
        integrity: "release-metadata",
      },
      protocols: { health: 2, live: 2, evidenceManifest: 2, catalogSchema: 3, operationalSchema: 3 },
      configuration: {
        catalogVersion: "catalog-v3",
        configurationHash: "d".repeat(64),
        configurationRevision: 1,
        detectorRuleSetId: "rf-relative-mad-v1",
        expectedSampleRateHz: 10_000_000,
      },
    } as const;
    const session = await store.initialize({ config: { mode: "test", runtimeIdentity }, sdrconnect: { api: "mock" } });
    await store.recordFrame(frame(), { meanLevel: 25 });
    await store.recordEvent(event(session.id));
    await store.recordMetadata(0, { property: "api_version", value: "1.0.3" });
    await store.recordConfigurationAudit({
      timestamp: new Date(0).toISOString(),
      revision: 2,
      actor: "settings-admin",
      clientAddress: "127.0.0.1",
      changedFields: ["siteName"],
      outcome: "applied",
      previousConfigurationHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      previousEntryHash: "0".repeat(64),
      entryHash: "c".repeat(64),
    });
    const screenshot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await store.recordScreenshot(session.id, "event-1", screenshot);
    await store.addNote(session.id, "event-1", "Independent position check completed.");
    const manifest = await store.createManifest();

    expect(manifest).toMatchObject({ schemaVersion: 2, dataDomain: "field" });
    expect(manifest.runtimeIdentity).toEqual(runtimeIdentity);
    expect(manifest.hashAlgorithm).toBe("SHA-256");
    expect(manifest.files.some((entry) => entry.path.endsWith(".bin") && entry.bytes === 4)).toBe(true);
    expect(manifest.files.some((entry) => entry.path === "events/events.jsonl")).toBe(true);
    expect(manifest.files.some((entry) => entry.path.startsWith("screenshots/") && entry.bytes === screenshot.byteLength)).toBe(true);
    expect(manifest.files.some((entry) => entry.path === "sdrconnect-events.jsonl")).toBe(true);
    expect(manifest.files.some((entry) => entry.path === "configuration-audit.jsonl")).toBe(true);
    expect(manifest.files.every((entry) => !entry.path.includes("\\"))).toBe(true);
    await expect(stat(path.join(session.path, "iq"))).rejects.toThrow();
    const rawEntry = manifest.files.find((entry) => entry.path.endsWith(".bin"));
    expect(rawEntry?.sha256).toBe(createHash("sha256").update(Uint8Array.of(10, 20, 30, 40)).digest("hex"));
    expect(JSON.parse(await readFile(path.join(session.path, "session.json"), "utf8")).path).toBe(".");
    expect((await readFile(path.join(session.path, "SHA256SUMS.txt"), "utf8"))).toContain("manifest.json");
    expect(store.currentSession).toMatchObject({ frameCount: 1, eventCount: 1, status: "recording" });
  });

  it("exports only the bounded incident slice as an atomic ZIP-store package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-export-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const legacyEvent = {
      ...event(session.id),
      observed: "Possible spoofing with confidence 91% at -42 dBm.",
      confidence: 91,
      signalPowerDbm: -42,
    } as DetectionEvent;
    await store.recordFrame(frame(), { confidence: 91, signalPowerDbm: -42 });
    await store.recordFrame(frame({
      id: "outside-frame",
      timestamp: "2026-01-01T12:20:00.000Z",
      bins: Uint8Array.of(201, 202, 203, 204),
    }), {});
    await store.recordFrame(frame({ id: "other-target", targetId: "other-window", bins: Uint8Array.of(101, 102, 103, 104) }), {});
    // Manifest-v1 readers remain compatible with claims that new writes now
    // reject. Seed this legacy line directly, then verify export redaction.
    await appendFile(path.join(session.path, "events", "events.jsonl"), `${JSON.stringify(legacyEvent)}\n`);
    expect((await store.listSessionEvents(session.id))[0]).toMatchObject({ id: legacyEvent.id });
    await writeFile(path.join(session.path, "notes", "unrelated.json"), "UNRELATED-SESSION-DATA");

    await store.closeActive();
    const zipPath = singleExportPath(await store.exportIncident(legacyEvent));
    const zip = await readFile(zipPath);
    const entries = storedZipEntries(zip);
    const packageRoot = `${session.id}-${legacyEvent.id}`;
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect((await stat(zipPath)).size).toBeGreaterThan(200);
    expect([...entries.values()].every((entry) => entry.method === 0)).toBe(true);
    const report = entries.get(`${packageRoot}/report.html`)?.contents.toString("utf8") ?? "";
    expect(report).toContain("Suspected RF interference");
    expect(report).toContain("RF data can show interference, not intent.");
    const incidentPayload = entries.get(`${packageRoot}/incident.json`)?.contents.toString("utf8") ?? "";
    const frameLines = (entries.get(`${packageRoot}/spectrum/frames.jsonl`)?.contents.toString("utf8") ?? "").trim().split("\n").filter(Boolean);
    expect(frameLines).toHaveLength(1);
    expect(JSON.parse(frameLines[0]).frame.id).toBe("frame-1");
    expect(entries.has(`${packageRoot}/source-context/${session.id}/config.json`)).toBe(true);
    expect(entries.has(`${packageRoot}/source-context/${session.id}/sdrconnect.json`)).toBe(true);
    expect(entries.has(`${packageRoot}/source-context/index.json`)).toBe(true);
    expect([...entries.keys()].some((name) => name.endsWith("session.json") || name.endsWith("unrelated.json"))).toBe(false);
    expect(entries.get(`${packageRoot}/spectrum/raw/frames-2026-01-01T12-part-001.bin`)?.contents).toEqual(Buffer.from([10, 20, 30, 40]));
    expect(JSON.parse(entries.get(`${packageRoot}/manifest.json`)?.contents.toString("utf8") ?? "{}").schemaVersion).toBe(2);
    expect(`${report}\n${incidentPayload}\n${frameLines.join("\n")}`).not.toMatch(/confidence|dbm|spoof/i);
    await expect(stat(path.join(session.path, "events", "incident-event-1.html"))).rejects.toThrow();
    expect((await readdir(path.join(root, "exports"))).every((name) => !name.includes(".partial-"))).toBe(true);
  });

  it("rejects unsupported RF-only claims from new evidence writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-claim-boundary-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const unsupported = {
      ...event(session.id),
      severity: "high" as const,
      observed: "Confirmed spoofing at -42 dBm.",
    };

    await expect(store.recordEvent(unsupported)).rejects.toThrow(/RF-only detection event rejected/);
    expect(store.currentSession?.eventCount).toBe(0);
  });

  it("pins an incident export to its immutable detection-time baseline generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-baseline-reference-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const incident = event(session.id, { baselineGenerationId: "1" });
    const reference = {
      schemaVersion: 1,
      descriptor: { fingerprintId: incident.baselineFingerprintId, generation: 1, lifecycle: "protected" },
      fingerprint: { targetId: incident.targetId },
      arrays: { encoding: "uint8-base64", binCount: 4, medianBase64: "AQIDBA==", madBase64: "AQEBAQ==" },
    };
    await store.recordFrame(frame(), {});
    await store.recordEvent(incident, undefined, reference);

    await expect(store.recordEvent(incident, undefined, {
      ...reference,
      descriptor: { ...reference.descriptor, generation: 2 },
    })).rejects.toThrow(/immutable stored snapshot/);
    await store.closeActive();

    const zipPath = singleExportPath(await store.exportIncident(incident));
    const entries = storedZipEntries(await readFile(zipPath));
    const packageRoot = `${session.id}-${incident.id}`;
    expect(JSON.parse(entries.get(`${packageRoot}/baseline-reference.json`)?.contents.toString("utf8") ?? "{}").descriptor.generation).toBe(1);
    expect(JSON.parse(entries.get(`${packageRoot}/manifest.json`)?.contents.toString("utf8") ?? "{}")).toMatchObject({ complete: true, evidenceGap: false });
  });

  it("marks a generation-pinned incident incomplete when its baseline snapshot is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-missing-baseline-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const incident = event(session.id, { baselineGenerationId: "7" });
    await store.recordFrame(frame(), {});
    await store.recordEvent(incident);
    await store.closeActive();
    const entries = storedZipEntries(await readFile(singleExportPath(await store.exportIncident(incident))));
    const manifest = JSON.parse(entries.get(`${session.id}-${incident.id}/manifest.json`)?.contents.toString("utf8") ?? "{}");
    expect(manifest).toMatchObject({ complete: false, evidenceGap: true });
    expect(manifest.missingParts).toContain(`baseline:${incident.baselineFingerprintId}`);
  });

  it("exports one logical incident across rotated session parts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-cross-session-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const first = await store.initialize({ config: { part: 1 }, sdrconnect: {} });
    const initial = event(first.id, { sessionIds: [first.id] });
    await store.recordFrame(frame({ id: "part-1-frame" }), {});
    await store.recordEvent(initial);
    await store.closeActive();

    const second = await store.initialize({ config: { part: 2 }, sdrconnect: {} });
    const continued = event(first.id, {
      sessionIds: [first.id, second.id],
      lastSeenAt: "2026-01-01T12:00:30.000Z",
    });
    await store.recordFrame(frame({
      id: "part-2-frame",
      timestamp: "2026-01-01T12:00:30.000Z",
      bins: Uint8Array.of(50, 60, 70, 80),
    }), {});
    await store.recordEvent(continued, second.id);
    await store.closeActive();

    const restored = await store.findIncidentEvent(continued.id, first.id);
    expect(restored).toMatchObject({ id: continued.id, sessionIds: [first.id, second.id] });
    const zipPath = singleExportPath(await store.exportIncident(restored!));
    const entries = storedZipEntries(await readFile(zipPath));
    const packageRoot = `${first.id}-${continued.id}`;
    const indexedFrames = (entries.get(`${packageRoot}/spectrum/frames.jsonl`)?.contents.toString("utf8") ?? "")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(indexedFrames.map((entry) => entry.frame.id)).toEqual(["part-1-frame", "part-2-frame"]);
    expect(indexedFrames.map((entry) => entry.sourceSessionId)).toEqual([first.id, second.id]);
    expect([...entries.keys()].filter((name) => name.endsWith(".bin"))).toEqual(expect.arrayContaining([
      `${packageRoot}/spectrum/raw/${first.id}/frames-2026-01-01T12-part-001.bin`,
      `${packageRoot}/spectrum/raw/${second.id}/frames-2026-01-01T12-part-001.bin`,
    ]));
    const slice = JSON.parse(entries.get(`${packageRoot}/slice.json`)?.contents.toString("utf8") ?? "{}");
    expect(slice).toMatchObject({ frameCount: 2, sourceSessionIds: [first.id, second.id] });
  });

  it("exports surviving incident lineage with an explicit signed completeness gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-missing-lineage-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const first = await store.initialize({ config: {}, sdrconnect: {} });
    await store.closeActive();
    const second = await store.initialize({ config: {}, sdrconnect: {} });
    const incident = event(first.id, {
      sessionIds: [first.id, second.id],
      lastSeenAt: "2026-01-01T12:00:30.000Z",
    });
    await store.recordFrame(frame({ id: "surviving", timestamp: "2026-01-01T12:00:30.000Z" }), {});
    await store.recordEvent(incident, second.id);
    await store.closeActive();
    await rm(first.path, { recursive: true, force: true });

    const zipPath = singleExportPath(await store.exportIncident(incident));
    const entries = storedZipEntries(await readFile(zipPath));
    const rootName = `${second.id}-${incident.id}`;
    const completeness = JSON.parse(entries.get(`${rootName}/completeness.json`)?.contents.toString("utf8") ?? "{}");
    const manifest = JSON.parse(entries.get(`${rootName}/manifest.json`)?.contents.toString("utf8") ?? "{}");
    expect(completeness).toMatchObject({ complete: false, evidenceGap: true, missingSessionIds: [first.id] });
    expect(manifest).toMatchObject({ complete: false, evidenceGap: true, missingParts: [first.id] });
  });

  it("refuses an export that cannot preserve the configured disk reserve", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-export-reserve-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame(), {});
    await store.closeActive();
    await expect(store.exportIncident(event(session.id), { minimumFreeBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/scratch space/);
    expect((await readdir(path.join(root, "exports"))).every((name) => !name.includes(".partial-"))).toBe(true);
  });

  it("splits a large incident into complete numbered ZIP parts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-multipart-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root, { rawChunkMaxBytes: 4_096, exportPartMaxBytes: 32_768 });
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    for (let index = 0; index < 20; index += 1) {
      await store.recordFrame(frame({
        id: `multipart-${index}`,
        timestamp: new Date(Date.parse("2026-01-01T12:00:00.000Z") + index * 1_000).toISOString(),
        bins: new Uint8Array(2_048).fill(index),
      }), {});
    }
    const incident = event(session.id, { lastSeenAt: "2026-01-01T12:00:30.000Z" });
    await store.recordEvent(incident);
    await store.closeActive();
    const result = await store.exportIncident(incident, { immutableExportId: "multipart-job" });
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error("Expected multipart output");
    expect(result.length).toBeGreaterThan(1);
    let exportedRawBytes = 0;
    const extractedPartRoots: string[] = [];
    for (const [index, partPath] of result.entries()) {
      expect(path.basename(partPath)).toContain(`part-${String(index + 1).padStart(3, "0")}.zip`);
      expect((await stat(partPath)).size).toBeLessThanOrEqual(32_768);
      const entries = storedZipEntries(await readFile(partPath));
      expect([...entries.keys()].some((name) => name.endsWith("multipart.json"))).toBe(true);
      const packageRoot = `${session.id}-${incident.id}`;
      const extractedRoot = path.join(root, `verify-part-${index + 1}`);
      extractedPartRoots.push(extractedRoot);
      for (const [name, entry] of entries) {
        if (!name.startsWith(`${packageRoot}/`) || name.endsWith("/")) continue;
        const relativePath = name.slice(packageRoot.length + 1);
        const destination = path.join(extractedRoot, ...relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, entry.contents);
      }
      exportedRawBytes += [...entries.entries()]
        .filter(([name]) => name.includes("/spectrum/raw/") && name.endsWith(".bin"))
        .reduce((total, [, entry]) => total + entry.contents.byteLength, 0);
    }
    expect(exportedRawBytes).toBe(20 * 2_048);
    expect(await verifyMultipartEvidenceDirectories(extractedPartRoots)).toMatchObject({
      outcome: "PASS",
      partsVerified: result.length,
      totalParts: result.length,
      reconstructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await verifyMultipartEvidenceDirectories(extractedPartRoots.slice(1))).toMatchObject({
      outcome: "INCOMPLETE",
      reasons: ["multipart-parts-missing-or-duplicate"],
    });
  });

  it("restores the latest incident state from a session log and exports the full session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-session-export-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const first = event(session.id);
    await store.recordEvent(first);
    await store.recordEvent({ ...first, lifecycle: "cleared", acknowledgedAt: new Date(1_000).toISOString() });

    const restored = await store.listSessionEvents(session.id);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: first.id, lifecycle: "cleared", acknowledgedAt: expect.any(String) });

    await store.closeActive();
    const zipPath = singleExportPath(await store.exportSession(session.id));
    expect(path.basename(zipPath)).toBe(`${session.id}.zip`);
    const archive = await readFile(zipPath);
    expect(archive.subarray(0, 2).toString()).toBe("PK");
    expect([...storedZipEntries(archive).values()].every((entry) => entry.method === 0)).toBe(true);
    expect((await stat(zipPath)).size).toBeGreaterThan(200);
    expect((await readdir(path.join(root, "exports"))).every((name) => !name.includes(".partial-"))).toBe(true);
  });

  it("fails closed when a completed event index contains malformed JSON in the middle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-corrupt-events-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const first = event(session.id, { id: "event-1" });
    const second = event(session.id, { id: "event-2", observationId: "observation-2" });
    await store.recordEvent(first);
    await store.recordEvent(second);
    await store.closeActive();

    const eventPath = path.join(session.path, "events", "events.jsonl");
    const validLines = (await readFile(eventPath, "utf8")).trimEnd().split("\n");
    await writeFile(eventPath, `${validLines[0]}\n{"broken":\n${validLines[1]}\n`);

    await expect(store.listSessionEvents(session.id)).rejects.toThrow(/malformed JSON at line 2/);
  });

  it("tolerates only a final unterminated tail while a session is active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-active-tail-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordEvent(event(session.id));
    const eventPath = path.join(session.path, "events", "events.jsonl");

    await appendFile(eventPath, '{"id":"torn-event"');
    await expect(store.listSessionEvents(session.id)).resolves.toEqual([
      expect.objectContaining({ id: "event-1" }),
    ]);

    await appendFile(eventPath, "\n");
    await expect(store.listSessionEvents(session.id)).rejects.toThrow(/malformed JSON at line 2/);
  });

  it("recovers an interrupted session after quarantining its final unterminated event tail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-recover-tail-"));
    temporaryRoots.push(root);
    const interruptedStore = new EvidenceStore(root);
    const interrupted = await interruptedStore.initialize({ config: { process: "old" }, sdrconnect: {} });
    await interruptedStore.recordEvent(event(interrupted.id, { lifecycle: "active" }));
    await appendFile(path.join(interrupted.path, "events", "events.jsonl"), '{"id":"torn-event"');

    const recoveredStore = new EvidenceStore(root);
    await recoveredStore.initialize({ config: { process: "new" }, sdrconnect: {} });
    await expect(recoveredStore.listSessionEvents(interrupted.id)).resolves.toEqual([
      expect.objectContaining({ id: "event-1", lifecycle: "ended-unknown", endReason: "service-restart" }),
    ]);
    const recoveryFiles = await readdir(path.join(interrupted.path, "recovery"));
    expect(recoveryFiles).toHaveLength(1);
    expect(await readFile(path.join(interrupted.path, "recovery", recoveryFiles[0]), "utf8")).toBe('{"id":"torn-event"');
    const operations = (await readFile(path.join(interrupted.path, "operations.jsonl"), "utf8"))
      .trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(operations.at(-1)).toMatchObject({
      type: "unclean-session-recovery",
      evidenceGap: true,
      recoveredTails: [{
        source: "events/events.jsonl",
        preservedAs: `recovery/${recoveryFiles[0]}`,
        bytes: Buffer.byteLength('{"id":"torn-event"'),
      }],
    });
    expect(await readFile(path.join(interrupted.path, "events", "events.jsonl"), "utf8")).not.toContain("torn-event");
    expect(await recoveredStore.createManifest(interrupted.id)).toMatchObject({ complete: false, evidenceGap: true });
    const recoveredExport = storedZipEntries(await readFile(singleExportPath(await recoveredStore.exportSession(interrupted.id))));
    const recoveredManifest = JSON.parse(recoveredExport.get(`${interrupted.id}/manifest.json`)?.contents.toString("utf8") ?? "{}");
    expect(recoveredManifest).toMatchObject({ complete: false, evidenceGap: true });
    const recoveredIncident = (await recoveredStore.listSessionEvents(interrupted.id))[0];
    const incidentExport = storedZipEntries(await readFile(singleExportPath(await recoveredStore.exportIncident(recoveredIncident))));
    const incidentManifest = JSON.parse(incidentExport.get(`${interrupted.id}-${recoveredIncident.id}/manifest.json`)?.contents.toString("utf8") ?? "{}");
    expect(incidentManifest).toMatchObject({
      complete: false,
      evidenceGap: true,
      missingParts: expect.arrayContaining([`${interrupted.id}:recovery-gap`]),
    });
  });

  it("treats a valid-looking first record without a newline as an uncommitted tail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-recover-first-tail-"));
    temporaryRoots.push(root);
    const interruptedStore = new EvidenceStore(root);
    const interrupted = await interruptedStore.initialize({ config: { process: "old" }, sdrconnect: {} });
    const uncertainBytes = JSON.stringify(event(interrupted.id, { lifecycle: "active" }));
    const eventPath = path.join(interrupted.path, "events", "events.jsonl");
    await writeFile(eventPath, uncertainBytes);

    await expect(interruptedStore.listSessionEvents(interrupted.id)).resolves.toEqual([]);
    const recoveredStore = new EvidenceStore(root);
    await recoveredStore.initialize({ config: { process: "new" }, sdrconnect: {} });

    await expect(recoveredStore.listSessionEvents(interrupted.id)).resolves.toEqual([]);
    const recoveryFiles = await readdir(path.join(interrupted.path, "recovery"));
    expect(recoveryFiles).toHaveLength(1);
    expect(await readFile(path.join(interrupted.path, "recovery", recoveryFiles[0]), "utf8")).toBe(uncertainBytes);
    expect(await readFile(eventPath, "utf8")).toBe("");
    expect(await readFile(path.join(interrupted.path, "operations.jsonl"), "utf8")).toContain(recoveryFiles[0]);
  });

  it("refuses an incident export whose spectrum index contains malformed JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-corrupt-incident-index-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const incident = event(session.id);
    await store.recordFrame(frame(), {});
    await store.recordEvent(incident);
    await store.closeActive();
    const framePath = path.join(session.path, "spectrum", "frames.jsonl");
    const validLine = (await readFile(framePath, "utf8")).trimEnd();
    await writeFile(framePath, `${validLine}\n{"broken":\n${validLine}\n`);

    await expect(store.exportIncident(incident)).rejects.toThrow(/malformed JSON at line 2|failed verification/i);
    expect((await readdir(path.join(root, "exports"))).every((name) => !name.endsWith(".zip") && !name.includes(".partial-"))).toBe(true);
  });

  it.each(["targetId", "visitId", "configurationEpoch", "confirmedCenterHz", "analysisEndBin"])(
    "refuses schema-v2 evidence with missing %s provenance",
    async (field) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-invalid-frame-contract-"));
      temporaryRoots.push(root);
      const store = new EvidenceStore(root);
      const session = await store.initialize({ config: {}, sdrconnect: {} });
      await store.recordFrame(frame(), {});
      await store.closeActive();
      const indexPath = path.join(session.path, "spectrum", "frames.jsonl");
      const indexed = JSON.parse((await readFile(indexPath, "utf8")).trim()) as { frame: Record<string, unknown> };
      delete indexed.frame[field];
      await writeFile(indexPath, `${JSON.stringify(indexed)}\n`);
      await expect(store.exportSession(session.id)).rejects.toThrow(/provenance|counters|confirmed RF state|analysis mask|failed verification/i);
    },
  );

  it("quarantines unindexed raw bytes and recomputes interrupted-session counters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-recover-raw-tail-"));
    temporaryRoots.push(root);
    const interruptedStore = new EvidenceStore(root);
    const interrupted = await interruptedStore.initialize({ config: {}, sdrconnect: {} });
    await interruptedStore.recordFrame(frame(), {});
    const indexed = JSON.parse((await readFile(path.join(interrupted.path, "spectrum", "frames.jsonl"), "utf8")).trim());
    const rawPath = path.join(interrupted.path, ...String(indexed.rawFile).split("/"));
    await appendFile(rawPath, Buffer.from([91, 92, 93]));

    const recoveredStore = new EvidenceStore(root);
    await recoveredStore.initialize({ config: {}, sdrconnect: {} });
    expect((await stat(rawPath)).size).toBe(4);
    const recoveryFiles = await readdir(path.join(interrupted.path, "recovery"));
    const rawTail = recoveryFiles.find((name) => name.endsWith("unindexed-tail.bin"));
    expect(rawTail).toBeTruthy();
    expect(await readFile(path.join(interrupted.path, "recovery", rawTail!))).toEqual(Buffer.from([91, 92, 93]));
    expect(JSON.parse(await readFile(path.join(interrupted.path, "session.json"), "utf8"))).toMatchObject({
      status: "closed",
      frameCount: 1,
      eventCount: 0,
      evidenceGap: true,
      incompleteReasons: expect.arrayContaining(["quarantined-unindexed-raw-tail"]),
    });
  });

  it.each([
    ["missing", async (rawPath: string) => rm(rawPath)],
    ["truncated", async (rawPath: string) => writeFile(rawPath, Uint8Array.of(10, 20))],
  ])("refuses a session export when referenced raw evidence is %s", async (_condition, damageRaw) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-corrupt-session-raw-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame(), {});
    const frameIndex = JSON.parse((await readFile(path.join(session.path, "spectrum", "frames.jsonl"), "utf8")).trim());
    await store.closeActive();
    await damageRaw(path.join(session.path, ...String(frameIndex.rawFile).split("/")));

    await expect(store.exportSession(session.id)).rejects.toThrow(/missing raw evidence|points beyond|failed verification/i);
    expect((await readdir(path.join(root, "exports"))).every((name) => !name.endsWith(".zip") && !name.includes(".partial-"))).toBe(true);
  });

  it("fails explicitly when the configured storage path is not a directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-storage-failure-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "not-a-directory");
    await writeFile(filePath, "occupied");
    const store = new EvidenceStore(path.join(filePath, "evidence"));
    await expect(store.initialize({ config: {}, sdrconnect: {} })).rejects.toThrow();
  });

  it("closes and rotates sessions with a final manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-rotate-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const first = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame(), { meanLevel: 25 });
    expect(store.shouldRotate(1, 86_400_000)).toBe(true);
    const closed = await store.closeActive();
    expect(closed.status).toBe("closed");
    expect(await readFile(path.join(first.path, "manifest.json"), "utf8")).toContain(first.id);

    const second = await store.initialize({ config: {}, sdrconnect: {} });
    expect(second.id).not.toBe(first.id);
    expect(store.currentSession?.status).toBe("recording");
  });

  it("closes an interrupted session with an explicit unknown restart gap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-recovery-"));
    temporaryRoots.push(root);
    const interruptedStore = new EvidenceStore(root);
    const interrupted = await interruptedStore.initialize({ config: { process: "old" }, sdrconnect: {} });
    await interruptedStore.recordEvent(event(interrupted.id, { lifecycle: "active" }));

    // A second store represents the next process after an unclean stop. There
    // are no retained descriptors or open file handles in EvidenceStore itself.
    const recoveredStore = new EvidenceStore(root);
    const replacement = await recoveredStore.initialize(
      { config: { process: "new" }, sdrconnect: {} },
      { cause: "application-recovery", at: "2026-08-26T08:18:14.000Z" },
    );
    expect(replacement.id).not.toBe(interrupted.id);
    const recoveredEvents = await recoveredStore.listSessionEvents(interrupted.id);
    expect(recoveredEvents[0]).toMatchObject({
      id: "event-1",
      lifecycle: "ended-unknown",
      endReason: "service-restart",
      endedAt: expect.any(String),
    });
    const operations = await readFile(path.join(interrupted.path, "operations.jsonl"), "utf8");
    expect(operations).toContain('"evidenceGap":true');
    expect(operations).toContain('"interruptionCause":"application-recovery"');
    expect(JSON.parse(await readFile(path.join(interrupted.path, "session.json"), "utf8"))).toMatchObject({
      status: "closed",
      lifecycle: "Incomplete",
      incompleteReasons: expect.arrayContaining(["interruption:application-recovery"]),
    });
    await recoveredStore.closeActive();
  });

  it("rejects work beyond the bounded 64-item priority writer queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-writer-bound-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    await store.initialize({ config: {}, sdrconnect: {} });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writer = store as unknown as {
      enqueue<T>(operation: () => Promise<T>, estimatedBytes: number, priority: "high" | "normal" | "low"): Promise<T>;
    };
    const writes = [
      writer.enqueue(() => blocked, 1, "low"),
      ...Array.from({ length: 79 }, () => writer.enqueue(async () => undefined, 1, "normal")),
    ];
    release();
    const results = await Promise.allSettled(writes);
    expect(results.some((result) => result.status === "rejected" && /64-item\/2 MiB/.test(String(result.reason)))).toBe(true);
    expect(store.getWriterHealth()).toEqual({ queueItems: 0, queueBytes: 0, oldestAgeMs: 0 });
  });

  it("flushes every accepted priority writer job before resolving", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-writer-flush-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    await store.initialize({ config: {}, sdrconnect: {} });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const writer = store as unknown as {
      enqueue<T>(operation: () => Promise<T>, estimatedBytes: number, priority: "high" | "normal" | "low"): Promise<T>;
    };
    const first = writer.enqueue(async () => {
      order.push("active-start");
      await blocked;
      order.push("active-end");
    }, 1, "low");
    const normal = writer.enqueue(async () => { order.push("normal"); }, 1, "normal");
    const high = writer.enqueue(async () => { order.push("high"); }, 1, "high");
    const flushed = store.flush().then(() => { order.push("flushed"); });

    await Promise.resolve();
    expect(order).toEqual(["active-start"]);
    release();
    await Promise.all([first, normal, high, flushed]);
    expect(order).toEqual(["active-start", "active-end", "high", "normal", "flushed"]);
    await store.closeActive();
  });

  it("coalesces routine session descriptors for five seconds and forces the final close checkpoint", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-session-checkpoint-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    const initial = JSON.parse(await readFile(path.join(session.path, "session.json"), "utf8"));

    now.mockReturnValue(2_000);
    await store.recordMetadata(0, { property: "device_sample_rate", value: 10_000_000 });
    await store.recordOperationalAction({ type: "target-visit-completed" });
    const beforeInterval = JSON.parse(await readFile(path.join(session.path, "session.json"), "utf8"));
    expect(store.currentSession!.byteCount).toBeGreaterThan(initial.byteCount);
    expect(beforeInterval.byteCount).toBe(initial.byteCount);

    now.mockReturnValue(6_001);
    await store.recordMetadata(0, { property: "active_antenna", value: "Antenna A" });
    const checkpointed = JSON.parse(await readFile(path.join(session.path, "session.json"), "utf8"));
    expect(checkpointed.byteCount).toBe(store.currentSession!.byteCount);

    now.mockReturnValue(6_100);
    await store.recordMetadata(0, { property: "lna_state", value: "4" });
    const closed = await store.closeActive();
    const finalDescriptor = JSON.parse(await readFile(path.join(session.path, "session.json"), "utf8"));
    expect(finalDescriptor).toMatchObject({ status: "closed", byteCount: closed.byteCount });
  });

  it("deletes expired closed sessions but preserves the active session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-retention-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const old = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame(), { meanLevel: 25 });
    await store.closeActive();
    const oldSession = JSON.parse(await readFile(path.join(old.path, "session.json"), "utf8"));
    oldSession.startedAt = "2020-01-01T00:00:00.000Z";
    oldSession.endedAt = "2020-01-01T01:00:00.000Z";
    await writeFile(path.join(old.path, "session.json"), JSON.stringify(oldSession));
    const active = await store.initialize({ config: {}, sdrconnect: {} });

    const report = await store.maintain({
      sessionMaxBytes: 1_000_000,
      sessionMaxMs: 86_400_000,
      retentionMs: 86_400_000,
      storageMaxBytes: 1_000_000_000,
      minimumFreeBytes: 0,
      maintenanceIntervalMs: 60_000,
    }, Date.parse("2026-01-01T00:00:00.000Z"));

    expect(report.deletedSessionIds).toContain(old.id);
    expect(report.deletedSessionIds).not.toContain(active.id);
    await expect(stat(old.path)).rejects.toThrow();
    expect((await stat(active.path)).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, "maintenance.jsonl"), "utf8")).toContain(old.id);
  });

  it("deletes duplicate ZIP exports before source sessions under a size limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-pressure-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const source = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame(), { meanLevel: 25 });
    await store.closeActive();
    const zipPath = singleExportPath(await store.exportIncident(event(source.id)));
    const sourceState = JSON.parse(await readFile(path.join(source.path, "session.json"), "utf8"));
    await store.initialize({ config: {}, sdrconnect: {} });

    const report = await store.maintain({
      sessionMaxBytes: 10_000_000,
      sessionMaxMs: 86_400_000,
      retentionMs: 365 * 86_400_000,
      storageMaxBytes: sourceState.byteCount + 100,
      minimumFreeBytes: 0,
      maintenanceIntervalMs: 60_000,
    });

    expect(report.deletedExports).toBe(1);
    expect(report.deletedSessions).toBe(0);
    await expect(stat(zipPath)).rejects.toThrow();
    expect((await stat(source.path)).isDirectory()).toBe(true);
  });

  it("does not let retention delete a ready export artifact while it is leased", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-export-lease-"));
    temporaryRoots.push(root);
    const store = new EvidenceStore(root);
    const source = await store.initialize({ config: {}, sdrconnect: {} });
    await store.recordFrame(frame(), {});
    await store.closeActive();
    const zipPath = singleExportPath(await store.exportIncident(event(source.id)));
    await store.initialize({ config: {}, sdrconnect: {} });
    const policy = {
      sessionMaxBytes: 10_000_000,
      sessionMaxMs: 86_400_000,
      retentionMs: 365 * 86_400_000,
      storageMaxBytes: 1,
      minimumFreeBytes: 0,
      maintenanceIntervalMs: 60_000,
    };

    store.protectExportArtifacts([zipPath], true);
    const protectedReport = await store.maintain(policy, Date.now(), new Set([source.id]));
    expect(protectedReport.pressure).toBe(true);
    expect((await stat(zipPath)).isFile()).toBe(true);
    store.protectExportArtifacts([zipPath], false);
    const releasedReport = await store.maintain(policy, Date.now(), new Set([source.id]));
    expect(releasedReport.deletedExportFiles).toContain(path.basename(zipPath));
    await expect(stat(zipPath)).rejects.toThrow();
  }, 60_000);
});
