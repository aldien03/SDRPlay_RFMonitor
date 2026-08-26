import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceSession, PersistedSpectrumFrame } from "../src/shared/types";
import { EvidencePlaybackReader } from "../src/server/evidencePlayback";
import { EvidenceStore } from "../src/server/evidenceStore";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function frame(sequence: number): PersistedSpectrumFrame {
  const timestamp = new Date(Date.UTC(2026, 7, 24, 10, 0, sequence)).toISOString();
  return {
    id: `frame-${sequence}`,
    timestamp,
    receiver: 0,
    bandId: "gps-l1",
    targetId: "gnss-l1-e1-b1c-sbas",
    scanWindowId: "window-l1",
    startHz: 1_570_420_000,
    endHz: 1_580_420_000,
    bins: Uint8Array.from([sequence, sequence + 1, sequence + 2, sequence + 3]),
    inputBinCount: 4,
    binning: "native",
    source: "sdrconnect",
    dataDomain: "field",
    calibrated: false,
    configurationEpoch: 1,
    tuneEpoch: 1,
    visitEpoch: sequence + 1,
    visitId: `visit-${sequence}`,
    receivedMonotonicMs: sequence * 1_000,
    requestedCenterHz: 1_575_420_000,
    confirmedCenterHz: 1_575_420_000,
    confirmedSampleRateHz: 10_000_000,
    analysisStartBin: 0,
    analysisEndBin: 4,
    analysisSpanHz: 8_000_000,
    captureSpanHz: 10_000_000,
    tuneConfirmedAt: timestamp,
  };
}

async function completeFixture(frameCount = 5): Promise<{ root: string; session: EvidenceSession }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-replay-"));
  temporaryRoots.push(root);
  const store = new EvidenceStore(root, { dataDomain: "field" });
  const session = await store.initialize({ config: { fixture: true }, sdrconnect: { fixture: true } });
  for (let sequence = 0; sequence < frameCount; sequence += 1) {
    await store.recordFrame(frame(sequence), {
      timestamp: frame(sequence).timestamp,
      bandId: "gps-l1",
      meanLevel: sequence + 1.5,
      peakLevel: sequence + 3,
      baselineLevel: 1,
      baselineDelta: sequence + 0.5,
      occupiedRatio: 0.25,
      overload: false,
    });
  }
  await store.closeActive();
  return {
    root,
    session: {
      ...(JSON.parse(await readFile(path.join(session.path, "session.json"), "utf8")) as EvidenceSession),
      path: session.path,
    },
  };
}

async function rewriteSession(session: EvidenceSession, changes: Partial<EvidenceSession>): Promise<void> {
  const descriptorPath = path.join(session.path, "session.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as EvidenceSession;
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, ...changes }, null, 2));
}

