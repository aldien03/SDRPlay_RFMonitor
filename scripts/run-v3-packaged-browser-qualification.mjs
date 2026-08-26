#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleasePackage } from "./validate-release-package.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const nodeExecutable = "/usr/bin/node";
const serverExecutable = path.join(repositoryRoot, "dist/server-node/index.js");
const defaultCatalogPath = path.join(repositoryRoot, "config/band-catalog.example.json");
const defaultOperationalPath = path.join(repositoryRoot, "config/operational.example.json");
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const RELEASE_FIELDS = ["schemaVersion", "product", "releaseVersion", "buildId", "sourceDigest", "packageDigest", "dependencyLockDigest"];
const activeCleanups = new Set();
const V3_LIMITATIONS = Object.freeze([
  "V3 is packaged browser software evidence only.",
  "V3 does not qualify physical RF hardware and cannot satisfy V5, V6, or V7.",
]);

export const V3_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ physicalWidth: 1920, physicalHeight: 1080, effectiveWidth: 1920, effectiveHeight: 1080, zoomPercent: 100 }),
  compact: Object.freeze({ physicalWidth: 1366, physicalHeight: 768, effectiveWidth: 1366, effectiveHeight: 768, zoomPercent: 100 }),
  zoom200: Object.freeze({ physicalWidth: 1920, physicalHeight: 1080, effectiveWidth: 960, effectiveHeight: 540, zoomPercent: 200 }),
});

const standardSurfaces = [
  ["dashboard", "/", "dashboard"],
  ["settings-monitoring", "/", "settings"],
  ["settings-system-health", "/", "settings"],
  ["settings-recording", "/", "settings"],
  ["settings-site", "/", "settings"],
  ["settings-advanced", "/", "settings"],
  ["engineer", "/", "dashboard"],
  ["incidents", "/", "dashboard"],
  ["evidence-history", "/", "dashboard"],
  ["help", "/help", "help"],
];
const zoomSurfaces = [
  ["dashboard", "/", "dashboard"],
  ["status-strip", "/", "dashboard"],
  ["settings-navigation", "/", "settings"],
  ["help", "/help", "help"],
  ["protected-clear-test-data", "/", "settings"],
  ["protected-delete-recordings", "/", "settings"],
  ["protected-restart-software", "/", "settings"],
  ["protected-restart-learning", "/", "settings"],
];

export const V3_SURFACE_CASES = Object.freeze([
  ...["desktop", "compact"].flatMap((viewportId) => standardSurfaces.map(([surfaceId, route, harnessSurface]) => Object.freeze({
    caseId: `${viewportId}-${surfaceId}`,
    viewportId,
    surfaceId,
    route,
    harnessSurface,
    screenshotFile: `surface-${viewportId}-${surfaceId}.png`,
  }))),
  ...zoomSurfaces.map(([surfaceId, route, harnessSurface]) => Object.freeze({
    caseId: `zoom200-${surfaceId}`,
    viewportId: "zoom200",
    surfaceId,
    route,
    harnessSurface,
    screenshotFile: `surface-zoom200-${surfaceId}.png`,
  })),
]);

export const V3_WORKFLOW_CASES = Object.freeze([
  Object.freeze({ workflowId: "canonical-live", route: "/", harnessSurface: "dashboard", requiredCases: ["newer-alert-wins", "stale-control-data-late", "reload-visible", "open-incident-retained"] }),
  Object.freeze({ workflowId: "trust-domain", route: "/", harnessSurface: "dashboard", requiredCases: ["dashboard-test-visible", "settings-test-visible", "help-test-visible", "incident-test-visible", "evidence-test-visible", "export-test-visible", "simulation-unqualified"] }),
  Object.freeze({ workflowId: "system-health", route: "/", harnessSurface: "settings", requiredCases: ["normal", "attention", "critical", "simulation", "issue-deduplicated", "safe-action-visible"] }),
  Object.freeze({ workflowId: "evidence-lifecycle", route: "/", harnessSurface: "dashboard", requiredCases: ["active-disabled", "finalizing-disabled", "complete-downloadable", "incomplete-gap-labelled-downloadable", "corrupt-disabled"] }),
  Object.freeze({ workflowId: "dialog-keyboard", route: "/", harnessSurface: "settings", requiredCases: ["initial-focus", "tab-wrap", "shift-tab-wrap", "escape-policy", "backdrop-policy", "nested-order", "focus-return"] }),
  Object.freeze({ workflowId: "settings-protection", route: "/", harnessSurface: "settings", requiredCases: ["dirty-close", "conflict-keeps-draft", "baseline-restart-confirmed", "clear-test-exact-phrase", "delete-recordings-exact-phrase", "restart-software-exact-phrase", "matched-action-may-remain-disabled"] }),
  Object.freeze({ workflowId: "help", route: "/help", harnessSurface: "help", requiredCases: ["alert", "data", "recording", "learning", "test", "packaged-version", "no-external-content", "no-linux-command"] }),
  Object.freeze({ workflowId: "polling", route: "/", harnessSurface: "settings", requiredCases: ["health-visible-12s", "health-closed-8s", "no-growth", "no-overlap", "no-failure", "no-after-close"] }),
].map((entry) => Object.freeze({ ...entry, screenshotFile: `workflow-${entry.workflowId}.png` })));

export const V3_HELP = `Usage:\n  npm run validate:v3 -- --capture FILE [--output DIRECTORY] [--port PORT] [--timeout-seconds SECONDS] [--catalog FILE] [--operational FILE] [--keep-temp]\n  npm run validate:v3 -- --verify-bundle DIRECTORY\n  npm run validate:v3 -- --help\n\nThe runner starts the packaged application in an isolated Simulation/Test root, prints the exact capture URL, and waits for an atomically written browser capture file. It does not run a browser itself.\n\nOptions:\n  --capture FILE           Browser capture JSON to wait for (must not already exist).\n  --output DIRECTORY       Immutable V3 bundle destination.\n  --port PORT              Loopback port (1024-65535); otherwise selected automatically.\n  --timeout-seconds N      Capture wait, 60-3600 seconds (default: 1800).\n  --catalog FILE           Exact schema-v3 catalog (default: config/band-catalog.example.json).\n  --operational FILE       Exact schema-v3 profile (default: config/operational.example.json).\n  --keep-temp              Keep the isolated test root after completion.\n  --verify-bundle DIR      Read-only mechanical verification.\n  -h, --help               Show this help without starting the server.\n`;

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  assertion(isObject(value), `${label} must be an object`);
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  assertion(observed.length === expected.length && observed.every((key, index) => key === expected[index]), `${label} fields are invalid`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
}

