import axe, { type Result, type RunOptions } from "axe-core";

type AxeImpact = Result["impact"];

export interface AccessibilityFinding {
  id: string;
  impact: AxeImpact;
  help: string;
  helpUrl: string;
  targets: string[][];
}

export interface AccessibilityHarnessResult {
  state: "starting" | "running" | "ready" | "error";
  axeVersion: string;
  scannedAt?: string;
  seriousOrCritical: number;
  violations: AccessibilityFinding[];
  incomplete: AccessibilityFinding[];
  error?: string;
}

declare global {
  interface Window {
    __RF_MONITOR_ACCESSIBILITY__?: AccessibilityHarnessResult;
    __RF_MONITOR_RUN_ACCESSIBILITY__?: () => Promise<AccessibilityHarnessResult>;
  }
}

const RUN_OPTIONS: RunOptions = {
  resultTypes: ["violations", "incomplete"],
};

function boundedFinding(result: Result): AccessibilityFinding {
  return {
    id: result.id.slice(0, 80),
    impact: result.impact,
    help: result.help.slice(0, 240),
    helpUrl: result.helpUrl.slice(0, 500),
    targets: result.nodes.slice(0, 8).map((node) => node.target.slice(0, 4).map((target) => String(target).slice(0, 240))),
  };
}

function boundedError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function publish(report: AccessibilityHarnessResult): AccessibilityHarnessResult {
  window.__RF_MONITOR_ACCESSIBILITY__ = report;
  document.documentElement.setAttribute("data-rf-monitor-accessibility", JSON.stringify(report));
  return report;
}

export function startAccessibilityHarness(): void {
  if (window.__RF_MONITOR_RUN_ACCESSIBILITY__) return;
  publish({
    state: "starting",
    axeVersion: axe.version,
    seriousOrCritical: 0,
    violations: [],
    incomplete: [],
  });
  let active: Promise<AccessibilityHarnessResult> | undefined;
  const scan = (): Promise<AccessibilityHarnessResult> => {
    if (active) return active;
    publish({
      ...(window.__RF_MONITOR_ACCESSIBILITY__!),
      state: "running",
    });
    active = axe.run(document, RUN_OPTIONS).then((result) => {
      const violations = result.violations.slice(0, 128).map(boundedFinding);
      const incomplete = result.incomplete.slice(0, 128).map(boundedFinding);
      const report: AccessibilityHarnessResult = {
        state: "ready",
        axeVersion: axe.version,
        scannedAt: new Date().toISOString(),
        seriousOrCritical: violations.filter((item) => item.impact === "serious" || item.impact === "critical").length,
        violations,
        incomplete,
      };
      return publish(report);
    }).catch((reason) => {
      const report: AccessibilityHarnessResult = {
        state: "error",
        axeVersion: axe.version,
        scannedAt: new Date().toISOString(),
        seriousOrCritical: 0,
        violations: [],
        incomplete: [],
        error: boundedError(reason),
      };
      return publish(report);
    }).finally(() => {
      active = undefined;
    });
    return active;
  };
  window.__RF_MONITOR_RUN_ACCESSIBILITY__ = scan;
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.altKey && event.code === "KeyA") void scan();
  });
  window.setTimeout(() => void scan(), 1_500);
}
