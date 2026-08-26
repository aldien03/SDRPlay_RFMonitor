import { once } from "node:events";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminCredential } from "../src/server/adminAuth";
import { EvidenceStore } from "../src/server/evidenceStore";
import type { RecordingDeletionResult, SettingsRevision } from "../src/shared/types";

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

describe("protected recordings deletion API", { timeout: 30_000 }, () => {
  it("requires the protected session and exact revision/domain while retaining live and other-domain data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-recordings-api-"));
    temporaryRoots.push(root);
    const storage = path.join(root, "storage");
    const testEvidenceRoot = path.join(storage, "test", "evidence");
    const fieldSentinel = path.join(storage, "field", "evidence", "field-sentinel.txt");
    await mkdir(path.dirname(fieldSentinel), { recursive: true });
    await writeFile(fieldSentinel, "field-data-must-remain\n");
    const prepared = new EvidenceStore(testEvidenceRoot, { dataDomain: "test" });
    const archived = await prepared.initialize({ config: { archived: true }, sdrconnect: {} });
    await prepared.closeActive();

    const password = "recordings deletion fixture";
    const adminPath = path.join(root, "admin.json");
    await writeFile(adminPath, JSON.stringify(await createAdminCredential(password)));
    const port = await unusedPort();
    const child = spawn(path.join(repositoryRoot, "node_modules/.bin/tsx"), [path.join(repositoryRoot, "src/server/index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        RF_MONITOR_SIMULATION: "on",
        RF_MONITOR_PORT: String(port),
        RF_MONITOR_STORAGE: storage,
        RF_MONITOR_ADMIN_FILE: adminPath,
        RF_MONITOR_CATALOG_FILE: path.join(repositoryRoot, "config/band-catalog.example.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    let errorOutput = "";
    child.stderr?.on("data", (chunk) => { errorOutput += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server did not start: ${errorOutput}`)), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with ${code}: ${errorOutput}`));
      });
      child.stdout?.on("data", (chunk) => {
        if (!chunk.toString().includes("RF Monitor service listening")) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    const origin = `http://127.0.0.1:${port}`;
    const post = (body: object, cookie?: string) => fetch(`${origin}/api/recordings/delete`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-rf-monitor-csrf": "settings-v1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    expect((await post({})).status).toBe(401);

    const unlock = await fetch(`${origin}/api/admin/unlock`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(unlock.status).toBe(200);
    const cookie = unlock.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Admin unlock did not return a session cookie");
    const settings = await unlock.json() as SettingsRevision;
    const revision = settings.settings.revision;
    const request = {
      expectedConfigurationRevision: revision,
      confirmation: "DELETE RECORDINGS",
      dataDomain: "test",
    };

    expect((await post({ ...request, expectedConfigurationRevision: revision - 1 }, cookie)).status).toBe(409);
    await expect(stat(archived.path)).resolves.toBeTruthy();
    expect((await post({ ...request, dataDomain: "field" }, cookie)).status).toBe(409);
    expect(await readFile(fieldSentinel, "utf8")).toBe("field-data-must-remain\n");

    const deletion = await post(request, cookie);
    const payload = await deletion.json() as { configurationRevision: number; result: RecordingDeletionResult };
    expect(deletion.status).toBe(200);
    expect(payload).toMatchObject({
      configurationRevision: revision,
      result: {
        state: "complete",
        dataDomain: "test",
        deletedSessions: 1,
        deletedBytes: expect.any(Number),
        retainedActiveSessions: 1,
        retainedFinalizingSessions: 0,
        retainedLeasedSessions: 0,
        auditDurable: true,
      },
    });
    expect(payload.result.deletedBytes).toBeGreaterThan(0);
    await expect(stat(archived.path)).rejects.toThrow();
    expect(await readFile(fieldSentinel, "utf8")).toBe("field-data-must-remain\n");
    const remainingSessions = (await readdir(testEvidenceRoot)).filter((entry) => entry.startsWith("session-"));
    expect(remainingSessions).toHaveLength(1);

    const health = await fetch(`${origin}/api/health`).then((response) => response.json()) as {
      operatorSummary: { recording: { state: string } };
      evidence: { archive: { state: string; incompleteSessions: number; corruptSessions: number } };
    };
    expect(health.operatorSummary.recording.state).toBe("recording");
    expect(health.evidence.archive).toMatchObject({ state: "normal", incompleteSessions: 0, corruptSessions: 0 });
  });
});
