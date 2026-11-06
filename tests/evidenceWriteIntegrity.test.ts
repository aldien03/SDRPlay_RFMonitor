import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceStore } from "../src/server/evidenceStore";
import type { PersistedSpectrumFrame } from "../src/shared/types";

/** Fault injection: write HALF of the next matching append, then fail like a full disk. */
const fault = vi.hoisted(() => ({ target: "" as "" | ".bin" | "frames.jsonl" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (file: Parameters<typeof actual.appendFile>[0], data: Parameters<typeof actual.appendFile>[1], ...rest: unknown[]) => {
      if (fault.target && String(file).endsWith(fault.target)) {
        fault.target = "";
        const bytes = Buffer.from(data as Uint8Array | string);
        await actual.appendFile(file, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.appendFile(file, data, ...(rest as []));
    },
  };
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  fault.target = "";
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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


async function openStore(): Promise<EvidenceStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-write-integrity-"));
  temporaryRoots.push(root);
  const store = new EvidenceStore(root);
  await store.initialize({ config: {}, sdrconnect: {} });
  return store;
}

function binsOf(seed: number): Uint8Array {
  return Uint8Array.of(seed, seed + 1, seed + 2, seed + 3);
}

/** Every index line must parse and point at exactly the raw bytes its frame carried. */
async function readBackFrames(store: EvidenceStore): Promise<Array<{ id: string; bins: number[] }>> {
  const sessionPath = store.currentSession!.path;
  const text = await readFile(path.join(sessionPath, "spectrum", "frames.jsonl"), "utf8");
  const lines = text.split("\n").filter(Boolean);
  const frames: Array<{ id: string; bins: number[] }> = [];
  for (const line of lines) {
    const record = JSON.parse(line) as { frame: { id: string }; rawFile: string; rawOffset: number; rawLength: number };
    const raw = await readFile(path.join(sessionPath, ...record.rawFile.split("/")));
    frames.push({ id: record.frame.id, bins: [...raw.subarray(record.rawOffset, record.rawOffset + record.rawLength)] });
  }
  return frames;
}

describe("evidence write integrity", () => {
  it("keeps later frame offsets true after a short raw write", async () => {
    const store = await openStore();
    await store.recordFrame(frame({ id: "a", bins: binsOf(1) }), {});
    fault.target = ".bin";
    await expect(store.recordFrame(frame({ id: "b", bins: binsOf(5) }), {})).rejects.toThrow(/ENOSPC/);
    await store.recordFrame(frame({ id: "c", bins: binsOf(9) }), {});
    expect(await readBackFrames(store)).toEqual([
      { id: "a", bins: [1, 2, 3, 4] },
      { id: "c", bins: [9, 10, 11, 12] },
    ]);
  });

  it("does not join the next record onto a torn index line, and preserves the torn bytes", async () => {
    const store = await openStore();
    await store.recordFrame(frame({ id: "a", bins: binsOf(1) }), {});
    fault.target = "frames.jsonl";
    await expect(store.recordFrame(frame({ id: "b", bins: binsOf(5) }), {})).rejects.toThrow(/ENOSPC/);
    await store.recordFrame(frame({ id: "c", bins: binsOf(9) }), {});
    const frames = await readBackFrames(store);
    expect(frames.map((item) => item.id)).toEqual(["a", "c"]);
    expect(frames[1].bins).toEqual([9, 10, 11, 12]);
    const recovery = await readdir(path.join(store.currentSession!.path, "recovery"));
    expect(recovery.some((name) => name.endsWith(".torn-tail.bin"))).toBe(true);
  });

  it("rolls back a failed prehistory batch so offsets stay true", async () => {
    const store = await openStore();
    await store.recordFrame(frame({ id: "a", bins: binsOf(1) }), {});
    fault.target = ".bin";
    await expect(store.recordPrehistory([
      { frame: frame({ id: "p1", bins: binsOf(20) }), summary: {} },
      { frame: frame({ id: "p2", bins: binsOf(30) }), summary: {} },
    ])).rejects.toThrow(/ENOSPC/);
    await store.recordFrame(frame({ id: "c", bins: binsOf(9) }), {});
    expect(await readBackFrames(store)).toEqual([
      { id: "a", bins: [1, 2, 3, 4] },
      { id: "c", bins: [9, 10, 11, 12] },
    ]);
  });

  it("can still close the session when the writer queue is saturated", async () => {
    const store = await openStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writer = store as unknown as {
      enqueue<T>(operation: () => Promise<T>, estimatedBytes: number, priority: "high" | "normal" | "low"): Promise<T>;
    };
    const writes = [
      writer.enqueue(() => blocked, 1, "low"),
      ...Array.from({ length: 80 }, () => writer.enqueue(async () => undefined, 1, "normal")),
    ];
    // Ordinary work is refused at the reduced ceiling, leaving room for the close job.
    await expect(writer.enqueue(async () => undefined, 1, "normal")).rejects.toThrow(/64-item\/2 MiB/);
    const closing = store.closeActive();
    release();
    await Promise.allSettled(writes);
    await expect(closing).resolves.toBeDefined();
    expect(store.currentSession).toBeUndefined();
  });
});
