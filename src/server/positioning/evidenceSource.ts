/**
 * Reads rf-monitor's own evidence sessions for a report window: finds the
 * sessions that overlap it and streams their spectrum frames, in time order,
 * into the RF accumulator. Raw bins are read only when the accumulator asks
 * for them. Only sessions of the configured data domain are used, and no path
 * outside the evidence root is ever opened.
 */
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DataDomain } from "../../shared/types";
import type { RfAccumulator, RfFrameMetrics } from "./rfAnalysis";
import type { RfFrame } from "./rfEvidence";
import type { ReportWindow } from "./types";

export interface EvidenceSessionInfo {
  id: string;
  path: string;
  startMs: number;
  endMs: number;
  lifecycle: string;
  /** Capture targets enabled for the session. */
  targets: string[];
}

const SESSION_NAME = /^session-[A-Za-z0-9._-]+$/;
const RAW_FILE = /^spectrum\/raw\/[A-Za-z0-9._-]+\.bin$/;
const TIMESTAMP_PREFIX = /^\{"timestamp":"([^"]+)"/;
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
/**
 * Frames are written in batches, so frames.jsonl is only roughly in time
 * order (observed lateness up to about a minute). A reorder buffer releases
 * frames in time order once nothing earlier can still arrive.
 */
const REORDER_HORIZON_MS = 120_000;

interface Pending {
  metrics: RfFrameMetrics;
  load: () => Promise<Uint8Array | undefined>;
}

/** Minimal binary min-heap on frame time. */
class FrameHeap {
  private readonly items: Pending[] = [];
  get size(): number {
    return this.items.length;
  }
  peekTime(): number {
    return this.items[0]?.metrics.timeMs ?? Infinity;
  }
  push(item: Pending): void {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].metrics.timeMs <= items[index].metrics.timeMs) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }
  pop(): Pending | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length && last) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && items[left].metrics.timeMs < items[smallest].metrics.timeMs) smallest = left;
        if (right < items.length && items[right].metrics.timeMs < items[smallest].metrics.timeMs) smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

