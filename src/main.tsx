import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { AccessibilityHarnessResult } from "./client/accessibilityHarness";
import { startV3BrowserHarness } from "./client/v3BrowserHarness";
import "./styles.css";

const qaMode = new URLSearchParams(location.search).get("qa");
if (qaMode === "v3") startV3BrowserHarness();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The release-candidate browser gate runs axe against the exact built UI.
// The scanner is a dormant, query-gated chunk and never runs in normal use.
if (qaMode === "accessibility" || qaMode === "v3") {
  const startingAccessibilityReport: AccessibilityHarnessResult = {
    state: "starting",
    axeVersion: "loading",
    seriousOrCritical: 0,
    violations: [],
    incomplete: [],
  };
  window.__RF_MONITOR_ACCESSIBILITY__ = startingAccessibilityReport;
  document.documentElement.setAttribute("data-rf-monitor-accessibility", JSON.stringify(startingAccessibilityReport));
  void import("./client/accessibilityHarness")
    .then(({ startAccessibilityHarness }) => {
      startAccessibilityHarness();
    })
    .catch((reason: unknown) => {
      const failedAccessibilityReport: AccessibilityHarnessResult = {
        state: "error",
        axeVersion: "unavailable",
        seriousOrCritical: 0,
        violations: [],
        incomplete: [],
        error: (reason instanceof Error ? reason.message : String(reason)).replace(/[\r\n]+/g, " ").slice(0, 500),
      };
      window.__RF_MONITOR_ACCESSIBILITY__ = failedAccessibilityReport;
      document.documentElement.setAttribute("data-rf-monitor-accessibility", JSON.stringify(failedAccessibilityReport));
    });
}
