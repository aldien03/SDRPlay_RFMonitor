import type { AccessibilityHarnessResult } from "./accessibilityHarness";

export const V3_BROWSER_QA_SCHEMA_VERSION = 1;
export const MAX_V3_RUNTIME_EVENTS = 32;
export const MAX_V3_REQUEST_PATHS = 24;
export const MAX_V3_WINDOWS = 24;

export type V3BrowserQaSeverity = "error" | "warning";

export interface V3BrowserQaIssue {
  code: string;
  severity: V3BrowserQaSeverity;
  detail: string;
}

export interface V3BrowserQaRuntimeEvent {
  kind: "error" | "unhandled-rejection";
  at: string;
  message: string;
}

export interface V3BrowserQaPathCounters {
  started: number;
  completed: number;
  aborted: number;
  failed: number;
  active: number;
  maxConcurrent: number;
}

export type V3HealthPollingExpectation = "active" | "stopped" | "ignore";

export interface V3BrowserQaWindow {
  label: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  visibility: DocumentVisibilityState;
  expectedHealthPolling: V3HealthPollingExpectation;
  health: V3BrowserQaPathCounters;
  issues: V3BrowserQaIssue[];
}

export interface V3BrowserQaFacts {
  route: string;
  surface?: string;
  rootFound: boolean;
  meaningfulTextLength: number;
  viewportWidth: number;
  viewportHeight: number;
  documentClientWidth: number;
  documentScrollWidth: number;
  frameworkOverlay: boolean;
  dataMode?: "field" | "test";
  modeLabel?: string;
  monitoringState?: string;
  monitoringLabel?: string;
  connectionError: boolean;
  dialogCount: number;
  dialogHasAccessibleName: boolean;
  focusInsideTopDialog: boolean;
  protectedConfirmationPresent: boolean;
  protectedActionButtonPresent: boolean;
  protectedConfirmationMatches: boolean;
  protectedActionSafelyDisabled: boolean;
  protectedRetentionCopyPresent: boolean;
  helpTaskIds: string[];
  helpHasVersion: boolean;
  externalResourceCount: number;
}

export interface V3BrowserQaSnapshot {
  schemaVersion: typeof V3_BROWSER_QA_SCHEMA_VERSION;
  state: "ready";
  startedAt: string;
  capturedAt: string;
  clientBuildId?: string;
  qualificationRunId?: string;
  facts: V3BrowserQaFacts;
  issues: V3BrowserQaIssue[];
  runtimeEvents: V3BrowserQaRuntimeEvent[];
  requests: {
    total: V3BrowserQaPathCounters;
    byPath: Record<string, V3BrowserQaPathCounters>;
  };
  windows: V3BrowserQaWindow[];
  accessibility?: {
    state: string;
    axeVersion?: string;
    seriousOrCritical?: number;
    violationCount?: number;
    incompleteCount?: number;
  };
}

interface ActiveWindow {
  label: string;
  startedMs: number;
  visibility: DocumentVisibilityState;
  expectedHealthPolling: V3HealthPollingExpectation;
  health: V3BrowserQaPathCounters;
}

declare global {
  interface Window {
    __RF_MONITOR_V3_QA__?: V3BrowserQaSnapshot;
    __RF_MONITOR_V3_BEGIN_WINDOW__?: (
      label: string,
      expectedHealthPolling?: V3HealthPollingExpectation,
    ) => V3BrowserQaSnapshot;
    __RF_MONITOR_V3_END_WINDOW__?: (label: string) => V3BrowserQaSnapshot;
    __RF_MONITOR_V3_RUN_CHECKS__?: () => V3BrowserQaSnapshot;
  }
}

const ZERO_COUNTERS: V3BrowserQaPathCounters = {
  started: 0,
  completed: 0,
  aborted: 0,
  failed: 0,
  active: 0,
  maxConcurrent: 0,
};

