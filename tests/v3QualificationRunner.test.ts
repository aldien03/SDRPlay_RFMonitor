import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  V3_SURFACE_CASES,
  V3_VIEWPORTS,
  V3_WORKFLOW_CASES,
  createV3Manifest,
  createV3Report,
  parseV3Arguments,
  publishV3Bundle,
  validateV3BrowserCapture,
  validateV3Candidate,
  verifyV3Bundle,
} from "../scripts/run-v3-packaged-browser-qualification.mjs";

const roots: string[] = [];

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o750).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => makeWritable(path.join(directory, entry.name))));
  await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => chmod(path.join(directory, entry.name), 0o640).catch(() => undefined)));
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function release(seed = "1") {
  return {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: "1.0.0",
    buildId: "1.0.0+v3-test",
    sourceDigest: seed.repeat(64),
    packageDigest: "2".repeat(64),
    dependencyLockDigest: "3".repeat(64),
  };
}

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.writeUInt32BE(13, 8);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function marker(definition: { route: string; harnessSurface: string; viewportId?: string }, polling = false) {
  const viewport = V3_VIEWPORTS[(definition.viewportId ?? "desktop") as keyof typeof V3_VIEWPORTS];
  const zero = { started: 0, completed: 0, aborted: 0, failed: 0, active: 0, maxConcurrent: 0 };
  const windows = polling ? [
    {
      label: "health-visible-1",
      startedAt: new Date(Date.now() - 21_000).toISOString(),
      completedAt: new Date(Date.now() - 9_000).toISOString(),
      durationMs: 12_000,
      visibility: "visible",
      expectedHealthPolling: "active",
      health: { ...zero, started: 7, completed: 7, maxConcurrent: 1 },
      issues: [],
    },
    {
      label: "health-closed-1",
      startedAt: new Date(Date.now() - 8_000).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 8_000,
      visibility: "visible",
      expectedHealthPolling: "stopped",
      health: { ...zero },
      issues: [],
    },
  ] : [];
  return {
    schemaVersion: 1,
    state: "ready",
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    capturedAt: new Date().toISOString(),
    clientBuildId: release().buildId,
    qualificationRunId: "v3-test-run",
    facts: {
      route: `${definition.route}?qa=v3`,
      surface: definition.harnessSurface,
      rootFound: true,
      meaningfulTextLength: 800,
      viewportWidth: viewport.effectiveWidth,
      viewportHeight: viewport.effectiveHeight,
      documentClientWidth: viewport.effectiveWidth,
      documentScrollWidth: viewport.effectiveWidth,
      frameworkOverlay: false,
      dataMode: "test",
      modeLabel: "Simulation / Test",
      monitoringState: "normal",
      monitoringLabel: "Normal",
      connectionError: false,
    },
    issues: [],
    runtimeEvents: [],
    requests: { total: { ...zero, started: 8, completed: 8, maxConcurrent: 1 }, byPath: {} },
    windows,
    accessibility: { state: "ready", axeVersion: "4.13.0", seriousOrCritical: 0, violationCount: 0, incompleteCount: 0 },
  };
}

const cleanBrowserFacts = {
  console: { errors: [], warnings: [] },
  network: { externalRequests: [], failedRequests: [], pendingRequests: 0 },
  keyboard: { criticalActionsReachable: true, mouseOnlyControls: 0 },
  layout: { criticalContentClipped: false },
};

async function screenshot(root: string, file: string, viewport: { effectiveWidth: number; effectiveHeight: number }) {
  const contents = png(viewport.effectiveWidth, viewport.effectiveHeight);
  await writeFile(path.join(root, file), contents, { flag: "wx" });
  return { file, bytes: contents.byteLength, sha256: sha256(contents), width: viewport.effectiveWidth, height: viewport.effectiveHeight };
}