function sha256Canonical(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function safeTimestamp(value = new Date()) {
  return value.toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
}

function safeId(value, label) {
  assertion(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value), `${label} is invalid`);
  return value;
}

function exactRelease(value, label = "release") {
  exactKeys(value, RELEASE_FIELDS, label);
  const result = {};
  for (const field of RELEASE_FIELDS) {
    const observed = value[field];
    if (field === "schemaVersion") assertion(observed === 1, `${label} schemaVersion is invalid`);
    else if (field === "product") assertion(observed === "rf-monitor", `${label} product is invalid`);
    else if (field.endsWith("Digest")) assertion(typeof observed === "string" && /^[a-f0-9]{64}$/.test(observed), `${label} ${field} is invalid`);
    else safeId(observed, `${label} ${field}`);
    result[field] = observed;
  }
  return result;
}

function sameRelease(left, right, label = "release") {
  const first = exactRelease(left, `${label} before`);
  const second = exactRelease(right, `${label} after`);
  for (const field of RELEASE_FIELDS) assertion(first[field] === second[field], `${label} changed: ${field}`);
  return true;
}

export function parseV3Arguments(arguments_) {
  const result = { help: false, capture: undefined, output: undefined, port: undefined, timeoutSeconds: 1800, catalog: defaultCatalogPath, operational: defaultOperationalPath, keepTemp: false, verifyBundle: undefined };
  const seenValueOptions = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      if (result.help) throw new Error(`Duplicate argument: ${argument}`);
      result.help = true;
      continue;
    }
    if (argument === "--keep-temp") {
      if (result.keepTemp) throw new Error("Duplicate argument: --keep-temp");
      result.keepTemp = true;
      continue;
    }
    if (["--capture", "--output", "--port", "--timeout-seconds", "--catalog", "--operational", "--verify-bundle"].includes(argument)) {
      const field = ({ "--capture": "capture", "--output": "output", "--port": "port", "--timeout-seconds": "timeoutSeconds", "--catalog": "catalog", "--operational": "operational", "--verify-bundle": "verifyBundle" })[argument];
      if (seenValueOptions.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      seenValueOptions.add(argument);
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
      result[field] = field === "port" || field === "timeoutSeconds" ? Number(value) : value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.help && arguments_.length !== 1) throw new Error("--help cannot be combined with other arguments");
  if (result.verifyBundle && (result.capture || result.output || result.port || result.keepTemp || seenValueOptions.has("--timeout-seconds") || seenValueOptions.has("--catalog") || seenValueOptions.has("--operational"))) throw new Error("--verify-bundle cannot be combined with run options");
  if (!result.help && !result.verifyBundle && !result.capture) throw new Error("--capture is required");
  if (result.port !== undefined && (!Number.isSafeInteger(result.port) || result.port < 1024 || result.port > 65535)) throw new Error("--port must be an integer from 1024 to 65535");
  if (!Number.isSafeInteger(result.timeoutSeconds) || result.timeoutSeconds < 60 || result.timeoutSeconds > 3600) throw new Error("--timeout-seconds must be an integer from 60 to 3600");
  return result;
}

export async function validateV3Candidate({ root = repositoryRoot, validatePackage = validateReleasePackage } = {}) {
  const validated = await validatePackage({ repositoryRoot: root });
  assertion(validated?.valid === true, "V3 release-package validation did not pass");
  return exactRelease({
    schemaVersion: 1,
    product: "rf-monitor",
    ...Object.fromEntries(RELEASE_FIELDS.slice(2).map((field) => [field, validated[field]])),
  }, "validated V3 release");
}

function exactStringArray(value, expected, label) {
  assertion(Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]), `${label} is incomplete or out of order`);
}