function cloneCounters(value: V3BrowserQaPathCounters | undefined): V3BrowserQaPathCounters {
  return value ? { ...value } : { ...ZERO_COUNTERS };
}

function boundedText(value: unknown, maximum = 240): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function boundedRuntimeText(value: unknown): string {
  return boundedText(value, 1_000)
    .replace(/\b(?:https?|wss?):\/\/\S+/gi, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[address]")
    .replace(/\/(?:home|opt|var|etc|tmp)\/\S+/g, "[path]")
    .slice(0, 500);
}

function boundedLabel(value: unknown): string {
  const label = boundedText(value, 80);
  return label || "unnamed-window";
}

function requestPath(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return "external";
    return url.pathname.slice(0, 160) || "/";
  } catch {
    return "invalid";
  }
}

/**
 * Applies the V3 polling contract to one explicit observation window. The
 * allowance is intentionally wider than the two/ten-second product cadence so
 * a visibility transition or one operator refresh is not misreported as
 * growth. Persistent duplicate loops and requests after unmount still fail.
 */
export function evaluateV3HealthPollingWindow(
  durationMs: number,
  visibility: DocumentVisibilityState,
  expectation: V3HealthPollingExpectation,
  health: V3BrowserQaPathCounters,
): V3BrowserQaIssue[] {
  const issues: V3BrowserQaIssue[] = [];
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return [{ code: "polling-window-invalid", severity: "error", detail: "Polling window duration is invalid." }];
  }
  if (expectation === "ignore") return issues;
  if (expectation === "stopped") {
    if (health.started !== 0) issues.push({
      code: "health-polling-after-unmount",
      severity: "error",
      detail: `${health.started} health request${health.started === 1 ? "" : "s"} started after diagnostics closed.`,
    });
    return issues;
  }
  if (durationMs < 8_000) issues.push({
    code: "polling-window-too-short",
    severity: "warning",
    detail: "Observe diagnostics polling for at least 8 seconds.",
  });
  const minimumIntervalMs = visibility === "hidden" ? 7_500 : 1_500;
  const maximumStarts = 2 + Math.ceil(durationMs / minimumIntervalMs);
  if (health.started === 0) issues.push({
    code: "health-polling-missing",
    severity: "error",
    detail: "No health request was observed while diagnostics was open.",
  });
  if (health.started > maximumStarts) issues.push({
    code: "health-polling-rate-growth",
    severity: "error",
    detail: `${health.started} health requests exceeded the ${maximumStarts}-request bound for this window.`,
  });
  if (health.maxConcurrent > 2) issues.push({
    code: "health-polling-concurrency",
    severity: "error",
    detail: `${health.maxConcurrent} health requests overlapped; stale requests are not being coalesced.`,
  });
  if (health.failed > 0) issues.push({
    code: "health-polling-failed",
    severity: "error",
    detail: `${health.failed} health request${health.failed === 1 ? "" : "s"} failed.`,
  });
  return issues;
}

