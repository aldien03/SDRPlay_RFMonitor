import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExportJobQueue,
  ExportProtectedBytesError,
  ExportQueueFullError,
  sha256FileStreamed,
} from "../src/server/exportJobQueue";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "rf-monitor-export-queue-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ExportJobQueue", () => {
  it("rejects unbounded completed-history configuration", () => {
    const builder = async () => "/unused";
    expect(() => new ExportJobQueue({ builder, completedHistoryLimit: 0 })).toThrow(RangeError);
    expect(() => new ExportJobQueue({ builder, completedHistoryLimit: 257 })).toThrow(RangeError);
    expect(() => new ExportJobQueue({ builder, downloadLeaseMs: 15 * 60_000 + 1 })).toThrow(RangeError);
  });

  it("runs one build, allows two queued jobs, and rejects a fourth submission", async () => {
    const directory = await temporaryDirectory();
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const queue = new ExportJobQueue<number>({
      builder: async (request) => {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await releases[request - 1].promise;
        const outputPath = path.join(directory, `${request}.zip`);
        await writeFile(outputPath, `export-${request}`);
        concurrent -= 1;
        return outputPath;
      },
      idFactory: (() => {
        let nextId = 0;
        return () => `job-${++nextId}`;
      })(),
    });

    const first = queue.submit(1);
    const second = queue.submit(2);
    const third = queue.submit(3);

    expect(queue.get(first.id)?.state).toBe("running");
    expect(queue.get(second.id)?.state).toBe("queued");
    expect(queue.get(third.id)?.state).toBe("queued");
    expect(() => queue.submit(4)).toThrow(ExportQueueFullError);

    releases[0].resolve();
    await waitForState(queue, second.id, "running");
    releases[1].resolve();
    await waitForState(queue, third.id, "running");
    releases[2].resolve();
    await queue.waitForIdle();

    expect(maximumConcurrent).toBe(1);
    expect(queue.list().map((job) => job.state)).toEqual(["ready", "ready", "ready"]);
  });

  it("streams the final file into SHA-256 metadata", async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, "large-export.zip");
    const contents = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    await writeFile(outputPath, contents);

    const directDigest = await sha256FileStreamed(outputPath);
    expect(directDigest).toEqual({
      sha256: createHash("sha256").update(contents).digest("hex"),
      sizeBytes: contents.byteLength,
    });

    const queue = new ExportJobQueue<void>({ builder: async () => outputPath });
    const submitted = queue.submit();
    await queue.waitForIdle();

    expect(queue.get(submitted.id)).toMatchObject({
      state: "ready",
      sha256: directDigest.sha256,
      sizeBytes: contents.byteLength,
    });
  });

  it("rechecks pressure before a queued build starts and leases ready outputs", async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, "pressure-safe.zip");
    let allowed = false;
    const protectedPaths: string[][] = [];
    const releasedPaths: string[][] = [];
    const queue = new ExportJobQueue<void>({
      builder: async () => {
        await writeFile(outputPath, "ready");
        return outputPath;
      },
      canStart: () => allowed,
      retryDelayMs: 10,
      onOutputsReady: (paths) => protectedPaths.push([...paths]),
      onOutputsReleased: (paths) => releasedPaths.push([...paths]),
      completedHistoryLimit: 1,
    });
    const first = queue.submit();
    expect(queue.get(first.id)?.state).toBe("queued");
    allowed = true;
    await waitForState(queue, first.id, "ready");
    expect(protectedPaths).toEqual([[outputPath]]);

    const secondPath = path.join(directory, "second.zip");
    await writeFile(secondPath, "second");
    const second = queue.submit();
    await waitForState(queue, second.id, "ready");
    expect(releasedPaths).toEqual([[outputPath]]);
  });

  it("publishes and leases immutable multipart artifacts independently", async () => {
    const directory = await temporaryDirectory();
    const firstPath = path.join(directory, "part-001.zip");
    const secondPath = path.join(directory, "part-002.zip");
    await writeFile(firstPath, "first-part");
    await writeFile(secondPath, "second-part");
    const queue = new ExportJobQueue<void>({ builder: async () => [firstPath, secondPath] });
    const submitted = queue.submit();
    await queue.waitForIdle();
    expect(queue.get(submitted.id)).toMatchObject({
      state: "ready",
      parts: [{ number: 1, sizeBytes: 10 }, { number: 2, sizeBytes: 11 }],
    });
    expect(queue.tryAcquireDownload(submitted.id, 3)).toEqual({ acquired: false, reason: "invalid-part" });
    const acquired = queue.tryAcquireDownload(submitted.id, 2);
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) {
      expect(acquired.lease).toMatchObject({ outputPath: secondPath, partNumber: 2, sizeBytes: 11 });
      acquired.lease.release();
    }
  });

  it("records bounded failures and continues with the next job", async () => {
    const directory = await temporaryDirectory();
    const queue = new ExportJobQueue<number>({
      completedHistoryLimit: 2,
      builder: async (request) => {
        if (request === 1) throw new Error("fixture failed");
        const outputPath = path.join(directory, `${request}.zip`);
        await writeFile(outputPath, `${request}`);
        return outputPath;
      },
      idFactory: (() => {
        let nextId = 0;
        return () => `history-${++nextId}`;
      })(),
    });

    const first = queue.submit(1);
    const second = queue.submit(2);
    const third = queue.submit(3);
    await queue.waitForIdle();

    expect(queue.get(first.id)).toBeUndefined();
    expect(queue.get(second.id)?.state).toBe("ready");
    expect(queue.get(third.id)?.state).toBe("ready");
    expect(queue.completedCount).toBe(2);
    expect(queue.list()).toHaveLength(2);
  });

  it("publishes a failed terminal state with a bounded error message", async () => {
    const queue = new ExportJobQueue<void>({
      builder: async () => {
        throw new Error("x".repeat(2_000));
      },
    });

    const submitted = queue.submit();
    await queue.waitForIdle();
    const failed = queue.get(submitted.id);

    expect(failed?.state).toBe("failed");
    expect(failed?.error).toHaveLength(1_024);
    expect(failed?.sha256).toBeUndefined();
  });

  it("exposes a single global download lease with idempotent release", async () => {
    const directory = await temporaryDirectory();
    const releaseBuild = deferred<void>();
    const queue = new ExportJobQueue<string>({
      builder: async (name) => {
        if (name === "pending") await releaseBuild.promise;
        const outputPath = path.join(directory, `${name}.zip`);
        await writeFile(outputPath, name);
        return outputPath;
      },
    });

    const ready = queue.submit("ready");
    const pending = queue.submit("pending");
    await waitForState(queue, ready.id, "ready");

    expect(queue.tryAcquireDownload("missing")).toEqual({ acquired: false, reason: "not-found" });
    expect(queue.tryAcquireDownload(pending.id)).toEqual({ acquired: false, reason: "not-ready" });

    const firstAcquire = queue.tryAcquireDownload(ready.id);
    expect(firstAcquire.acquired).toBe(true);
    expect(queue.downloadActive).toBe(true);
    expect(queue.tryAcquireDownload(ready.id)).toEqual({ acquired: false, reason: "busy" });

    if (!firstAcquire.acquired) throw new Error("Expected the first download lease.");
    expect(firstAcquire.lease.outputPath).toBe(path.join(directory, "ready.zip"));
    firstAcquire.lease.release();
    firstAcquire.lease.release();
    expect(queue.downloadActive).toBe(false);

    const secondAcquire = queue.tryAcquireDownload(ready.id);
    expect(secondAcquire.acquired).toBe(true);
    if (secondAcquire.acquired) secondAcquire.lease.release();

    releaseBuild.resolve();
    await queue.waitForIdle();
  });

  it("reuses the same source commit and bounds cumulative reservations and protected bytes", async () => {
    const directory = await temporaryDirectory();
    let builds = 0;
    let allowed = false;
    const released: string[][] = [];
    const queue = new ExportJobQueue<string>({
      builder: async (name) => {
        builds += 1;
        const outputPath = path.join(directory, `${name}.zip`);
        await writeFile(outputPath, "1234567890");
        return outputPath;
      },
      canStart: () => allowed,
      retryDelayMs: 10,
      maxProtectedOutputBytes: 15,
      outputLeaseMs: 20,
      onOutputsReleased: (paths) => released.push([...paths]),
    });

    const first = queue.submit("first", { deduplicationKey: "session:commit-a", estimatedOutputBytes: 10 });
    const duplicate = queue.submit("ignored", { deduplicationKey: "session:commit-a", estimatedOutputBytes: 10 });
    expect(duplicate.id).toBe(first.id);
    expect(() => queue.submit("distinct", { deduplicationKey: "session:commit-b", estimatedOutputBytes: 6 }))
      .toThrow(ExportProtectedBytesError);

    allowed = true;
    await waitForState(queue, first.id, "ready");
    expect(builds).toBe(1);
    expect(queue.protectedBytes).toBe(10);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(queue.get(first.id)).toBeUndefined();
    expect(queue.protectedBytes).toBe(0);
    expect(released).toHaveLength(1);
  });

  it("preserves every queued reservation when a completed output exceeds its estimate", async () => {
    const directory = await temporaryDirectory();
    const firstPath = path.join(directory, "underestimated.zip");
    const secondPath = path.join(directory, "reserved-evidence.zip");
    const discarded: string[][] = [];
    const queue = new ExportJobQueue<string>({
      builder: async (name) => {
        const outputPath = name === "underestimated" ? firstPath : secondPath;
        await writeFile(outputPath, name === "underestimated" ? "1234567" : "123456");
        return outputPath;
      },
      maxProtectedOutputBytes: 10,
      onOutputsDiscarded: (paths) => { discarded.push([...paths]); },
    });

    const underestimated = queue.submit("underestimated", { estimatedOutputBytes: 4 });
    const reserved = queue.submit("reserved", { estimatedOutputBytes: 6 });
    await queue.waitForIdle();

    expect(queue.get(underestimated.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("10-byte bound"),
    });
    expect(queue.get(reserved.id)).toMatchObject({ state: "ready", sizeBytes: 6 });
    expect(discarded).toEqual([[firstPath]]);
    expect(queue.protectedBytes).toBe(6);
  });

  it("defers output-lease expiry until an active multipart download releases", async () => {
    const directory = await temporaryDirectory();
    const firstPath = path.join(directory, "leased-part-001.zip");
    const secondPath = path.join(directory, "leased-part-002.zip");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "second");
    const queue = new ExportJobQueue<void>({
      builder: async () => [firstPath, secondPath],
      maxProtectedOutputBytes: 20,
      outputLeaseMs: 20,
    });
    const job = queue.submit(undefined, { estimatedOutputBytes: 11 });
    await waitForState(queue, job.id, "ready");
    const acquired = queue.tryAcquireDownload(job.id, 2);
    if (!acquired.acquired) throw new Error("Expected a multipart download lease");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(queue.get(job.id)?.state).toBe("ready");
    acquired.lease.release();
    expect(queue.get(job.id)).toBeUndefined();
    expect(queue.protectedBytes).toBe(0);
  });

  it("aborts and releases an expired download lease, then expires pending outputs", async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, "stalled.zip");
    await writeFile(outputPath, "stalled");
    const released: string[][] = [];
    const queue = new ExportJobQueue<void>({
      builder: async () => outputPath,
      outputLeaseMs: 10,
      downloadLeaseMs: 20,
      onOutputsReleased: (paths) => released.push([...paths]),
    });
    const job = queue.submit();
    await waitForState(queue, job.id, "ready");
    const acquired = queue.tryAcquireDownload(job.id);
    if (!acquired.acquired) throw new Error("Expected a download lease");

    await new Promise<void>((resolve) => {
      if (acquired.lease.signal.aborted) resolve();
      else acquired.lease.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(acquired.lease.signal.aborted).toBe(true);
    expect(queue.downloadActive).toBe(false);
    expect(queue.get(job.id)).toBeUndefined();
    expect(queue.protectedBytes).toBe(0);
    expect(released).toEqual([[outputPath]]);
    acquired.lease.release();
  });

  it("fails closed and discards an output whose actual bytes exceed the hard bound", async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, "oversized.zip");
    const discarded: string[][] = [];
    const queue = new ExportJobQueue<void>({
      builder: async () => {
        await writeFile(outputPath, "123456");
        return outputPath;
      },
      maxProtectedOutputBytes: 5,
      onOutputsDiscarded: (paths) => { discarded.push([...paths]); },
    });
    const job = queue.submit();
    await queue.waitForIdle();
    expect(queue.get(job.id)).toMatchObject({ state: "failed", error: expect.stringContaining("5-byte bound") });
    expect(discarded).toEqual([[outputPath]]);
    expect(queue.protectedBytes).toBe(0);
  });
});

async function waitForState<Request>(
  queue: ExportJobQueue<Request>,
  jobId: string,
  state: "queued" | "running" | "ready" | "failed",
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (queue.get(jobId)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not reach ${state}.`);
}
