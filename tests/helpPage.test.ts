import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HelpPage } from "../src/client/HelpPage";
import { resolveOperatorSummary } from "../src/shared/operatorSummary";
import type { MonitorSnapshot } from "../src/shared/types";

function snapshot(dataDomain: "field" | "test"): MonitorSnapshot {
  return {
    dataDomain,
    identity: {
      release: {
        releaseVersion: "1.0.0",
        buildId: "candidate-a",
      },
    },
    operatorSummary: resolveOperatorSummary({
      generatedAt: "2026-08-23T12:00:00.000Z",
      serverBuildId: "candidate-a",
      dataDomain,
      monitoring: {
        receiverOnline: true,
        dataFresh: true,
        paused: false,
        alertActive: false,
        recovering: false,
        candidateActive: false,
        detectingActive: false,
        checking: false,
      },
      recording: { state: "recording" },
      currentHealth: { state: dataDomain === "field" ? "normal" : "simulation" },
      productionQualification: dataDomain === "field"
        ? { state: "pending", ready: false }
        : { state: "simulation", ready: false },
      observation: { at: "2026-08-23T12:00:00.000Z", coverage: "observed" },
    }),
  } as unknown as MonitorSnapshot;
}

function render(dataDomain: "field" | "test"): string {
  const noop = vi.fn();
  return renderToStaticMarkup(createElement(HelpPage, {
    snapshot: snapshot(dataDomain),
    onClose: noop,
    onOpenHealth: noop,
    onOpenRecording: noop,
    onOpenEvidence: noop,
    onOpenEngineer: noop,
  }));
}

describe("packaged operator Help", () => {
  it("keeps Simulation/Test visible with all six offline task flows and release identity", () => {
    const markup = render("test");
    expect(markup).toContain('data-rf-monitor-surface="help"');
    expect(markup).toContain('data-rf-data-mode="test"');
    expect(markup).toMatch(/Current status · <strong[^>]*>Simulation<\/strong>/);
    for (const id of ["alert", "data", "coverage", "recording", "learning", "test"]) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup).toContain("A late survey means that signal was not observed on time. It is not an RF anomaly.");
    expect(markup).toContain("Version 1.0.0 · Build candidate-a");
    expect(markup).not.toMatch(/(?:href|src)="https?:\/\//i);
    expect(markup).not.toMatch(/sudo|systemctl|journalctl/i);
  });

  it("labels the Field trust domain instead of reusing Simulation copy", () => {
    const markup = render("field");
    expect(markup).toContain('data-rf-data-mode="field"');
    expect(markup).toMatch(/Current status · <strong[^>]*>Live field data<\/strong>/);
    expect(markup).not.toMatch(/Current status · <strong[^>]*>Simulation<\/strong>/);
  });
});
