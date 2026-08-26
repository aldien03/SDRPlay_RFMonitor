import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { HealthSnapshotV2 } from "../src/shared/types";
import type { OperatorSummaryV1 } from "../src/shared/operatorSummary";
import { LIVE_HEARTBEAT_INTERVAL_MS } from "../src/shared/liveProtocol";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const processes: ChildProcess[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function unusedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

function nextJsonMessage<T>(socket: WebSocket, predicate: (value: unknown) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a live control message"));
    }, 5_000);
    const onMessage = (data: Buffer, binary: boolean) => {
      if (binary) return;
      const value = JSON.parse(data.toString()) as unknown;
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(value as T);
    };
    socket.on("message", onMessage);
  });
}

describe("health API v2", () => {
  it("is bounded, simulation-safe, redacted, and backward compatible", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-health-api-"));
    temporaryRoots.push(root);
    const port = await unusedPort();
    const child = spawn(path.join(repositoryRoot, "node_modules/.bin/tsx"), [path.join(repositoryRoot, "src/server/index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        RF_MONITOR_SIMULATION: "on",
        RF_MONITOR_PORT: String(port),
        RF_MONITOR_STORAGE: path.join(root, "evidence"),
        RF_MONITOR_CATALOG_FILE: path.join(repositoryRoot, "config/band-catalog.example.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let errorOutput = "";
    child.stderr?.on("data", (chunk) => { errorOutput += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Health server did not start: ${errorOutput}`)), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Health server exited with ${code}: ${errorOutput}`));
      });
      child.stdout?.on("data", (chunk) => {
        if (!chunk.toString().includes("RF Monitor service listening")) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const text = await response.text();
    const health = JSON.parse(text) as HealthSnapshotV2 & { ok: boolean; operatorSummary: OperatorSummaryV1; receivers: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
    expect(health).toMatchObject({
      schemaVersion: 2,
      identity: {
        release: {
          product: "rf-monitor",
          integrity: "runtime-derived",
          sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          dependencyLockDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        configuration: { expectedSampleRateHz: 10_000_000 },
      },
      currentHealth: { state: "simulation", ready: false },
      productionQualification: { state: "simulation", ready: false },
      productionReady: false,
      summary: { state: "simulation", issues: [] },
      receiverPath: { availability: { state: "not-tested" }, receivers: [{ usb: "not-tested", transport: "not-tested", frames: "not-tested" }] },
      network: { managedSwitch: { availability: { state: "not-applicable", reasonCode: "external-not-connected" } } },
      evidence: {
        archive: {
          state: "normal",
          finalizer: { queueItems: 0, queueLimit: 8 },
        },
      },
      ok: false,
      operatorSummary: {
        dataMode: "simulation",
        currentHealth: { state: "simulation" },
        productionQualification: { state: "simulation", ready: false },
      },
    });
    expect(response.headers.get("x-rf-monitor-build-id")).toBe(health.identity.release.buildId);
    expect(health.receivers[0]).toMatchObject({ simulation: true, hardwareState: "unknown", transportState: "offline", streamState: "stopped", streamReady: false });
    expect(text).not.toMatch(/"url"\s*:|deviceSerial|ws:\/\/|simulation:\/\/|127\.0\.0\.1:5454/);

    const download = await fetch(`http://127.0.0.1:${port}/api/health/diagnostics.json`);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="rf-monitor-diagnostics.json"');
    expect(Buffer.byteLength(await download.arrayBuffer())).toBeLessThan(64 * 1024);

    const bootstrap = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((result) => result.json()) as { identity?: HealthSnapshotV2["identity"]; operatorSummary: OperatorSummaryV1 };
    expect(bootstrap.identity).toEqual(health.identity);
    expect(bootstrap.operatorSummary.productionQualification).toEqual(health.operatorSummary.productionQualification);

    const origin = `http://127.0.0.1:${port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { Origin: origin } });
    const liveBootstrap = await nextJsonMessage<{ type: string; controlSequence: number; payload: { operatorSummary: OperatorSummaryV1 } }>(
      socket,
      (value) => (value as { type?: string }).type === "snapshot",
    );
    expect(Number.isSafeInteger(liveBootstrap.controlSequence)).toBe(true);
    expect(liveBootstrap.controlSequence).toBeGreaterThan(0);
    expect(liveBootstrap.payload.operatorSummary.productionQualification).toEqual(health.operatorSummary.productionQualification);

    const deltaPromise = nextJsonMessage<{ type: string; controlSequence: number; payload: { operatorSummary: OperatorSummaryV1 } }>(
      socket,
      (value) => {
        const message = value as { type?: string; payload?: { operatorSummary?: OperatorSummaryV1 } };
        return message.type === "state-delta" && message.payload?.operatorSummary?.monitoring.state === "paused";
      },
    );
    const paused = await fetch(`${origin}/api/monitor/pause`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(paused.status).toBe(200);
    const delta = await deltaPromise;
    expect(delta.payload.operatorSummary).toMatchObject({
      monitoring: { state: "paused" },
      currentHealth: { state: "simulation" },
      productionQualification: { state: "simulation", ready: false },
    });
    expect(delta.controlSequence).toBeGreaterThan(liveBootstrap.controlSequence);

    const periodicStartedAt = Date.now();
    const periodic = await nextJsonMessage<{ type: string; controlSequence: number; payload: { generatedAt: string; operatorSummary: OperatorSummaryV1 } }>(
      socket,
      (value) => (value as { type?: string }).type === "state-delta",
    );
    expect(Date.now() - periodicStartedAt).toBeLessThanOrEqual(LIVE_HEARTBEAT_INTERVAL_MS + 1_000);
    expect(periodic.payload.operatorSummary.monitoring.state).toBe("paused");
    expect(periodic.controlSequence).toBeGreaterThan(delta.controlSequence);
    expect(Date.parse(periodic.payload.generatedAt)).toBeGreaterThanOrEqual(Date.parse(delta.payload.operatorSummary.generatedAt));

    const additionalSockets: WebSocket[] = [];
    for (let index = 0; index < 7; index += 1) {
      const additional = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { Origin: origin } });
      additionalSockets.push(additional);
      await nextJsonMessage(additional, (value) => (value as { type?: string }).type === "snapshot");
    }
    const eightClientHealth = await fetch(`${origin}/api/health`).then((result) => result.json()) as HealthSnapshotV2;
    expect(eightClientHealth.network.dashboards).toBe(8);
    expect(eightClientHealth.network.queuedBytes).toBeLessThanOrEqual(8 * 256 * 1024);

    const ninth = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { Origin: origin } });
    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Ninth dashboard was not rejected")), 5_000);
      ninth.once("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status);
      });
      ninth.once("open", () => {
        clearTimeout(timeout);
        reject(new Error("Ninth dashboard was admitted"));
      });
    });
    expect(rejectedStatus).toBe(503);
    socket.close();
    for (const additional of additionalSockets) additional.close();
  });
});