async function readSmallJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.size > MAX_DESCRIPTOR_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Sessions of this data domain whose recording overlaps the window, oldest first. */
export async function listOverlappingSessions(evidenceRoot: string, window: ReportWindow, dataDomain: DataDomain, now = Date.now()): Promise<EvidenceSessionInfo[]> {
  let entries: string[];
  try {
    entries = (await readdir(evidenceRoot)).filter((name) => SESSION_NAME.test(name));
  } catch {
    return [];
  }
  const sessions: EvidenceSessionInfo[] = [];
  for (const name of entries) {
    const sessionPath = path.join(evidenceRoot, name);
    try {
      const details = await lstat(sessionPath);
      if (!details.isDirectory() || details.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const descriptor = await readSmallJson(path.join(sessionPath, "session.json"));
    if (!descriptor) continue;
    if (descriptor.dataDomain !== undefined && descriptor.dataDomain !== dataDomain) continue;
    if (descriptor.lifecycle === "Corrupt") continue;
    const startMs = Date.parse(String(descriptor.startedAt ?? ""));
    const endMs = typeof descriptor.endedAt === "string" ? Date.parse(descriptor.endedAt) : now;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs < window.startMs || startMs >= window.endMs) continue;
    const config = await readSmallJson(path.join(sessionPath, "config.json"));
    const bands = Array.isArray(config?.bands) ? (config.bands as Array<Record<string, unknown>>) : [];
    const targets = [...new Set(bands.map((band) => band.captureTargetId).filter((id): id is string => typeof id === "string"))];
    sessions.push({ id: name, path: sessionPath, startMs, endMs, lifecycle: String(descriptor.lifecycle ?? "legacy"), targets });
  }
  return sessions.sort((left, right) => left.startMs - right.startMs);
}

/** Fraction of the window covered by recording sessions, and the capture targets they monitored. */
export function sessionCoverage(sessions: EvidenceSessionInfo[], window: ReportWindow): { fraction: number; targets: string[] } {
  let covered = 0;
  let cursor = window.startMs;
  for (const session of sessions) {
    const from = Math.max(cursor, session.startMs, window.startMs);
    const to = Math.min(session.endMs, window.endMs);
    if (to > from) {
      covered += to - from;
      cursor = to;
    }
  }
  return { fraction: covered / (window.endMs - window.startMs), targets: [...new Set(sessions.flatMap((session) => session.targets))] };
}

interface FrameRecord {
  timestamp: string;
  bandId: string;
  meanLevel?: number;
  peakLevel?: number;
  baselineLevel?: number;
  medianRobustZ?: number;
  peakRobustZ?: number;
  occupiedRatio?: number;
  maximumOccupiedWidthRatio?: number;
  vendorReportedSignalPower?: number;
  snrDb?: number;
  overload?: boolean;
  rawFile?: string;
  rawOffset?: number;
  rawLength?: number;
  frame?: { targetId?: string; startHz?: number; endHz?: number; analysisStartBin?: number; analysisEndBin?: number; inputBinCount?: number };
}

const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function frameMetrics(record: FrameRecord, timeMs: number): RfFrameMetrics | undefined {
  const target = record.frame?.targetId;
  if (!target) return undefined;
  const inputBins = num(record.frame?.inputBinCount, 512);
  return {
    timeMs,
    targetId: target,
    bandId: record.bandId,
    meanLevel: num(record.meanLevel),
    peakLevel: num(record.peakLevel),
    baselineLevel: num(record.baselineLevel),
    medianZ: num(record.medianRobustZ),
    peakZ: num(record.peakRobustZ),
    occupied: num(record.occupiedRatio),
    maxWidth: num(record.maximumOccupiedWidthRatio),
    powerDbm: typeof record.vendorReportedSignalPower === "number" ? record.vendorReportedSignalPower : undefined,
    snrDb: typeof record.snrDb === "number" ? record.snrDb : undefined,
    overload: Boolean(record.overload),
    startHz: num(record.frame?.startHz),
    endHz: num(record.frame?.endHz),
    analysisStartBin: num(record.frame?.analysisStartBin, Math.round(inputBins * 0.1)),
    analysisEndBin: num(record.frame?.analysisEndBin, Math.round(inputBins * 0.9)),
  };
}

export interface StreamOptions {
  /** Mock-up only: shift or alter frames before analysis. */
  transform?: (frame: RfFrame) => RfFrame;
  /** Time offset applied before the window test (mock-up time shift). */
  offsetMs?: number;
  isCancelled?: () => boolean;
  onProgress?: (bytesRead: number) => void;
}

/** Stream one session's frames inside the window into the accumulator. */
export async function streamSessionFrames(sessionPath: string, window: ReportWindow, accumulator: RfAccumulator, options: StreamOptions = {}): Promise<number> {
  const framesFile = path.join(sessionPath, "spectrum", "frames.jsonl");
  try {
    const details = await lstat(framesFile);
    if (!details.isFile()) return 0;
  } catch {
    return 0;
  }
  const handles = new Map<string, FileHandle>();
  const offset = options.offsetMs ?? 0;
  const heap = new FrameHeap();
  let newest = -Infinity;
  let count = 0;
  let bytes = 0;
  const release = async (upTo: number) => {
    while (heap.size && heap.peekTime() <= upTo) {
      const next = heap.pop()!;
      await accumulator.add(next.metrics, next.load);
      count += 1;
    }
  };
  const stream = createReadStream(framesFile, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      bytes += line.length + 1;
      if (count % 2000 === 0) {
        options.onProgress?.(bytes);
        if (options.isCancelled?.()) break;
      }
      // Cheap time test before parsing the whole line.
      const prefix = TIMESTAMP_PREFIX.exec(line);
      const rawTime = prefix ? Date.parse(prefix[1]) : Number.NaN;
      if (Number.isFinite(rawTime)) {
        if (rawTime + offset < window.startMs) continue;
        // Late frames can still belong to the window; stop only well past its end.
        if (rawTime + offset >= window.endMs + REORDER_HORIZON_MS) break;
      }
      let record: FrameRecord;
      try {
        record = JSON.parse(line) as FrameRecord;
      } catch {
        continue;
      }
      const timeMs = Date.parse(record.timestamp) + offset;
      if (!Number.isFinite(timeMs) || timeMs < window.startMs || timeMs >= window.endMs) continue;
      let metrics = frameMetrics(record, timeMs);
      if (!metrics || !accumulator.wants(metrics.targetId)) continue;
      const loadRaw = async (): Promise<Uint8Array | undefined> => {
        const rawFile = record.rawFile;
        const length = num(record.rawLength);
        if (!rawFile || !RAW_FILE.test(rawFile) || length <= 0 || length > 65_536) return undefined;
        let handle = handles.get(rawFile);
        if (!handle) {
          try {
            handle = await open(path.join(sessionPath, ...rawFile.split("/")), "r");
          } catch {
            return undefined;
          }
          handles.set(rawFile, handle);
        }
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, num(record.rawOffset));
        return bytesRead === length ? buffer : undefined;
      };
      if (options.transform) {
        const bins = await loadRaw();
        const altered = options.transform({ ...metrics, bins });
        const { bins: alteredBins, ...rest } = altered;
        metrics = rest;
        heap.push({ metrics, load: async () => alteredBins });
      } else {
        heap.push({ metrics, load: loadRaw });
      }
      newest = Math.max(newest, metrics.timeMs);
      await release(newest - REORDER_HORIZON_MS);
    }
    await release(Infinity);
  } finally {
    lines.close();
    stream.destroy();
    await Promise.all([...handles.values()].map((handle) => handle.close().catch(() => undefined)));
  }
  return count;
}
