import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/server/evidenceStore";

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

describe("evidence export API admission", { timeout: 30_000 }, () => {
  it("applies the finalized lifecycle allowlist and commit deduplication to both create routes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-export-api-"));
    temporaryRoots.push(root);
    const storage = path.join(root, "storage");
    const evidenceRoot = path.join(storage, "test", "evidence");
    const prepared = new EvidenceStore(evidenceRoot, { dataDomain: "test" });

    const complete = await prepared.initialize({ config: { fixture: "complete" }, sdrconnect: {} });
    await prepared.closeActive();
    const legacy = await prepared.initialize({ config: { fixture: "legacy" }, sdrconnect: {} });
    await prepared.closeActive();
    const legacyDescriptorPath = path.join(legacy.path, "session.json");
    const legacyDescriptor = JSON.parse(await readFile(legacyDescriptorPath, "utf8")) as Record<string, unknown>;
    delete legacyDescriptor.lifecycle;
    await writeFile(legacyDescriptorPath, JSON.stringify(legacyDescriptor, null, 2));

    const corrupt = await prepared.initialize({ config: { fixture: "corrupt" }, sdrconnect: {} });
    await prepared.closeActive();
    await writeFile(path.join(corrupt.path, "config.json"), "{}\n");

    const port = await unusedPort();
    const child = spawn(path.join(repositoryRoot, "node_modules/.bin/tsx"), [path.join(repositoryRoot, "src/server/index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        RF_MONITOR_SIMULATION: "on",
        RF_MONITOR_PORT: String(port),
        RF_MONITOR_STORAGE: storage,
        RF_MONITOR_CATALOG_FILE: path.join(repositoryRoot, "config/band-catalog.example.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let errorOutput = "";
    child.stderr?.on("data", (chunk) => { errorOutput += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Export API server did not start: ${errorOutput}`)), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Export API server exited with ${code}: ${errorOutput}`));
      });
      child.stdout?.on("data", (chunk) => {
        if (!chunk.toString().includes("RF Monitor service listening")) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    const origin = `http://127.0.0.1:${port}`;
    const postSession = (sessionId: string) => fetch(`${origin}/api/exports`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "session", sessionId }),
    });
    const compatibilitySession = (sessionId: string) => fetch(`${origin}/api/evidence/sessions/${sessionId}/export`);
    const snapshot = await fetch(`${origin}/api/snapshot`).then((response) => response.json()) as {
      sessions: Array<{ id: string; lifecycle?: string }>;
    };
    const active = snapshot.sessions.find((session) => session.lifecycle === "Active");
    if (!active) throw new Error("Server did not publish its active evidence session");

    for (const create of [postSession, compatibilitySession]) {
      const activeResponse = await create(active.id);
      expect(activeResponse.status).toBe(409);
      expect(await activeResponse.json()).toMatchObject({ code: "EVIDENCE_SOURCE_NOT_COMMITTED" });

      const legacyResponse = await create(legacy.id);
      expect(legacyResponse.status).toBe(409);
      expect(await legacyResponse.json()).toMatchObject({ code: "EVIDENCE_SOURCE_NOT_COMMITTED" });

      const unknownResponse = await create("session-does-not-exist");
      expect(unknownResponse.status).toBe(404);
      expect(await unknownResponse.json()).toMatchObject({ code: "EVIDENCE_SOURCE_NOT_FOUND" });
    }

    const corruptPost = await postSession(corrupt.id);
    expect(corruptPost.status).toBe(409);
    expect(await corruptPost.json()).toMatchObject({ code: "EVIDENCE_SOURCE_VERIFICATION_FAILED" });
    const corruptCompatibility = await compatibilitySession(corrupt.id);
    expect(corruptCompatibility.status).toBe(409);
    expect(await corruptCompatibility.json()).toMatchObject({ code: "EVIDENCE_SOURCE_CORRUPT" });

    const first = await postSession(complete.id);
    const duplicate = await compatibilitySession(complete.id);
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    const firstJob = await first.json() as { id: string };
    const duplicateJob = await duplicate.json() as { id: string };
    expect(duplicateJob.id).toBe(firstJob.id);
  });

  it("rejects screenshot bodies at the route gate before raw parsing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-screenshot-api-"));
    temporaryRoots.push(root);
    const port = await unusedPort();
    const storage = path.join(root, "storage");
    const child = spawn(path.join(repositoryRoot, "node_modules/.bin/tsx"), [path.join(repositoryRoot, "src/server/index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        RF_MONITOR_SIMULATION: "on",
        RF_MONITOR_PORT: String(port),
        RF_MONITOR_STORAGE: storage,
        RF_MONITOR_CATALOG_FILE: path.join(repositoryRoot, "config/band-catalog.example.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let errorOutput = "";
    child.stderr?.on("data", (chunk) => { errorOutput += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Screenshot API server did not start: ${errorOutput}`)), 15_000);
      child.once("exit", (code) => reject(new Error(`Server exited with ${code}: ${errorOutput}`)));
      child.stdout?.on("data", (chunk) => {
        if (!chunk.toString().includes("RF Monitor service listening")) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const oversized = await fetch(`${origin}/api/events/unknown/screenshots`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "image/png" },
      body: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "SCREENSHOT_TOO_LARGE" });

    const invalidButUnknown = await fetch(`${origin}/api/events/unknown/screenshots`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "image/png" },
      body: Buffer.from([0]),
    });
    expect(invalidButUnknown.status).toBe(404);
    expect(await invalidButUnknown.json()).toMatchObject({ code: "SCREENSHOT_EVENT_NOT_FOUND" });
  });
});