function exactCaptureUrl(value, origin, runId, route, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} URL is invalid`); }
  assertion(parsed.origin === origin && parsed.pathname === route && !parsed.username && !parsed.password && !parsed.hash, `${label} URL is not the exact packaged route`);
  const keys = [...parsed.searchParams.keys()].sort();
  assertion(keys.length === 2 && keys[0] === "qa" && keys[1] === "qualification", `${label} URL query is invalid`);
  assertion(parsed.searchParams.get("qa") === "v3" && parsed.searchParams.get("qualification") === runId, `${label} URL is not bound to this V3 run`);
}

function validateMarker(marker, expected, release, runId, polling = false) {
  assertion(isObject(marker) && marker.schemaVersion === 1 && marker.state === "ready", `${expected.caseId ?? expected.workflowId} V3 marker is not ready`);
  assertion(marker.clientBuildId === release.buildId, `${expected.caseId ?? expected.workflowId} client build is stale`);
  assertion(marker.qualificationRunId === runId, `${expected.caseId ?? expected.workflowId} marker is not bound to this V3 run`);
  assertion(isObject(marker.facts), `${expected.caseId ?? expected.workflowId} marker facts are missing`);
  const viewport = V3_VIEWPORTS[expected.viewportId ?? "desktop"];
  const expectedRoute = `${expected.route}?qa=v3`;
  assertion(marker.facts.route === expectedRoute && marker.facts.surface === expected.harnessSurface, `${expected.caseId ?? expected.workflowId} marker route/surface is wrong`);
  assertion(marker.facts.viewportWidth === viewport.effectiveWidth && marker.facts.viewportHeight === viewport.effectiveHeight, `${expected.caseId ?? expected.workflowId} effective viewport is wrong`);
  assertion(marker.facts.documentClientWidth === viewport.effectiveWidth && marker.facts.documentScrollWidth <= marker.facts.documentClientWidth + 1, `${expected.caseId ?? expected.workflowId} has horizontal overflow`);
  assertion(marker.facts.rootFound === true && marker.facts.meaningfulTextLength >= 20 && marker.facts.frameworkOverlay === false, `${expected.caseId ?? expected.workflowId} packaged surface is incomplete`);
  assertion(marker.facts.dataMode === "test" && /simulation|test/i.test(String(marker.facts.modeLabel ?? "")), `${expected.caseId ?? expected.workflowId} is not visibly Simulation/Test`);
  assertion(Array.isArray(marker.issues) && marker.issues.length === 0, `${expected.caseId ?? expected.workflowId} has harness issues`);
  assertion(Array.isArray(marker.runtimeEvents) && marker.runtimeEvents.length === 0, `${expected.caseId ?? expected.workflowId} has browser runtime errors`);
  assertion(isObject(marker.accessibility) && marker.accessibility.state === "ready"
    && marker.accessibility.seriousOrCritical === 0 && marker.accessibility.violationCount === 0 && marker.accessibility.incompleteCount === 0,
  `${expected.caseId ?? expected.workflowId} axe result is incomplete or failing`);
  assertion(isObject(marker.requests?.total) && marker.requests.total.failed === 0 && marker.requests.total.active === 0 && marker.requests.total.maxConcurrent <= 2,
    `${expected.caseId ?? expected.workflowId} request state is failing or still active`);
  assertion(Array.isArray(marker.windows) && marker.windows.length <= 24 && marker.windows.every((window) => Array.isArray(window.issues) && window.issues.length === 0), `${expected.caseId ?? expected.workflowId} polling marker has issues`);
  if (polling) {
    const active = marker.windows.find((window) => window.expectedHealthPolling === "active" && window.visibility === "visible" && window.durationMs >= 12_000);
    const stopped = marker.windows.find((window) => window.expectedHealthPolling === "stopped" && window.durationMs >= 8_000);
    assertion(active && active.health?.started > 0 && active.health.failed === 0 && active.health.maxConcurrent <= 2, "V3 visible health polling evidence is incomplete");
    assertion(stopped && stopped.health?.started === 0, "V3 stopped health polling evidence is incomplete");
  }
}

function validateConsoleAndNetwork(entry, label) {
  exactKeys(entry.console, ["errors", "warnings"], `${label} console`);
  assertion(Array.isArray(entry.console.errors) && entry.console.errors.length === 0 && Array.isArray(entry.console.warnings) && entry.console.warnings.length === 0, `${label} console is not clean`);
  exactKeys(entry.network, ["externalRequests", "failedRequests", "pendingRequests"], `${label} network`);
  assertion(Array.isArray(entry.network.externalRequests) && entry.network.externalRequests.length === 0
    && Array.isArray(entry.network.failedRequests) && entry.network.failedRequests.length === 0
    && entry.network.pendingRequests === 0, `${label} network is not clean and same-origin`);
  exactKeys(entry.keyboard, ["criticalActionsReachable", "mouseOnlyControls"], `${label} keyboard`);
  assertion(entry.keyboard.criticalActionsReachable === true && entry.keyboard.mouseOnlyControls === 0, `${label} has a mouse-only critical control`);
  exactKeys(entry.layout, ["criticalContentClipped"], `${label} layout`);
  assertion(entry.layout.criticalContentClipped === false, `${label} clips critical content`);
}

function validateMarkerTime(marker, label, serverStartedMs, captureStartedMs, captureCompletedMs) {
  const markerStartedMs = Date.parse(marker.startedAt);
  const markerCapturedMs = Date.parse(marker.capturedAt);
  assertion(Number.isFinite(markerStartedMs) && Number.isFinite(markerCapturedMs)
    && markerStartedMs >= serverStartedMs && markerStartedMs >= captureStartedMs - 1_000
    && markerCapturedMs >= markerStartedMs && markerCapturedMs <= captureCompletedMs + 1_000,
  `${label} marker timestamps are outside this browser run`);
}

function pngDimensions(contents, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assertion(contents.byteLength >= 24 && contents.subarray(0, 8).equals(signature)
    && contents.readUInt32BE(8) === 13 && contents.subarray(12, 16).toString("ascii") === "IHDR", `${label} is not a bounded PNG screenshot`);
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  assertion(width >= 320 && width <= 4096 && height >= 240 && height <= 2160, `${label} dimensions are invalid`);
  return { width, height };
}

async function validateScreenshot(screenshot, expectedName, screenshotRoot, expectedViewport, label) {
  exactKeys(screenshot, ["bytes", "file", "height", "sha256", "width"], `${label} screenshot`);
  assertion(screenshot.file === expectedName && /^[a-z0-9][a-z0-9._-]{0,180}\.png$/.test(screenshot.file), `${label} screenshot name is invalid`);
  assertion(Number.isSafeInteger(screenshot.bytes) && screenshot.bytes > 24 && screenshot.bytes <= MAX_SCREENSHOT_BYTES, `${label} screenshot size is invalid`);
  assertion(/^[a-f0-9]{64}$/.test(String(screenshot.sha256 ?? "")), `${label} screenshot hash is invalid`);
  const filePath = path.join(screenshotRoot, screenshot.file);
  assertion(path.dirname(filePath) === path.resolve(screenshotRoot), `${label} screenshot escaped its root`);
  const details = await lstat(filePath);
  assertion(details.isFile() && !details.isSymbolicLink() && details.size === screenshot.bytes, `${label} screenshot file is invalid`);
  assertion(await realpath(filePath) === filePath, `${label} screenshot may not use symlinked path components`);
  const contents = await readFile(filePath);
  const dimensions = pngDimensions(contents, label);
  assertion(dimensions.width === screenshot.width && dimensions.height === screenshot.height, `${label} screenshot dimensions disagree with its PNG`);
  assertion(dimensions.width === expectedViewport.effectiveWidth && dimensions.height === expectedViewport.effectiveHeight, `${label} screenshot does not match the effective viewport`);
  assertion(sha256(contents) === screenshot.sha256, `${label} screenshot hash mismatch`);
  return { name: screenshot.file, bytes: contents.byteLength, sha256: screenshot.sha256, ...dimensions };
}

export async function validateV3BrowserCapture({ capture, expected, screenshotRoot }) {
  exactKeys(capture, ["completedAt", "configurationSha256", "origin", "recordType", "release", "representativeOperatorDrill", "runId", "schemaVersion", "server", "startedAt", "surfaces", "workflows"], "V3 browser capture");
  assertion(capture.schemaVersion === 1 && capture.recordType === "rf-monitor-v3-browser-capture", "V3 browser capture schema is invalid");
  assertion(capture.runId === expected.runId && capture.origin === expected.origin, "V3 browser capture run/origin is stale");
  sameRelease(capture.release, expected.release, "V3 browser release");
  assertion(capture.configurationSha256 === expected.configurationSha256 && /^[a-f0-9]{64}$/.test(capture.configurationSha256), "V3 browser configuration identity is stale");
  exactKeys(capture.server, ["clientBuildId", "dataDomain", "packaged", "serverBuildId", "simulation"], "V3 browser server");
  assertion(capture.server.packaged === true && capture.server.simulation === true && capture.server.dataDomain === "test"
    && capture.server.serverBuildId === expected.release.buildId && capture.server.clientBuildId === expected.release.buildId,
  "V3 browser server is not the exact packaged Simulation/Test instance");
  const startedMs = Date.parse(capture.startedAt);
  const completedMs = Date.parse(capture.completedAt);
  assertion(Number.isFinite(startedMs) && Number.isFinite(completedMs) && startedMs >= Date.parse(expected.serverStartedAt)
    && completedMs >= startedMs && completedMs - startedMs <= expected.maximumDurationMs && completedMs <= Date.now() + 5_000,
  "V3 browser capture timestamps are invalid or outside this run");
  assertion(Array.isArray(capture.surfaces) && capture.surfaces.length === V3_SURFACE_CASES.length, "V3 surface capture matrix is incomplete");
  assertion(Array.isArray(capture.workflows) && capture.workflows.length === V3_WORKFLOW_CASES.length, "V3 workflow capture matrix is incomplete");
  const screenshots = [];
  let totalScreenshotBytes = 0;
  for (const [index, definition] of V3_SURFACE_CASES.entries()) {
    const entry = capture.surfaces[index];
    exactKeys(entry, ["caseId", "console", "keyboard", "layout", "marker", "network", "screenshot", "url", "viewport"], `${definition.caseId} capture`);
    assertion(entry.caseId === definition.caseId, `V3 surface case order changed at ${index}`);
    exactKeys(entry.viewport, ["effectiveHeight", "effectiveWidth", "physicalHeight", "physicalWidth", "zoomPercent"], `${definition.caseId} viewport`);
    assertion(sha256Canonical(entry.viewport) === sha256Canonical(V3_VIEWPORTS[definition.viewportId]), `${definition.caseId} viewport/zoom is not exact`);
    exactCaptureUrl(entry.url, expected.origin, expected.runId, definition.route, definition.caseId);
    validateMarker(entry.marker, definition, expected.release, expected.runId);
    validateMarkerTime(entry.marker, definition.caseId, Date.parse(expected.serverStartedAt), startedMs, completedMs);
    validateConsoleAndNetwork(entry, definition.caseId);
    const screenshot = await validateScreenshot(entry.screenshot, definition.screenshotFile, screenshotRoot, V3_VIEWPORTS[definition.viewportId], definition.caseId);
    screenshots.push(screenshot);
    totalScreenshotBytes += screenshot.bytes;
  }
  for (const [index, definition] of V3_WORKFLOW_CASES.entries()) {
    const entry = capture.workflows[index];
    exactKeys(entry, ["console", "expectedOperatorAction", "keyboard", "layout", "marker", "network", "observedCases", "passed", "screenshot", "url", "workflowId"], `${definition.workflowId} workflow`);
    assertion(entry.workflowId === definition.workflowId && entry.passed === true, `V3 workflow ${definition.workflowId} did not pass`);
    exactStringArray(entry.observedCases, definition.requiredCases, `${definition.workflowId} observed cases`);
    assertion(typeof entry.expectedOperatorAction === "string" && entry.expectedOperatorAction.trim().length >= 3 && entry.expectedOperatorAction.length <= 240, `${definition.workflowId} operator action is missing`);
    exactCaptureUrl(entry.url, expected.origin, expected.runId, definition.route, definition.workflowId);
    validateMarker(entry.marker, { ...definition, caseId: definition.workflowId, viewportId: "desktop" }, expected.release, expected.runId, definition.workflowId === "polling");
    validateMarkerTime(entry.marker, definition.workflowId, Date.parse(expected.serverStartedAt), startedMs, completedMs);
    validateConsoleAndNetwork(entry, definition.workflowId);
    const screenshot = await validateScreenshot(entry.screenshot, definition.screenshotFile, screenshotRoot, V3_VIEWPORTS.desktop, definition.workflowId);
    screenshots.push(screenshot);
    totalScreenshotBytes += screenshot.bytes;
  }
  assertion(totalScreenshotBytes <= MAX_BUNDLE_BYTES, "V3 screenshots exceed the bundle bound");
  exactKeys(capture.representativeOperatorDrill, ["evidenceLocated", "nonDeveloper", "passed", "response"], "V3 representative operator drill");
  assertion(capture.representativeOperatorDrill.passed === true && capture.representativeOperatorDrill.nonDeveloper === true
    && capture.representativeOperatorDrill.evidenceLocated === true
    && typeof capture.representativeOperatorDrill.response === "string" && capture.representativeOperatorDrill.response.trim().length >= 3
    && capture.representativeOperatorDrill.response.length <= 500,
  "V3 representative non-developer response drill did not pass");
  return { valid: true, screenshots, totalScreenshotBytes };
}

function jsonBuffer(value) {
  const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  assertion(contents.byteLength <= MAX_JSON_BYTES, "V3 JSON artifact exceeds its bound");
  return contents;
}

export function createV3Manifest({ runId, createdAt, release, origin, configurationSha256, configurationSources, maximumDurationMs }) {
  assertion(/^[a-f0-9]{64}$/.test(String(configurationSources?.catalogSha256 ?? ""))
    && /^[a-f0-9]{64}$/.test(String(configurationSources?.operationalSha256 ?? "")), "V3 configuration source hashes are invalid");
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v3-packaged-browser-manifest",
    gate: "V3",
    writtenBeforeBrowserCapture: true,
    runId,
    createdAt,
    release: exactRelease(release),
    origin,
    configurationSha256,
    configurationSources,
    server: { packaged: true, dataDomain: "test", simulation: true, host: "127.0.0.1" },
    maximumDurationMs,
    surfaceMatrixSha256: sha256Canonical(V3_SURFACE_CASES),
    workflowMatrixSha256: sha256Canonical(V3_WORKFLOW_CASES),
    surfaceCases: V3_SURFACE_CASES,
    workflowCases: V3_WORKFLOW_CASES,
    bounds: { captureBytes: MAX_CAPTURE_BYTES, jsonBytes: MAX_JSON_BYTES, screenshotBytes: MAX_SCREENSHOT_BYTES, bundleBytes: MAX_BUNDLE_BYTES },
  };
}

export function createV3Report({ manifest, manifestSha256, releaseAfter, capture, validation, fieldIsolation, completedAt }) {
  sameRelease(manifest.release, releaseAfter, "V3 candidate");
  assertion(fieldIsolation?.unchanged === true && sha256Canonical(fieldIsolation.treeBefore) === sha256Canonical(fieldIsolation.treeAfter), "V3 field isolation did not remain exact");
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v3-packaged-browser-result",
    gate: "V3",
    packaged: true,
    configurationSha256: manifest.configurationSha256,
    release: exactRelease(releaseAfter),
    releaseBinding: { before: manifest.release, after: releaseAfter, unchanged: true },
    manifestSha256,
    completedAt,
    result: {
      gateDecision: "passed",
      softwareQualificationOnly: true,
      productionReady: false,
      liveHardwareQualification: "not-run",
      downstreamGates: { V5: "not-run", V6: "not-run", V7: "not-run" },
    },
    accessibility: { violations: 0, seriousOrCritical: 0, incomplete: 0 },
    operatorWorkflowsPassed: true,
    fieldIsolation,
    browserCapture: capture,
    screenshots: validation.screenshots,
    limitations: V3_LIMITATIONS,
  };
}

async function writeExclusive(filePath, contents) {
  const handle = await open(filePath, "wx", 0o440);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishV3Bundle({ outputDirectory, manifest, report, screenshotRoot }) {
  const finalPath = path.resolve(outputDirectory);
  const parent = path.dirname(finalPath);
  const partialPath = path.join(parent, `.partial-${path.basename(finalPath)}-${process.pid}-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  await mkdir(path.join(partialPath, "screenshots"), { recursive: true, mode: 0o750 });
  try {
    const committed = new Map();
    const manifestContents = jsonBuffer(manifest);
    const reportContents = jsonBuffer(report);
    assertion(sha256(manifestContents) === report.manifestSha256, "V3 report does not bind the exact manifest bytes");
    for (const [name, contents] of [["manifest.json", manifestContents], ["report.json", reportContents]]) {
      await writeExclusive(path.join(partialPath, name), contents);
      committed.set(name, sha256(contents));
    }
    let totalBytes = manifestContents.byteLength + reportContents.byteLength;
    for (const screenshot of report.screenshots) {
      const contents = await readFile(path.join(screenshotRoot, screenshot.name));
      assertion(contents.byteLength === screenshot.bytes && sha256(contents) === screenshot.sha256, `V3 screenshot changed before publication: ${screenshot.name}`);
      await writeExclusive(path.join(partialPath, "screenshots", screenshot.name), contents);
      committed.set(`screenshots/${screenshot.name}`, screenshot.sha256);
      totalBytes += contents.byteLength;
    }
    const sums = `${[...committed.entries()].map(([name, digest]) => `${digest}  ${name}`).sort().join("\n")}\n`;
    totalBytes += Buffer.byteLength(sums);
    assertion(totalBytes <= MAX_BUNDLE_BYTES, "V3 bundle exceeds its byte bound");
    await writeExclusive(path.join(partialPath, "SHA256SUMS"), sums);
    await chmod(path.join(partialPath, "screenshots"), 0o550);
    await chmod(partialPath, 0o550);
    await verifyV3Bundle(partialPath);
    await rename(partialPath, finalPath);
    const directory = await open(parent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    await verifyV3Bundle(finalPath);
    return finalPath;
  } catch (error) {
    await chmod(partialPath, 0o750).catch(() => undefined);
    await chmod(path.join(partialPath, "screenshots"), 0o750).catch(() => undefined);
    await rm(partialPath, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyV3Bundle(bundlePath) {
  const root = path.resolve(bundlePath);
  const rootDetails = await lstat(root);
  assertion(rootDetails.isDirectory() && !rootDetails.isSymbolicLink() && (rootDetails.mode & 0o222) === 0, "V3 bundle root is invalid or writable");
  assertion(await realpath(root) === root, "V3 bundle may not use symlinked path components");
  const topEntries = (await readdir(root)).sort();
  assertion(JSON.stringify(topEntries) === JSON.stringify(["SHA256SUMS", "manifest.json", "report.json", "screenshots"]), "V3 bundle entries are incomplete or unexpected");
  const screenshotDirectory = path.join(root, "screenshots");
  const screenshotDirectoryDetails = await lstat(screenshotDirectory);
  assertion(screenshotDirectoryDetails.isDirectory() && !screenshotDirectoryDetails.isSymbolicLink() && (screenshotDirectoryDetails.mode & 0o222) === 0, "V3 screenshot directory is invalid or writable");
  const manifestContents = await readFile(path.join(root, "manifest.json"));
  const reportContents = await readFile(path.join(root, "report.json"));
  assertion(manifestContents.byteLength <= MAX_JSON_BYTES && reportContents.byteLength <= MAX_JSON_BYTES, "V3 bundle JSON exceeds its bound");
  const screenshotNames = [...V3_SURFACE_CASES, ...V3_WORKFLOW_CASES].map((entry) => entry.screenshotFile).sort();
  const observedScreenshotNames = (await readdir(screenshotDirectory)).sort();
  assertion(JSON.stringify(observedScreenshotNames) === JSON.stringify(screenshotNames), "V3 screenshot set is incomplete or unexpected");
  const expectedChecksumNames = ["manifest.json", "report.json", ...screenshotNames.map((name) => `screenshots/${name}`)].sort();
  const sumsContents = await readFile(path.join(root, "SHA256SUMS"), "utf8");
  assertion(Buffer.byteLength(sumsContents) <= 16 * 1024 && sumsContents.endsWith("\n"), "V3 SHA256SUMS is invalid");
  const lines = sumsContents.trimEnd().split("\n");
  assertion(lines.length === expectedChecksumNames.length, "V3 SHA256SUMS coverage is incomplete");
  const committed = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ((?:screenshots\/)?[a-z0-9][a-z0-9._-]{0,180})$/.exec(line);
    assertion(match && expectedChecksumNames.includes(match[2]) && !committed.has(match[2]), "V3 SHA256SUMS contains an invalid or duplicate entry");
    committed.set(match[2], match[1]);
  }
  let totalBundleBytes = Buffer.byteLength(sumsContents);
  for (const name of expectedChecksumNames) {
    const filePath = path.join(root, ...name.split("/"));
    const details = await lstat(filePath);
    assertion(details.isFile() && !details.isSymbolicLink() && (details.mode & 0o222) === 0, `V3 bundle file is invalid or writable: ${name}`);
    totalBundleBytes += details.size;
    assertion(totalBundleBytes <= MAX_BUNDLE_BYTES, "V3 bundle exceeds its byte bound");
    const contents = name === "manifest.json" ? manifestContents : name === "report.json" ? reportContents : await readFile(filePath);
    assertion(sha256(contents) === committed.get(name), `V3 checksum mismatch: ${name}`);
  }
  const manifest = JSON.parse(manifestContents.toString("utf8"));
  const report = JSON.parse(reportContents.toString("utf8"));
  exactKeys(manifest, ["bounds", "configurationSha256", "configurationSources", "createdAt", "gate", "maximumDurationMs", "origin", "recordType", "release", "runId", "schemaVersion", "server", "surfaceCases", "surfaceMatrixSha256", "workflowCases", "workflowMatrixSha256", "writtenBeforeBrowserCapture"], "V3 manifest");
  exactKeys(manifest.server, ["dataDomain", "host", "packaged", "simulation"], "V3 manifest server");
  exactKeys(manifest.configurationSources, ["catalogSha256", "operationalSha256"], "V3 manifest configuration sources");
  exactKeys(manifest.bounds, ["bundleBytes", "captureBytes", "jsonBytes", "screenshotBytes"], "V3 manifest bounds");
  assertion(manifest.schemaVersion === 1 && manifest.recordType === "rf-monitor-v3-packaged-browser-manifest" && manifest.gate === "V3"
    && manifest.writtenBeforeBrowserCapture === true && manifest.server?.packaged === true && manifest.server?.dataDomain === "test" && manifest.server?.simulation === true && manifest.server?.host === "127.0.0.1",
  "V3 manifest semantics are invalid");
  safeId(manifest.runId, "V3 manifest run ID");
  assertion(/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(String(manifest.origin ?? "")) && /^[a-f0-9]{64}$/.test(String(manifest.configurationSha256 ?? ""))
    && Number.isSafeInteger(manifest.maximumDurationMs) && manifest.maximumDurationMs >= 60_000 && manifest.maximumDurationMs <= 3_600_000
    && sha256Canonical(manifest.bounds) === sha256Canonical({ captureBytes: MAX_CAPTURE_BYTES, jsonBytes: MAX_JSON_BYTES, screenshotBytes: MAX_SCREENSHOT_BYTES, bundleBytes: MAX_BUNDLE_BYTES }),
  "V3 manifest origin, configuration, duration, or bounds are invalid");
  assertion(/^[a-f0-9]{64}$/.test(String(manifest.configurationSources?.catalogSha256 ?? ""))
    && /^[a-f0-9]{64}$/.test(String(manifest.configurationSources?.operationalSha256 ?? "")), "V3 manifest configuration source hashes are invalid");
  assertion(manifest.surfaceMatrixSha256 === sha256Canonical(V3_SURFACE_CASES) && manifest.workflowMatrixSha256 === sha256Canonical(V3_WORKFLOW_CASES)
    && sha256Canonical(manifest.surfaceCases) === sha256Canonical(V3_SURFACE_CASES) && sha256Canonical(manifest.workflowCases) === sha256Canonical(V3_WORKFLOW_CASES),
  "V3 manifest matrices are invalid");
  exactKeys(report, ["accessibility", "browserCapture", "completedAt", "configurationSha256", "fieldIsolation", "gate", "limitations", "manifestSha256", "operatorWorkflowsPassed", "packaged", "recordType", "release", "releaseBinding", "result", "schemaVersion", "screenshots"], "V3 report");
  exactKeys(report.releaseBinding, ["after", "before", "unchanged"], "V3 report release binding");
  exactKeys(report.result, ["downstreamGates", "gateDecision", "liveHardwareQualification", "productionReady", "softwareQualificationOnly"], "V3 report result");
  exactKeys(report.result.downstreamGates, ["V5", "V6", "V7"], "V3 downstream gates");
  exactKeys(report.accessibility, ["incomplete", "seriousOrCritical", "violations"], "V3 accessibility summary");
  exactKeys(report.fieldIsolation, ["treeAfter", "treeBefore", "unchanged"], "V3 field isolation");
  exactKeys(report.fieldIsolation.treeBefore, ["bytes", "entries", "sha256"], "V3 field tree before");
  exactKeys(report.fieldIsolation.treeAfter, ["bytes", "entries", "sha256"], "V3 field tree after");
  assertion(report.schemaVersion === 1 && report.recordType === "rf-monitor-v3-packaged-browser-result" && report.gate === "V3" && report.packaged === true
    && report.result?.gateDecision === "passed" && report.result?.softwareQualificationOnly === true && report.result?.productionReady === false
    && report.result?.liveHardwareQualification === "not-run" && sha256Canonical(report.result?.downstreamGates) === sha256Canonical({ V5: "not-run", V6: "not-run", V7: "not-run" }),
  "V3 result scope is invalid");
  exactStringArray(report.limitations, V3_LIMITATIONS, "V3 limitations");
  assertion(report.manifestSha256 === sha256(manifestContents), "V3 report does not bind the manifest");
  sameRelease(manifest.release, report.release, "V3 bundle release");
  sameRelease(report.releaseBinding?.before, report.releaseBinding?.after, "V3 release binding");
  sameRelease(report.releaseBinding?.after, report.release, "V3 result release");
  assertion(report.releaseBinding?.unchanged === true && report.configurationSha256 === manifest.configurationSha256, "V3 candidate/configuration binding is invalid");
  assertion(report.accessibility?.violations === 0 && report.accessibility?.seriousOrCritical === 0 && report.accessibility?.incomplete === 0
    && report.operatorWorkflowsPassed === true && report.fieldIsolation?.unchanged === true,
  "V3 pass evidence is incomplete");
  assertion(sha256Canonical(report.fieldIsolation.treeBefore) === sha256Canonical(report.fieldIsolation.treeAfter)
    && /^[a-f0-9]{64}$/.test(String(report.fieldIsolation.treeBefore?.sha256 ?? "")), "V3 field-domain isolation binding is invalid");

  const validation = await validateV3BrowserCapture({
    capture: report.browserCapture,
    expected: {
      runId: manifest.runId,
      origin: manifest.origin,
      release: manifest.release,
      configurationSha256: manifest.configurationSha256,
      serverStartedAt: manifest.createdAt,
      maximumDurationMs: manifest.maximumDurationMs,
    },
    screenshotRoot: screenshotDirectory,
  });
  assertion(sha256Canonical(validation.screenshots) === sha256Canonical(report.screenshots), "V3 screenshot report is inconsistent");
  return { valid: true, gate: "V3", result: "passed", buildId: report.release.buildId, screenshots: screenshotNames.length };
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assertion(address && typeof address !== "string", "Unable to allocate a V3 loopback port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function exactInputFile(filePath, label, maximumBytes = MAX_JSON_BYTES) {
  const resolved = path.resolve(filePath);
  const details = await lstat(resolved);
  assertion(details.isFile() && !details.isSymbolicLink() && details.size > 0 && details.size <= maximumBytes, `${label} is missing, linked, or outside its byte bound`);
  assertion(await realpath(resolved) === resolved, `${label} may not use symlinked path components`);
  return resolved;
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length <= 128 * 1024 ? next : next.slice(next.length - 128 * 1024);
}

function startPackagedServer(sandbox, port, configuration) {
  const child = spawn(nodeExecutable, [serverExecutable], {
    cwd: sandbox,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NODE_OPTIONS: "--max-old-space-size=384",
      RF_MONITOR_SIMULATION: "on",
      RF_MONITOR_SYNTHETIC_EXERCISES: "false",
      RF_MONITOR_HOST: "127.0.0.1",
      RF_MONITOR_PORT: String(port),
      RF_MONITOR_STORAGE: path.join(sandbox, "control"),
      RF_MONITOR_FIELD_DATA_ROOT: path.join(sandbox, "field"),
      RF_MONITOR_TEST_DATA_ROOT: path.join(sandbox, "test"),
      RF_MONITOR_CATALOG_FILE: configuration.catalogPath,
      RF_MONITOR_OPERATIONAL_FILE: configuration.operationalPath,
      RF_MONITOR_MIN_FREE_BYTES: "0",
      RF_MONITOR_STORAGE_MAX_BYTES: "268435456",
      RF_MONITOR_SESSION_MAX_BYTES: "134217728",
      RF_MONITOR_MAINTENANCE_INTERVAL_MS: "600000",
      RF_MONITOR_RECOVERY_REQUEST: path.join(sandbox, "run", "recover-sdrconnect"),
      RF_MONITOR_APPLICATION_RESTART_REQUEST: path.join(sandbox, "run", "restart-application"),
      RFMON_RECOVERY_STATUS_FILE: path.join(sandbox, "run", "receiver-status.json"),
      RFMON_APPLICATION_RECOVERY_STATUS_FILE: path.join(sandbox, "run", "application-status.json"),
      SDRCONNECT_URL: "ws://127.0.0.1:9/",
      SDRCONNECT_SAMPLE_RATE_HZ: "10000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout = appendBounded(output.stdout, chunk.toString()); });
  child.stderr.on("data", (chunk) => { output.stderr = appendBounded(output.stderr, chunk.toString()); });
  return { child, output };
}

async function stopServer(state) {
  if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
  state.child.kill("SIGTERM");
  await Promise.race([once(state.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("V3 packaged server did not stop")), 30_000))]);
  assertion(state.child.exitCode === 0 && state.child.signalCode === null, `V3 packaged server exited with ${state.child.exitCode ?? state.child.signalCode}`);
}

async function waitForServer(state, origin) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (state.child.exitCode !== null || state.child.signalCode !== null) throw new Error(`V3 packaged server exited early: ${state.output.stderr}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("V3 packaged server startup timed out");
}

async function hashBoundedTree(root) {
  const digest = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  async function visit(current, relative = "") {
    const details = await lstat(current);
    assertion(!details.isSymbolicLink(), "V3 trust-domain tree contains a symlink");
    entries += 1;
    assertion(entries <= 1_024, "V3 trust-domain tree exceeds its entry bound");
    if (details.isDirectory()) {
      digest.update(`directory\0${relative}\0`);
      for (const name of (await readdir(current)).sort()) await visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      return;
    }
    assertion(details.isFile(), "V3 trust-domain tree contains a non-file entry");
    bytes += details.size;
    assertion(bytes <= 16 * 1024 * 1024, "V3 trust-domain tree exceeds its byte bound");
    const contents = await readFile(current);
    digest.update(`file\0${relative}\0${contents.byteLength}\0`);
    digest.update(contents);
  }
  await visit(root);
  return { sha256: digest.digest("hex"), entries, bytes };
}

async function waitForCapture(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const details = await lstat(filePath);
      assertion(details.isFile() && !details.isSymbolicLink() && details.size > 0 && details.size <= MAX_CAPTURE_BYTES, "V3 capture file is invalid or exceeds its bound");
      assertion(await realpath(filePath) === path.resolve(filePath), "V3 capture file may not use symlinked path components");
      const first = await readFile(filePath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const secondDetails = await lstat(filePath);
      const second = await readFile(filePath);
      if (details.size === secondDetails.size && details.mtimeMs === secondDetails.mtimeMs && sha256(first) === sha256(second)) return JSON.parse(second.toString("utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the V3 browser capture file");
}

function createRunnerCleanup({ sandbox, keepTemp, getServer }) {
  let promise;
  return () => {
    promise ??= (async () => {
      await stopServer(getServer()).catch(async () => {
        const state = getServer();
        if (state?.child.exitCode === null && state?.child.signalCode === null) state.child.kill("SIGKILL");
      });
      if (!keepTemp) await rm(sandbox, { recursive: true, force: true });
    })();
    return promise;
  };
}

function installCleanupHandlers() {
  let handling = false;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = async () => {
      if (handling) return;
      handling = true;
      await Promise.allSettled([...activeCleanups].map((cleanup) => cleanup()));
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}

export async function runV3Qualification(options) {
  assertion(process.execPath === nodeExecutable, `V3 qualification requires ${nodeExecutable}`);
  const capturePath = path.resolve(options.capture);
  const preexisting = await lstat(capturePath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  assertion(!preexisting, "V3 capture file already exists; use a new path so evidence cannot predate the server run");
  for (const required of [nodeExecutable, serverExecutable]) assertion((await stat(required).catch(() => undefined))?.isFile(), `Packaged V3 prerequisite is missing: ${required}. Run npm run build first.`);
  const catalogPath = await exactInputFile(options.catalog, "V3 catalog");
  const operationalPath = await exactInputFile(options.operational, "V3 operational profile");
  const releaseBefore = await validateV3Candidate();
  const runId = safeId(`v3-${safeTimestamp()}-${randomUUID()}`, "V3 run ID");
  const outputDirectory = path.resolve(options.output ?? path.join(repositoryRoot, "artifacts/validation/v3", `${runId}-${releaseBefore.buildId}`));
  assertion(!await lstat(outputDirectory).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error)), "V3 output already exists; immutable bundles cannot be overwritten");
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v3-"));
  let serverState;
  const cleanup = createRunnerCleanup({ sandbox, keepTemp: options.keepTemp, getServer: () => serverState });
  activeCleanups.add(cleanup);
  try {
    const fieldSentinel = path.join(sandbox, "field", "v3-field-must-remain-unchanged.txt");
    await mkdir(path.dirname(fieldSentinel), { recursive: true });
    await writeFile(fieldSentinel, "V3 browser qualification must never write field data.\n", { mode: 0o440 });
    const fieldTreeBefore = await hashBoundedTree(path.dirname(fieldSentinel));
    const port = options.port ?? await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const serverStartedAt = new Date().toISOString();
    serverState = startPackagedServer(sandbox, port, { catalogPath, operationalPath });
    await waitForServer(serverState, origin);
    const healthResponse = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5_000) });
    const health = await healthResponse.json();
    assertion(healthResponse.headers.get("x-rf-monitor-build-id") === releaseBefore.buildId, "V3 server header does not match the candidate build");
    assertion(health.schemaVersion === 2 && health.dataDomain?.active === "test" && health.summary?.state === "simulation", "V3 server is not isolated in Simulation/Test");
    const runtimeRelease = health.identity?.release;
    sameRelease(Object.fromEntries(RELEASE_FIELDS.map((field) => [field, runtimeRelease?.[field]])), releaseBefore, "V3 packaged server release");
    assertion(runtimeRelease?.serverBuildId === releaseBefore.buildId && runtimeRelease?.clientBuildId === releaseBefore.buildId && runtimeRelease?.integrity === "release-metadata", "V3 packaged server client/server identity is not exact");
    const snapshotResponse = await fetch(`${origin}/api/snapshot`, { signal: AbortSignal.timeout(5_000) });
    const snapshot = await snapshotResponse.json();
    const configurationSha256 = snapshot.configuration?.configurationHash;
    assertion(/^[a-f0-9]{64}$/.test(String(configurationSha256 ?? "")), "V3 packaged configuration identity is unavailable");
    const maximumDurationMs = options.timeoutSeconds * 1_000;
    const configurationSources = {
      catalogSha256: sha256(await readFile(catalogPath)),
      operationalSha256: sha256(await readFile(operationalPath)),
    };
    const manifest = createV3Manifest({ runId, createdAt: serverStartedAt, release: releaseBefore, origin, configurationSha256, configurationSources, maximumDurationMs });
    const manifestContents = jsonBuffer(manifest);
    const commitmentPath = path.join(sandbox, "v3-manifest.json");
    await writeFile(commitmentPath, manifestContents, { flag: "wx", mode: 0o440 });
    process.stdout.write(`${JSON.stringify({
      state: "ready",
      runId,
      captureUrl: `${origin}/?qa=v3&qualification=${runId}`,
      capturePath,
      buildId: releaseBefore.buildId,
      configurationSha256,
      viewports: V3_VIEWPORTS,
      surfaceCases: V3_SURFACE_CASES,
      workflowCases: V3_WORKFLOW_CASES,
    }, null, 2)}\n`);
    const capture = await waitForCapture(capturePath, maximumDurationMs);
    const validation = await validateV3BrowserCapture({
      capture,
      expected: { runId, origin, release: releaseBefore, configurationSha256, serverStartedAt, maximumDurationMs },
      screenshotRoot: path.dirname(capturePath),
    });
    await stopServer(serverState);
    serverState = undefined;
    const fieldTreeAfter = await hashBoundedTree(path.dirname(fieldSentinel));
    assertion(sha256Canonical(fieldTreeAfter) === sha256Canonical(fieldTreeBefore), "V3 browser run mutated the field trust domain");
    const releaseAfter = await validateV3Candidate();
    sameRelease(releaseBefore, releaseAfter, "V3 candidate");
    assertion(sha256(await readFile(commitmentPath)) === sha256(manifestContents), "V3 pre-capture manifest changed");
    const report = createV3Report({
      manifest,
      manifestSha256: sha256(manifestContents),
      releaseAfter,
      capture,
      validation,
      fieldIsolation: { treeBefore: fieldTreeBefore, treeAfter: fieldTreeAfter, unchanged: true },
      completedAt: new Date().toISOString(),
    });
    const destination = await publishV3Bundle({ outputDirectory, manifest, report, screenshotRoot: path.dirname(capturePath) });
    process.stdout.write(`${JSON.stringify({ state: "passed", gate: "V3", destination, productionReady: false }, null, 2)}\n`);
    return { destination, manifest, report };
  } finally {
    await cleanup();
    activeCleanups.delete(cleanup);
  }
}

async function main(arguments_) {
  const parsed = parseV3Arguments(arguments_);
  if (parsed.help) {
    process.stdout.write(V3_HELP);
    return;
  }
  if (parsed.verifyBundle) {
    process.stdout.write(`${JSON.stringify(await verifyV3Bundle(parsed.verifyBundle), null, 2)}\n`);
    return;
  }
  const uninstall = installCleanupHandlers();
  try { await runV3Qualification(parsed); } finally { uninstall(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