describe("read-only evidence playback", () => {
  it("decodes bounded frame batches and resumes with an opaque cursor", async () => {
    const fixture = await completeFixture();
    const before = await readFile(path.join(fixture.session.path, "session.json"));
    const reader = new EvidencePlaybackReader(fixture.root, "field");

    const first = await reader.readBatch(fixture.session.id, undefined, 2);
    expect(first).toMatchObject({ lifecycle: "Complete", done: false, evidenceGap: false });
    expect(first.frames.map((entry) => entry.frame.id)).toEqual(["frame-0", "frame-1"]);
    expect(first.frames[0].frame.bins).toEqual([0, 1, 2, 3]);
    expect(first.frames[1].metrics).toMatchObject({ peakLevel: 4, overload: false });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await reader.readBatch(fixture.session.id, first.nextCursor, 2);
    expect(second.frames.map((entry) => entry.frame.id)).toEqual(["frame-2", "frame-3"]);
    expect(second.done).toBe(false);

    const final = await reader.readBatch(fixture.session.id, second.nextCursor, 2);
    expect(final.frames.map((entry) => entry.frame.id)).toEqual(["frame-4"]);
    expect(final.done).toBe(true);
    expect(final.nextCursor).toBeUndefined();
    expect(await readFile(path.join(fixture.session.path, "session.json"))).toEqual(before);
  });

  it("caps oversized batch requests at the server frame bound", async () => {
    const fixture = await completeFixture(20);
    const batch = await new EvidencePlaybackReader(fixture.root, "field").readBatch(fixture.session.id, undefined, 10_000);
    expect(batch.frames).toHaveLength(16);
    expect(batch.done).toBe(false);
    expect(batch.nextCursor).toBeTruthy();
  });

  it("rejects Active, Corrupt, and unlabelled Incomplete sessions", async () => {
    const fixture = await completeFixture(1);
    const reader = new EvidencePlaybackReader(fixture.root, "field");

    await rewriteSession(fixture.session, { lifecycle: "Active", status: "recording" });
    await expect(reader.readBatch(fixture.session.id)).rejects.toMatchObject({ code: "EVIDENCE_REPLAY_NOT_ELIGIBLE" });

    await rewriteSession(fixture.session, { lifecycle: "Corrupt", status: "storage-error" });
    await expect(reader.readBatch(fixture.session.id)).rejects.toMatchObject({ code: "EVIDENCE_REPLAY_NOT_ELIGIBLE" });

    await rewriteSession(fixture.session, { lifecycle: "Incomplete", status: "closed", evidenceGap: false, incompleteReasons: [] });
    await expect(reader.readBatch(fixture.session.id)).rejects.toMatchObject({ code: "EVIDENCE_REPLAY_INCOMPLETE_UNLABELLED" });
  });

  it("allows an explicitly gap-labelled Incomplete session without claiming completeness", async () => {
    const fixture = await completeFixture(2);
    await rewriteSession(fixture.session, {
      lifecycle: "Incomplete",
      status: "closed",
      evidenceGap: true,
      incompleteReasons: ["recovered-frame-gap"],
    });
    await Promise.all([
      unlink(path.join(fixture.session.path, "finalization.json")),
      unlink(path.join(fixture.session.path, "manifest.json")),
      unlink(path.join(fixture.session.path, "SHA256SUMS.txt")),
    ]);

    const batch = await new EvidencePlaybackReader(fixture.root, "field").readBatch(fixture.session.id);
    expect(batch).toMatchObject({
      lifecycle: "Incomplete",
      evidenceGap: true,
      incompleteReasons: ["recovered-frame-gap"],
      done: true,
    });
    expect(batch.frames).toHaveLength(2);
  });

  it("rejects malformed cursors and raw ranges outside their binary chunk", async () => {
    const fixture = await completeFixture(1);
    const reader = new EvidencePlaybackReader(fixture.root, "field");
    await expect(reader.readBatch(fixture.session.id, "not-a-cursor")).rejects.toMatchObject({ code: "EVIDENCE_REPLAY_CURSOR_INVALID" });

    const indexPath = path.join(fixture.session.path, "spectrum", "frames.jsonl");
    const record = JSON.parse((await readFile(indexPath, "utf8")).trim()) as Record<string, unknown>;
    record.rawOffset = 2;
    record.rawLength = 4;
    await writeFile(indexPath, `${JSON.stringify(record)}\n`);
    await expect(reader.readBatch(fixture.session.id)).rejects.toMatchObject({ code: "EVIDENCE_REPLAY_SOURCE_INVALID" });
  });

  it("rejects same-size raw tampering even after the committed file was cached", async () => {
    const fixture = await completeFixture(2);
    const reader = new EvidencePlaybackReader(fixture.root, "field");
    await expect(reader.readBatch(fixture.session.id, undefined, 1)).resolves.toMatchObject({
      frames: [{ frame: { id: "frame-0" } }],
    });

    const indexRecord = JSON.parse(
      (await readFile(path.join(fixture.session.path, "spectrum", "frames.jsonl"), "utf8")).split("\n")[0],
    ) as { rawFile: string };
    const rawPath = path.join(fixture.session.path, ...indexRecord.rawFile.split("/"));
    const tampered = await readFile(rawPath);
    tampered[0] ^= 0xff;
    await writeFile(rawPath, tampered);

    await expect(reader.readBatch(fixture.session.id, undefined, 1)).rejects.toMatchObject({
      code: "EVIDENCE_REPLAY_SOURCE_INVALID",
    });
  });

  it("rejects symbolic links for every finalization metadata file before replay inspection", async () => {
    const fixture = await completeFixture(1);
    const reader = new EvidencePlaybackReader(fixture.root, "field");

    for (const metadataName of ["finalization.json", "manifest.json", "SHA256SUMS.txt", "session-final.json"]) {
      const metadataPath = path.join(fixture.session.path, metadataName);
      const original = await readFile(metadataPath);
      const copyName = `${metadataName}.test-copy`;
      await writeFile(path.join(fixture.session.path, copyName), original);
      await unlink(metadataPath);
      await symlink(copyName, metadataPath);

      await expect(reader.readBatch(fixture.session.id)).rejects.toMatchObject({
        code: "EVIDENCE_REPLAY_SOURCE_INVALID",
      });

      await unlink(metadataPath);
      await writeFile(metadataPath, original);
      await unlink(path.join(fixture.session.path, copyName));
    }
  });
});