async function captureFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v3-runner-"));
  roots.push(root);
  const runId = "v3-test-run";
  const origin = "http://127.0.0.1:18083";
  const configurationSha256 = "4".repeat(64);
  const serverStartedAt = new Date(Date.now() - 30_000).toISOString();
  const startedAt = new Date(Date.now() - 25_000).toISOString();
  const completedAt = new Date().toISOString();
  const surfaces = [];
  for (const definition of V3_SURFACE_CASES) {
    const viewport = V3_VIEWPORTS[definition.viewportId as keyof typeof V3_VIEWPORTS];
    surfaces.push({
      caseId: definition.caseId,
      url: `${origin}${definition.route}?qa=v3&qualification=${runId}`,
      viewport: { ...viewport },
      marker: marker(definition),
      ...cleanBrowserFacts,
      screenshot: await screenshot(root, definition.screenshotFile, viewport),
    });
  }
  const workflows = [];
  for (const definition of V3_WORKFLOW_CASES) {
    workflows.push({
      workflowId: definition.workflowId,
      url: `${origin}${definition.route}?qa=v3&qualification=${runId}`,
      observedCases: [...definition.requiredCases],
      passed: true,
      expectedOperatorAction: "Follow the shown safe action and preserve evidence.",
      marker: marker({ ...definition, viewportId: "desktop" }, definition.workflowId === "polling"),
      ...cleanBrowserFacts,
      screenshot: await screenshot(root, definition.screenshotFile, V3_VIEWPORTS.desktop),
    });
  }
  const capture = {
    schemaVersion: 1,
    recordType: "rf-monitor-v3-browser-capture",
    runId,
    startedAt,
    completedAt,
    origin,
    release: release(),
    server: { packaged: true, simulation: true, dataDomain: "test", serverBuildId: release().buildId, clientBuildId: release().buildId },
    configurationSha256,
    surfaces,
    workflows,
    representativeOperatorDrill: { passed: true, nonDeveloper: true, evidenceLocated: true, response: "Acknowledge the alert, check another navigation source, and download the evidence package." },
  };
  return {
    root,
    capture,
    expected: { runId, origin, release: release(), configurationSha256, serverStartedAt, maximumDurationMs: 60_000 },
  };
}

