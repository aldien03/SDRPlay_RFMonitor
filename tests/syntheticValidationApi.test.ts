import { once } from "node:events";
import { createServer } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

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

async function startServer(simulation: "on" | "off", exercises = false): Promise<{ port: number; origin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-validation-api-"));
  temporaryRoots.push(root);
  // The server may migrate or rewrite its profile; never let it touch the repository copy.
  const operationalPath = path.join(root, "operational.json");
  await copyFile(path.join(repositoryRoot, "config/operational.example.json"), operationalPath);
  const port = await unusedPort();
  const child = spawn(path.join(repositoryRoot, "node_modules/.bin/tsx"), [path.join(repositoryRoot, "src/server/index.ts")], {
    cwd: root,
    env: {
      ...process.env,
      RF_MONITOR_SIMULATION: simulation,
      RF_MONITOR_SYNTHETIC_EXERCISES: exercises ? "true" : "false",
      RF_MONITOR_PORT: String(port),
      RF_MONITOR_STORAGE: path.join(root, "evidence"),
      RF_MONITOR_CATALOG_FILE: path.join(repositoryRoot, "config/band-catalog.example.json"),
      // Live-playback coverage in this test deliberately targets all four
      // Tier-1 windows; production defaults remain one-target Continuous Watch.
      RF_MONITOR_OPERATIONAL_FILE: operationalPath,
      SDRCONNECT_URL: "ws://127.0.0.1:9/",
      RF_MONITOR_RECOVERY_REQUEST: path.join(root, "recover-sdrconnect"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let errorOutput = "";
  child.stderr?.on("data", (chunk) => { errorOutput += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Validation API server did not start: ${errorOutput}`)), 15_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Validation API server exited with ${code}: ${errorOutput}`));
    });
    child.stdout?.on("data", (chunk) => {
      if (!chunk.toString().includes("RF Monitor service listening")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  return { port, origin: `http://127.0.0.1:${port}` };
}

describe("synthetic validation API", () => {
  it("lists and runs compact simulation-only reports", { timeout: 30_000 }, async () => {
    const { origin } = await startServer("on");
    const scenariosResponse = await fetch(`${origin}/api/validation/scenarios`);
    const scenariosText = await scenariosResponse.text();
    const scenarios = JSON.parse(scenariosText) as {
      synthetic: boolean;
      scenarios: Array<{ id: string; target: { id: string; label: string; centerHz: number } }>;
    };
    expect(scenariosResponse.status).toBe(200);
    expect(scenarios.synthetic).toBe(true);
    expect(scenarios.scenarios.map((scenario) => scenario.id)).toContain("matched-power-spoofing");
    expect(scenarios.scenarios).toHaveLength(10);
    expect(scenarios.scenarios.every((scenario) => scenario.target.id === "gnss-l1-e1-b1c-sbas")).toBe(true);
    expect(scenarios.scenarios.every((scenario) => scenario.target.centerHz === 1_575_420_000)).toBe(true);
    expect(scenarios.scenarios.every((scenario) => scenario.target.label.includes("SBAS L1"))).toBe(true);
    expect(Buffer.byteLength(scenariosText)).toBeLessThan(64 * 1024);

    const planResponse = await fetch(`${origin}/api/validation/plan`);
    const planText = await planResponse.text();
    const plan = JSON.parse(planText) as {
      planHash: string;
      plan: { targets: unknown[]; scenarios: Array<{ level: string }> };
      status: { installedChain: string };
    };
    expect(planResponse.status).toBe(200);
    expect(Buffer.byteLength(planText)).toBeLessThan(64 * 1024);
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.plan.targets).toHaveLength(4);
    expect(plan.plan.scenarios.map((scenario) => scenario.level)).toContain("installed-chain");
    expect(plan.status.installedChain).toBe("physical-hardware-required");

    const reportResponse = await fetch(`${origin}/api/validation/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "matched-power-spoofing", mode: "blinded" }),
    });
    const reportText = await reportResponse.text();
    const report = JSON.parse(reportText) as {
      synthetic: boolean;
      scenario: { target: { id: string; label: string; centerHz: number } };
      observed: { outcome: string; alertKinds: string[] };
      score: { eventScores: Array<{ verdict: string }> };
      truth: { verified: boolean };
      passed: boolean;
    };
    expect(reportResponse.status).toBe(200);
    expect(Buffer.byteLength(reportText)).toBeLessThan(64 * 1024);
    expect(report).toMatchObject({
      synthetic: true,
      scenario: { target: { id: "gnss-l1-e1-b1c-sbas", centerHz: 1_575_420_000 } },
      observed: { outcome: "no-alert", alertKinds: [] },
      truth: { verified: true },
      passed: true,
    });
    expect(report.score.eventScores[0].verdict).toBe("correct-non-detection");
  });

  it("is unavailable unless simulation is explicitly enabled", { timeout: 30_000 }, async () => {
    const { origin } = await startServer("off");
    const listResponse = await fetch(`${origin}/api/validation/scenarios`);
    expect(listResponse.status).toBe(404);
    expect(await listResponse.json()).toEqual({ error: "Synthetic validation is available only in simulation mode" });
    expect((await fetch(`${origin}/api/validation/plan`)).status).toBe(404);

    const runResponse = await fetch(`${origin}/api/validation/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "sham", mode: "guided" }),
    });
    expect(runResponse.status).toBe(404);
  });

  it("rejects invalid and unknown requests without running the detector", { timeout: 30_000 }, async () => {
    const { origin } = await startServer("on");
    const invalid = await fetch(`${origin}/api/validation/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "sham", mode: "invalid" }),
    });
    expect(invalid.status).toBe(400);

    const unknown = await fetch(`${origin}/api/validation/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "unknown", mode: "guided" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("gates one same-origin live playback and exposes bounded state", { timeout: 30_000 }, async () => {
    const { origin } = await startServer("on", true);
    const scenarios = await fetch(`${origin}/api/validation/scenarios`).then((response) => response.json()) as { livePlaybackAvailable: boolean };
    expect(scenarios.livePlaybackAvailable).toBe(true);

    const crossOrigin = await fetch(`${origin}/api/validation/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://example.invalid" },
      body: JSON.stringify({ scenarioId: "wideband" }),
    });
    expect(crossOrigin.status).toBe(403);

    const startedResponse = await fetch(`${origin}/api/validation/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "wideband" }),
    });
    const startedText = await startedResponse.text();
    const started = JSON.parse(startedText) as { playback: { synthetic: boolean; runId: string; scenarioId: string; phase: string } };
    expect(startedResponse.status).toBe(202);
    expect(Buffer.byteLength(startedText)).toBeLessThan(64 * 1024);
    expect(started.playback).toMatchObject({ synthetic: true, scenarioId: "wideband", phase: "waiting-for-target" });

    const collision = await fetch(`${origin}/api/validation/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "cw" }),
    });
    expect(collision.status).toBe(409);

    const status = await fetch(`${origin}/api/validation/playback`).then((response) => response.json()) as { playback: { runId: string } };
    expect(status.playback.runId).toBe(started.playback.runId);

    const stopped = await fetch(`${origin}/api/validation/playback`, { method: "DELETE", headers: { Origin: origin } });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ playback: null });

    const targetedResponse = await fetch(`${origin}/api/validation/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "matched-power-spoofing", targetId: "gnss-gps-l2c" }),
    });
    expect(targetedResponse.status).toBe(202);
    expect(await targetedResponse.json()).toMatchObject({
      playback: {
        synthetic: true,
        scenarioId: "matched-power-spoofing",
        targetId: "gnss-gps-l2c",
        centerHz: 1_227_600_000,
      },
    });
    await fetch(`${origin}/api/validation/playback`, { method: "DELETE", headers: { Origin: origin } });
  });

  it("keeps live playback absent without the second explicit opt-in", { timeout: 30_000 }, async () => {
    const { origin } = await startServer("on", false);
    expect((await fetch(`${origin}/api/validation/playback`)).status).toBe(404);
    const response = await fetch(`${origin}/api/validation/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ scenarioId: "wideband" }),
    });
    expect(response.status).toBe(404);
  });
});