export function evaluateV3BrowserFacts(facts: V3BrowserQaFacts): V3BrowserQaIssue[] {
  const issues: V3BrowserQaIssue[] = [];
  if (!facts.rootFound || facts.meaningfulTextLength < 20) issues.push({
    code: "app-shell-missing",
    severity: "error",
    detail: "The packaged application did not render a meaningful RF Monitor surface.",
  });
  const overflow = Math.max(0, facts.documentScrollWidth - facts.documentClientWidth);
  if (overflow > 1) issues.push({
    code: "horizontal-overflow",
    severity: "error",
    detail: `The document overflows the viewport by ${overflow}px.`,
  });
  if (facts.frameworkOverlay) issues.push({
    code: "framework-error-overlay",
    severity: "error",
    detail: "A framework error overlay is visible.",
  });
  if (facts.dataMode === "test" && !/simulation|test/i.test(facts.modeLabel ?? "")) issues.push({
    code: "test-mode-not-visible",
    severity: "error",
    detail: "The current Test domain is not visibly labelled Simulation/Test.",
  });
  if (facts.dataMode === "field" && /simulation|test/i.test(facts.modeLabel ?? "")) issues.push({
    code: "field-mode-mislabeled",
    severity: "error",
    detail: "The current Field domain is visibly labelled as Simulation/Test.",
  });
  if ((facts.connectionError || facts.monitoringState === "data-late") && /^normal$/i.test(facts.monitoringLabel ?? "")) issues.push({
    code: "stale-normal",
    severity: "error",
    detail: "The browser shows Normal while canonical data is late or disconnected.",
  });
  if (facts.dialogCount > 0 && !facts.dialogHasAccessibleName) issues.push({
    code: "dialog-name-missing",
    severity: "error",
    detail: "The top dialog has no accessible name.",
  });
  if (facts.dialogCount > 0 && !facts.focusInsideTopDialog) issues.push({
    code: "dialog-focus-escaped",
    severity: "error",
    detail: "Keyboard focus is outside the top dialog.",
  });
  if (facts.protectedConfirmationPresent && !facts.protectedActionSafelyDisabled) issues.push({
    code: "protected-action-enabled-without-confirmation",
    severity: "error",
    detail: "A protected action is enabled before its exact confirmation matches.",
  });
  if (facts.protectedConfirmationPresent && !facts.protectedActionButtonPresent) issues.push({
    code: "protected-action-button-missing",
    severity: "error",
    detail: "The protected confirmation has no guarded action button.",
  });
  if (facts.protectedConfirmationPresent && !facts.protectedRetentionCopyPresent) issues.push({
    code: "protected-action-scope-missing",
    severity: "error",
    detail: "The protected action does not state what is retained.",
  });
  if (facts.surface === "help") {
    const required = ["alert", "data", "recording", "learning", "test"];
    const missing = required.filter((id) => !facts.helpTaskIds.includes(id));
    if (missing.length) issues.push({
      code: "help-task-missing",
      severity: "error",
      detail: `Help is missing task${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
    });
    if (!facts.helpHasVersion) issues.push({
      code: "help-version-missing",
      severity: "error",
      detail: "Help does not show the packaged version and build.",
    });
    if (facts.externalResourceCount > 0) issues.push({
      code: "help-external-resource",
      severity: "error",
      detail: `Help loaded ${facts.externalResourceCount} external resource${facts.externalResourceCount === 1 ? "" : "s"}.`,
    });
  }
  return issues.slice(0, 64);
}

function accessibleNamePresent(dialog: HTMLElement | undefined): boolean {
  if (!dialog) return true;
  const direct = dialog.getAttribute("aria-label")?.trim();
  if (direct) return true;
  const labelledBy = dialog.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean) ?? [];
  return labelledBy.some((id) => document.getElementById(id)?.textContent?.trim());
}

function currentFacts(): V3BrowserQaFacts {
  const qaMode = new URLSearchParams(location.search).get("qa");
  const root = document.querySelector<HTMLElement>("[data-rf-monitor-surface], .mission-app, .settings-page, .help-page");
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const topDialog = dialogs.at(-1);
  const confirmation = topDialog?.querySelector<HTMLInputElement>("#maintenance-confirmation");
  const confirmationLabel = confirmation
    ? topDialog?.querySelector<HTMLLabelElement>(`label[for="${confirmation.id}"]`)?.textContent ?? ""
    : "";
  const expectedConfirmation = confirmationLabel.match(/\bType\s+(.+?)\s*$/i)?.[1]?.trim() ?? "";
  const destructive = topDialog?.querySelector<HTMLButtonElement>("button.danger");
  const protectedConfirmationMatches = Boolean(confirmation && expectedConfirmation && confirmation.value === expectedConfirmation);
  const protectedActionSafelyDisabled = !confirmation || !destructive
    ? true
    : destructive.disabled || protectedConfirmationMatches;
  const performanceEntries = typeof performance?.getEntriesByType === "function"
    ? performance.getEntriesByType("resource")
    : [];
  const externalResourceCount = performanceEntries.filter((entry) => {
    try { return new URL(entry.name, location.href).origin !== location.origin; } catch { return false; }
  }).length;
  const modeLabel = document.querySelector<HTMLElement>(".mission-receiver, .settings-runtime-context span:first-child strong, [data-rf-help-mode]")?.textContent?.trim();
  const monitoringLabel = document.querySelector<HTMLElement>(".mission-monitoring strong, .help-intro h1")?.textContent?.trim();
  return {
    route: `${location.pathname}${qaMode ? `?qa=${encodeURIComponent(qaMode)}` : ""}`.slice(0, 500),
    surface: root?.dataset.rfMonitorSurface,
    rootFound: Boolean(root),
    meaningfulTextLength: Math.min(10_000, root?.innerText.trim().length ?? 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    frameworkOverlay: Boolean(document.querySelector("vite-error-overlay, #webpack-dev-server-client-overlay, [data-nextjs-dialog-overlay]")),
    dataMode: root?.dataset.rfDataMode === "field" || root?.dataset.rfDataMode === "test" ? root.dataset.rfDataMode : undefined,
    modeLabel,
    monitoringState: root?.dataset.rfMonitoringState,
    monitoringLabel,
    connectionError: Boolean(document.querySelector(".mission-connection-error")),
    dialogCount: dialogs.length,
    dialogHasAccessibleName: accessibleNamePresent(topDialog),
    focusInsideTopDialog: !topDialog || (document.activeElement instanceof Node && topDialog.contains(document.activeElement)),
    protectedConfirmationPresent: Boolean(confirmation),
    protectedActionButtonPresent: Boolean(destructive),
    protectedConfirmationMatches,
    protectedActionSafelyDisabled,
    protectedRetentionCopyPresent: !confirmation || /\bKept:/i.test(topDialog?.textContent ?? ""),
    helpTaskIds: ["alert", "data", "recording", "learning", "test"].filter((id) => Boolean(document.getElementById(id))),
    helpHasVersion: /\bVersion\s+\S+\s+·\s+Build\s+\S+/i.test(document.querySelector(".help-footer")?.textContent ?? ""),
    externalResourceCount,
  };
}

function accessibilitySummary(): V3BrowserQaSnapshot["accessibility"] {
  const value: AccessibilityHarnessResult | undefined = window.__RF_MONITOR_ACCESSIBILITY__;
  if (!value) return undefined;
  return {
    state: value.state,
    axeVersion: value.axeVersion,
    seriousOrCritical: value.seriousOrCritical,
    violationCount: value.violations.length,
    incompleteCount: value.incomplete.length,
  };
}

/**
 * Installs a dormant, query-gated packaged-browser recorder. It records only
 * same-origin request paths and bounded error text; it never captures response
 * bodies, evidence, settings, credentials, addresses, or command output.
 */
export function startV3BrowserHarness(): void {
  if (window.__RF_MONITOR_V3_RUN_CHECKS__) return;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const runtimeEvents: V3BrowserQaRuntimeEvent[] = [];
  const requestCounters = new Map<string, V3BrowserQaPathCounters>();
  const total = cloneCounters(undefined);
  const windows: V3BrowserQaWindow[] = [];
  let activeWindow: ActiveWindow | undefined;

  const pathCounters = (path: string): V3BrowserQaPathCounters => {
    const known = requestCounters.get(path);
    if (known) return known;
    const key = requestCounters.size < MAX_V3_REQUEST_PATHS - 1 ? path : "other";
    const existing = requestCounters.get(key);
    if (existing) return existing;
    const created = cloneCounters(undefined);
    requestCounters.set(key, created);
    return created;
  };

  const addRuntimeEvent = (kind: V3BrowserQaRuntimeEvent["kind"], message: unknown) => {
    runtimeEvents.push({ kind, at: new Date().toISOString(), message: boundedRuntimeText(message) || "Unknown browser error" });
    if (runtimeEvents.length > MAX_V3_RUNTIME_EVENTS) runtimeEvents.splice(0, runtimeEvents.length - MAX_V3_RUNTIME_EVENTS);
  };
  window.addEventListener("error", (event) => addRuntimeEvent("error", event.message));
  window.addEventListener("unhandledrejection", (event) => addRuntimeEvent("unhandled-rejection", event.reason instanceof Error ? event.reason.message : event.reason));

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = requestPath(input);
    const counters = pathCounters(key);
    const requestWindow = key === "/api/health" ? activeWindow : undefined;
    counters.started += 1;
    counters.active += 1;
    counters.maxConcurrent = Math.max(counters.maxConcurrent, counters.active);
    total.started += 1;
    total.active += 1;
    total.maxConcurrent = Math.max(total.maxConcurrent, total.active);
    if (requestWindow) {
      requestWindow.health.started += 1;
      requestWindow.health.active += 1;
      requestWindow.health.maxConcurrent = Math.max(requestWindow.health.maxConcurrent, requestWindow.health.active);
    }
    try {
      const response = await originalFetch(input, init);
      counters.completed += 1;
      total.completed += 1;
      if (requestWindow) requestWindow.health.completed += 1;
      return response;
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === "AbortError";
      if (aborted) {
        counters.aborted += 1;
        total.aborted += 1;
        if (requestWindow) requestWindow.health.aborted += 1;
      } else {
        counters.failed += 1;
        total.failed += 1;
        if (requestWindow) requestWindow.health.failed += 1;
      }
      throw reason;
    } finally {
      counters.active = Math.max(0, counters.active - 1);
      total.active = Math.max(0, total.active - 1);
      if (requestWindow) requestWindow.health.active = Math.max(0, requestWindow.health.active - 1);
    }
  }) as typeof window.fetch;

  const snapshot = (): V3BrowserQaSnapshot => {
    const facts = currentFacts();
    const issues = [
      ...evaluateV3BrowserFacts(facts),
      ...runtimeEvents.map((event): V3BrowserQaIssue => ({
        code: event.kind === "error" ? "runtime-error" : "unhandled-rejection",
        severity: "error",
        detail: event.message,
      })),
      ...windows.flatMap((window) => evaluateV3HealthPollingWindow(
        window.durationMs ?? 0,
        window.visibility,
        window.expectedHealthPolling,
        window.health,
      )),
    ].slice(0, 64);
    const report: V3BrowserQaSnapshot = {
      schemaVersion: V3_BROWSER_QA_SCHEMA_VERSION,
      state: "ready",
      startedAt,
      capturedAt: new Date().toISOString(),
      clientBuildId: document.querySelector<HTMLMetaElement>('meta[name="rf-monitor-client-build-id"]')?.content.trim() || undefined,
      qualificationRunId: new URLSearchParams(location.search).get("qualification")?.trim().slice(0, 128) || undefined,
      facts,
      issues,
      runtimeEvents: runtimeEvents.map((event) => ({ ...event })),
      requests: {
        total: cloneCounters(total),
        byPath: Object.fromEntries([...requestCounters.entries()].map(([key, value]) => [key, cloneCounters(value)])),
      },
      windows: windows.map((window) => ({
        ...window,
        health: cloneCounters(window.health),
        issues: evaluateV3HealthPollingWindow(window.durationMs ?? 0, window.visibility, window.expectedHealthPolling, window.health),
      })),
      accessibility: accessibilitySummary(),
    };
    window.__RF_MONITOR_V3_QA__ = report;
    document.documentElement.setAttribute("data-rf-monitor-v3", JSON.stringify(report));
    return report;
  };

  window.__RF_MONITOR_V3_BEGIN_WINDOW__ = (label, expectedHealthPolling = "ignore") => {
    const safeLabel = boundedLabel(label);
    if (activeWindow) throw new Error(`V3 window ${activeWindow.label} is still active`);
    activeWindow = {
      label: safeLabel,
      startedMs: Date.now(),
      visibility: document.visibilityState,
      expectedHealthPolling,
      health: cloneCounters(undefined),
    };
    return snapshot();
  };

  window.__RF_MONITOR_V3_END_WINDOW__ = (label) => {
    const safeLabel = boundedLabel(label);
    if (!activeWindow || activeWindow.label !== safeLabel) throw new Error(`V3 window ${safeLabel} is not active`);
    const completedMs = Date.now();
    const durationMs = Math.max(0, completedMs - activeWindow.startedMs);
    const health = activeWindow.health;
    const completed: V3BrowserQaWindow = {
      label: activeWindow.label,
      startedAt: new Date(activeWindow.startedMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      durationMs,
      visibility: activeWindow.visibility,
      expectedHealthPolling: activeWindow.expectedHealthPolling,
      health,
      issues: evaluateV3HealthPollingWindow(durationMs, activeWindow.visibility, activeWindow.expectedHealthPolling, health),
    };
    windows.push(completed);
    if (windows.length > MAX_V3_WINDOWS) windows.splice(0, windows.length - MAX_V3_WINDOWS);
    activeWindow = undefined;
    return snapshot();
  };

  window.__RF_MONITOR_V3_RUN_CHECKS__ = snapshot;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSnapshot = (delayMs = 50) => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      snapshot();
    }, delayMs);
  };
  document.addEventListener("click", () => scheduleSnapshot(), true);
  document.addEventListener("keydown", () => scheduleSnapshot(), true);
  document.addEventListener("input", () => scheduleSnapshot(), true);
  window.addEventListener("popstate", () => scheduleSnapshot(), true);

  let diagnosticsWindowIndex = 0;
  let diagnosticsPresent = false;
  let stoppedWindowTimer: ReturnType<typeof setTimeout> | undefined;
  const closeActiveWindow = () => {
    if (!activeWindow) return;
    window.__RF_MONITOR_V3_END_WINDOW__?.(activeWindow.label);
  };
  const syncDiagnosticsWindow = () => {
    const present = Boolean(document.querySelector("[data-rf-diagnostics-active='true']"));
    if (present === diagnosticsPresent) return;
    diagnosticsPresent = present;
    if (stoppedWindowTimer) {
      clearTimeout(stoppedWindowTimer);
      stoppedWindowTimer = undefined;
    }
    closeActiveWindow();
    diagnosticsWindowIndex += 1;
    if (present) {
      window.__RF_MONITOR_V3_BEGIN_WINDOW__?.(`health-visible-${diagnosticsWindowIndex}`, "active");
      return;
    }
    window.__RF_MONITOR_V3_BEGIN_WINDOW__?.(`health-closed-${diagnosticsWindowIndex}`, "stopped");
    stoppedWindowTimer = setTimeout(() => {
      stoppedWindowTimer = undefined;
      if (activeWindow?.expectedHealthPolling === "stopped") closeActiveWindow();
    }, 8_000);
  };
  const observer = new MutationObserver(() => {
    syncDiagnosticsWindow();
    scheduleSnapshot(100);
  });
  observer.observe(document.body, { attributes: true, characterData: true, childList: true, subtree: true });
  const accessibilityObserver = new MutationObserver(() => scheduleSnapshot(25));
  accessibilityObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-rf-monitor-accessibility"],
  });
  snapshot();
  scheduleSnapshot(100);
  setTimeout(() => {
    syncDiagnosticsWindow();
    snapshot();
  }, 2_250);
}