describe("V3 packaged browser qualification runner", () => {
  it("shows help without starting a server and rejects unknown or unsafe arguments", () => {
    expect(parseV3Arguments(["--help"])).toMatchObject({ help: true });
    expect(parseV3Arguments(["--capture", "/tmp/new-capture.json", "--timeout-seconds", "60"])).toMatchObject({ capture: "/tmp/new-capture.json", timeoutSeconds: 60 });
    expect(() => parseV3Arguments([])).toThrow(/--capture is required/);
    expect(() => parseV3Arguments(["--unknown"])).toThrow(/Unknown argument/);
    expect(() => parseV3Arguments(["--capture", "/tmp/x", "--timeout-seconds", "3601"])).toThrow(/60 to 3600/);
    expect(() => parseV3Arguments(["--verify-bundle", "/tmp/x", "--keep-temp"])).toThrow(/cannot be combined/);
    expect(() => parseV3Arguments(["--verify-bundle", "/tmp/x", "--timeout-seconds", "1800"])).toThrow(/cannot be combined/);
    const script = path.resolve("scripts/run-v3-packaged-browser-qualification.mjs");
    const help = spawnSync("/usr/bin/node", [script, "--help"], { encoding: "utf8" });
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("It does not run a browser itself");
    const unknown = spawnSync("/usr/bin/node", [script, "--unknown"], { encoding: "utf8" });
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown argument: --unknown");
  });

  it("accepts only the complete exact browser matrix and fails stale, incomplete, unsafe, or polling-broken evidence", async () => {
    const fixture = await captureFixture();
    await expect(validateV3BrowserCapture({ capture: fixture.capture, expected: fixture.expected, screenshotRoot: fixture.root }))
      .resolves.toMatchObject({ valid: true, screenshots: { length: V3_SURFACE_CASES.length + V3_WORKFLOW_CASES.length } });

    const staleUrl = structuredClone(fixture.capture);
    staleUrl.surfaces[0].url = "http://example.invalid/?qa=v3&qualification=v3-test-run";
    await expect(validateV3BrowserCapture({ capture: staleUrl, expected: fixture.expected, screenshotRoot: fixture.root })).rejects.toThrow(/exact packaged route/);

    const staleBuild = structuredClone(fixture.capture);
    staleBuild.surfaces[0].marker.clientBuildId = "stale-build";
    await expect(validateV3BrowserCapture({ capture: staleBuild, expected: fixture.expected, screenshotRoot: fixture.root })).rejects.toThrow(/client build is stale/);

    const incomplete = structuredClone(fixture.capture);
    incomplete.workflows.pop();
    await expect(validateV3BrowserCapture({ capture: incomplete, expected: fixture.expected, screenshotRoot: fixture.root })).rejects.toThrow(/matrix is incomplete/);

    const axeIncomplete = structuredClone(fixture.capture);
    axeIncomplete.surfaces[0].marker.accessibility.incompleteCount = 1;
    await expect(validateV3BrowserCapture({ capture: axeIncomplete, expected: fixture.expected, screenshotRoot: fixture.root })).rejects.toThrow(/axe result/);

    const pollingAfterClose = structuredClone(fixture.capture);
    const polling = pollingAfterClose.workflows.find((entry) => entry.workflowId === "polling")!;
    polling.marker.windows[1].health.started = 1;
    await expect(validateV3BrowserCapture({ capture: pollingAfterClose, expected: fixture.expected, screenshotRoot: fixture.root })).rejects.toThrow(/stopped health polling/);
  });

  it("publishes and verifies one immutable exact software-only bundle, then detects tampering and overwrite", async () => {
    const fixture = await captureFixture();
    const validation = await validateV3BrowserCapture({ capture: fixture.capture, expected: fixture.expected, screenshotRoot: fixture.root });
    const manifest = createV3Manifest({
      runId: fixture.expected.runId,
      createdAt: fixture.expected.serverStartedAt,
      release: fixture.expected.release,
      origin: fixture.expected.origin,
      configurationSha256: fixture.expected.configurationSha256,
      configurationSources: { catalogSha256: "6".repeat(64), operationalSha256: "7".repeat(64) },
      maximumDurationMs: fixture.expected.maximumDurationMs,
    });
    const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
    const report = createV3Report({
      manifest,
      manifestSha256: sha256(manifestContents),
      releaseAfter: fixture.expected.release,
      capture: fixture.capture,
      validation,
      fieldIsolation: { treeBefore: { sha256: "5".repeat(64), entries: 2, bytes: 48 }, treeAfter: { sha256: "5".repeat(64), entries: 2, bytes: 48 }, unchanged: true },
      completedAt: new Date().toISOString(),
    });
    const destination = path.join(fixture.root, "bundle");
    await expect(publishV3Bundle({ outputDirectory: destination, manifest, report, screenshotRoot: fixture.root })).resolves.toBe(destination);
    await expect(verifyV3Bundle(destination)).resolves.toMatchObject({ valid: true, gate: "V3", result: "passed", buildId: release().buildId });
    expect((await stat(destination)).mode & 0o777).toBe(0o550);
    expect((await stat(path.join(destination, "report.json"))).mode & 0o777).toBe(0o440);
    expect(JSON.parse(await readFile(path.join(destination, "report.json"), "utf8"))).toMatchObject({
      result: { softwareQualificationOnly: true, productionReady: false, liveHardwareQualification: "not-run", downstreamGates: { V5: "not-run", V6: "not-run", V7: "not-run" } },
    });
    await expect(publishV3Bundle({ outputDirectory: destination, manifest, report, screenshotRoot: fixture.root })).rejects.toMatchObject({ code: expect.stringMatching(/EEXIST|ENOTEMPTY/) });

    await chmod(path.join(destination, "report.json"), 0o640);
    await writeFile(path.join(destination, "report.json"), `${JSON.stringify({ ...report, operatorWorkflowsPassed: false })}\n`);
    await chmod(path.join(destination, "report.json"), 0o440);
    await expect(verifyV3Bundle(destination)).rejects.toThrow(/checksum mismatch/);
  });

  it("uses the downstream seven-field release identity and rejects a pre/post candidate change", async () => {
    await expect(validateV3Candidate({
      validatePackage: async () => ({ valid: true, ...release(), clientBuildId: release().buildId }),
    })).resolves.toEqual(release());
    const fixture = await captureFixture();
    const validation = await validateV3BrowserCapture({ capture: fixture.capture, expected: fixture.expected, screenshotRoot: fixture.root });
    const manifest = createV3Manifest({
      runId: fixture.expected.runId,
      createdAt: fixture.expected.serverStartedAt,
      release: fixture.expected.release,
      origin: fixture.expected.origin,
      configurationSha256: fixture.expected.configurationSha256,
      configurationSources: { catalogSha256: "6".repeat(64), operationalSha256: "7".repeat(64) },
      maximumDurationMs: fixture.expected.maximumDurationMs,
    });
    expect(() => createV3Report({
      manifest,
      manifestSha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`),
      releaseAfter: release("9"),
      capture: fixture.capture,
      validation,
      fieldIsolation: { treeBefore: { sha256: "5".repeat(64), entries: 2, bytes: 48 }, treeAfter: { sha256: "5".repeat(64), entries: 2, bytes: 48 }, unchanged: true },
      completedAt: new Date().toISOString(),
    })).toThrow(/sourceDigest/);
  });
});
