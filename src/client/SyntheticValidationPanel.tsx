import { Download, FlaskConical } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SyntheticExerciseState } from "../shared/types";

export interface SyntheticValidationScenario {
  id: string;
  name: string;
  expectedOutcome: string;
  targetLabel?: string;
  targetCenterHz?: number;
}

export interface SyntheticValidationResult {
  pass?: boolean;
  scenarioId?: string;
  scenarioName?: string;
  observedOutcome?: string;
  expectedOutcome?: string;
  targetLabel?: string;
  targetCenterHz?: number;
  synthetic?: boolean;
  runId?: string;
}

export type SyntheticVerdictTone = "interference" | "receiver" | "unknown" | "normal" | "neutral";

export interface SyntheticVerdict {
  label: string;
  detail: string;
  tone: SyntheticVerdictTone;
}

const ALERT_DETAILS: Record<string, string> = {
  wideband: "RF energy rose across much of the band.",
  "pulsed-wideband": "Repeated RF-energy bursts were detected.",
  cw: "A strong narrow signal was detected.",
  multitone: "Several narrow signals were detected.",
  "moving-narrowband": "Moving narrowband energy was detected.",
};

type ValidationMode = "guided" | "blinded";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function getSyntheticVerdict(input: Pick<SyntheticValidationResult, "scenarioId" | "observedOutcome" | "expectedOutcome" | "pass">): SyntheticVerdict {
  const observed = input.observedOutcome;
  const expected = input.expectedOutcome;
  if (
    (observed !== "alert" && observed !== "no-alert" && observed !== "unknown")
    || (expected !== "alert" && expected !== "no-alert" && expected !== "unknown")
    || typeof input.pass !== "boolean"
  ) {
    return { label: "Result unavailable", detail: "The test did not return a valid result.", tone: "neutral" };
  }
  if (input.pass === true && observed !== expected) {
    return { label: "Result inconsistent", detail: "The report contains conflicting test results.", tone: "interference" };
  }
  if (input.pass === false) {
    if (observed === "unknown") {
      return { label: "Test inconclusive", detail: "The detector could not complete this test.", tone: "unknown" };
    }
    if (expected === "alert" && observed !== "alert") {
      return { label: "Interference not detected", detail: "The detector missed this test event.", tone: "interference" };
    }
    if (expected === "no-alert" && observed === "alert") {
      return { label: "Unexpected RF alert", detail: "The detector raised an alert on a control test.", tone: "interference" };
    }
    if (expected === "unknown" && observed === "alert") {
      return { label: "Unexpected RF alert", detail: "The detector alerted when the result should be unknown.", tone: "interference" };
    }
    if (expected === "unknown" && observed === "no-alert") {
      return { label: "Unexpected clear result", detail: "Missing or changed data was treated as clear.", tone: "interference" };
    }
    return { label: "Unexpected test result", detail: "The detector did not behave as expected.", tone: "interference" };
  }
  if (input.observedOutcome === "alert" && input.scenarioId === "overload") {
    return { label: "Receiver overloaded", detail: "The input exceeded the receiver range.", tone: "receiver" };
  }
  if (input.observedOutcome === "alert") {
    return {
      label: "Suspected RF interference",
      detail: input.scenarioId ? ALERT_DETAILS[input.scenarioId] ?? "RF energy changed from the learned pattern." : "RF energy changed from the learned pattern.",
      tone: "interference",
    };
  }
  if (input.observedOutcome === "no-alert") {
    if (input.scenarioId === "matched-power-spoofing") {
      return { label: "No RF change detected", detail: "This case is not detectable from the spectrum.", tone: "neutral" };
    }
    return { label: "No RF anomaly", detail: "Detector stayed clear.", tone: "normal" };
  }
  if (input.observedOutcome === "unknown") {
    if (input.scenarioId === "configuration-change") {
      return { label: "Test inconclusive", detail: "RF settings changed during the test.", tone: "unknown" };
    }
    if (input.scenarioId === "data-gap") {
      return { label: "Test inconclusive", detail: "RF data was missing during the test.", tone: "unknown" };
    }
    return { label: "Test inconclusive", detail: "The detector could not make a decision.", tone: "unknown" };
  }
  return { label: "Result unavailable", detail: "The test did not return a valid result.", tone: "neutral" };
}

function formatTarget(label?: string, centerHz?: number): string {
  const frequency = centerHz === undefined ? undefined : `${(centerHz / 1_000_000).toFixed(3)} MHz`;
  return [label, frequency].filter(Boolean).join(" · ") || "Band unavailable";
}

export function parseSyntheticScenarios(payload: unknown): SyntheticValidationScenario[] {
  const root = record(payload);
  if (root?.schemaVersion !== 1 || root.synthetic !== true || !Array.isArray(root.scenarios)) return [];
  const seen = new Set<string>();
  return root.scenarios.flatMap((value) => {
    const scenario = record(value);
    const id = textValue(scenario?.id);
    if (!id || seen.has(id)) return [];
    const target = record(scenario?.target);
    seen.add(id);
    return [{
      id,
      name: textValue(scenario?.name) ?? id,
      expectedOutcome: textValue(scenario?.expectedOutcome) ?? "Not specified",
      targetLabel: textValue(target?.label),
      targetCenterHz: finiteNumber(target?.centerHz),
    }];
  });
}

export function parseSyntheticValidationResult(payload: unknown): SyntheticValidationResult {
  const root = record(payload) ?? {};
  const report = record(root.report) ?? root;
  const scenario = record(report.scenario);
  const target = record(scenario?.target) ?? record(report.target);
  const observed = record(report.observed);
  const pass = typeof report.pass === "boolean"
    ? report.pass
    : typeof report.passed === "boolean"
      ? report.passed
      : typeof root.pass === "boolean" ? root.pass : undefined;
  const synthetic = typeof report.synthetic === "boolean"
    ? report.synthetic
    : typeof root.synthetic === "boolean" ? root.synthetic : undefined;
  return {
    pass,
    scenarioId: textValue(report.scenarioId, scenario?.id, report.id, root.scenarioId),
    scenarioName: textValue(report.scenarioName, scenario?.name, report.name, root.scenarioName),
    observedOutcome: textValue(report.observedOutcome, observed?.outcome, root.observedOutcome),
    expectedOutcome: textValue(report.expectedOutcome, scenario?.expectedOutcome, root.expectedOutcome),
    targetLabel: textValue(report.targetLabel, target?.label, root.targetLabel),
    targetCenterHz: finiteNumber(report.targetCenterHz, target?.centerHz, root.targetCenterHz),
    synthetic,
    runId: textValue(report.runId, root.runId),
  };
}

function responseError(payload: unknown, status: number, task: string): Error {
  const body = record(payload);
  return new Error(textValue(body?.error, body?.message) ?? `${task} failed (${status})`);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}

function downloadReport(payload: unknown, result: SyntheticValidationResult): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `rf-monitor-synthetic-${safeFilePart(result.runId ?? result.scenarioId ?? "run")}.json`;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function SyntheticValidationPanel({
  fetcher = fetch,
  activeExercise,
  onShowOnDashboard,
  onStopExercise,
}: {
  fetcher?: typeof fetch;
  activeExercise?: SyntheticExerciseState;
  onShowOnDashboard?: (scenarioId: string) => Promise<void>;
  onStopExercise?: () => Promise<void>;
}) {
  const verdictId = useId();
  const targetId = useId();
  const detailId = useId();
  const validationId = useId();
  const [scenarios, setScenarios] = useState<SyntheticValidationScenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [mode, setMode] = useState<ValidationMode>("guided");
  const [loading, setLoading] = useState(true);
  const [livePlaybackAvailable, setLivePlaybackAvailable] = useState(false);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<SyntheticValidationResult>();
  const [report, setReport] = useState<unknown>();
  const listController = useRef<AbortController | undefined>(undefined);
  const runController = useRef<AbortController | undefined>(undefined);

  const loadScenarios = useCallback(async () => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetcher("/api/validation/scenarios", {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw responseError(payload, response.status, "Test list");
      const next = parseSyntheticScenarios(payload);
      if (next.length === 0) throw new Error("No synthetic tests available.");
      setScenarios(next);
      setLivePlaybackAvailable(record(payload)?.livePlaybackAvailable === true);
      setScenarioId((current) => next.some((scenario) => scenario.id === current) ? current : next[0].id);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setScenarios([]);
      setLivePlaybackAvailable(false);
      setScenarioId("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void loadScenarios();
    return () => {
      listController.current?.abort();
      runController.current?.abort();
    };
  }, [loadScenarios]);

  const run = async () => {
    if (!scenarioId || running) return;
    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setError(undefined);
    setResult(undefined);
    setReport(undefined);
    try {
      const response = await fetcher("/api/validation/runs", {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId, mode }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw responseError(payload, response.status, "Synthetic test");
      setReport(payload);
      setResult(parseSyntheticValidationResult(payload));
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  const clearResult = () => {
    setResult(undefined);
    setReport(undefined);
    setError(undefined);
  };

  const showOnDashboard = async () => {
    if (!scenarioId || !onShowOnDashboard || playbackBusy) return;
    setPlaybackBusy(true);
    setError(undefined);
    try {
      await onShowOnDashboard(scenarioId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPlaybackBusy(false);
    }
  };

  const stopExercise = async () => {
    if (!onStopExercise || playbackBusy) return;
    setPlaybackBusy(true);
    setError(undefined);
    try {
      await onStopExercise();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPlaybackBusy(false);
    }
  };

  const selected = scenarios.find((scenario) => scenario.id === scenarioId);
  const resultTargetLabel = result?.targetLabel ?? selected?.targetLabel;
  const resultTargetCenterHz = result?.targetCenterHz ?? selected?.targetCenterHz;
  const targetAvailable = Boolean(resultTargetLabel) && resultTargetCenterHz !== undefined;
  const resultLabel = !targetAvailable && result
    ? "Report incomplete"
    : result?.pass === true ? "Test passed" : result?.pass === false ? "Test failed" : "Test incomplete";
  const verdict = result
    ? targetAvailable
      ? getSyntheticVerdict(result)
      : { label: "Result unavailable", detail: "The report does not identify the test band.", tone: "neutral" } satisfies SyntheticVerdict
    : undefined;
  const expectedVerdict = selected
    ? getSyntheticVerdict({
      scenarioId: selected.id,
      observedOutcome: selected.expectedOutcome,
      expectedOutcome: selected.expectedOutcome,
      pass: true,
    })
    : undefined;

  return (
    <details className="synthetic-validation">
      <summary><span><FlaskConical size={16} aria-hidden="true" /><strong>Test RF Monitor</strong></span><small>Simulation only</small></summary>
      <div className="synthetic-validation-body" aria-busy={running || playbackBusy}>
        <label><span>Scenario</span><select aria-label="Synthetic test scenario" value={scenarioId} disabled={loading || running || scenarios.length === 0} onChange={(event) => { setScenarioId(event.target.value); clearResult(); }}>
          {loading ? <option value="">Loading tests…</option> : null}
          {!loading && scenarios.length === 0 ? <option value="">No tests available</option> : null}
          {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
        </select></label>
        {livePlaybackAvailable && onShowOnDashboard ? (
          activeExercise ? (
            <button className="synthetic-validation-run" type="button" disabled={playbackBusy || Boolean(activeExercise.stopRequested && activeExercise.phase !== "complete")} onClick={() => void stopExercise()}>{activeExercise.phase === "complete" ? "Done" : activeExercise.stopRequested ? "Stopping…" : "Stop test"}</button>
          ) : (
            <button className="synthetic-validation-run" type="button" disabled={!scenarioId || loading || playbackBusy} aria-label={selected ? `Show ${selected.name} on dashboard for ${selected.targetLabel ?? "the selected band"}` : "Show test on dashboard"} onClick={() => void showOnDashboard()}>{playbackBusy ? "Starting…" : "Show on dashboard"}</button>
          )
        ) : null}
        {activeExercise ? <div className="synthetic-playback-status" role="status" aria-live="polite"><b>{activeExercise.scenarioName}</b><span>{activeExercise.phase === "waiting-for-target" ? "Starting" : activeExercise.phase === "alert" ? "Test alert" : activeExercise.phase === "recovering" ? `Recovering · ${activeExercise.cleanChecks} of ${activeExercise.requiredCleanChecks}` : activeExercise.phase === "complete" ? "Test complete" : activeExercise.phase === "inconclusive" ? "Test inconclusive" : "Test running"}</span></div> : null}
        {error ? <div className="synthetic-validation-error" role="alert"><span>{error}</span>{scenarios.length === 0 ? <button type="button" onClick={() => void loadScenarios()}>Retry</button> : null}</div> : null}
        <details className="synthetic-detector-check">
          <summary>Detector check</summary>
          <div>
            <fieldset disabled={running}>
              <legend>Mode</legend>
              <label><input type="radio" name="synthetic-validation-mode" value="guided" checked={mode === "guided"} onChange={() => { setMode("guided"); clearResult(); }} />Guided</label>
              <label><input type="radio" name="synthetic-validation-mode" value="blinded" checked={mode === "blinded"} onChange={() => { setMode("blinded"); clearResult(); }} />Blinded</label>
            </fieldset>
            <button className="synthetic-validation-run" type="button" disabled={!scenarioId || loading || running} onClick={() => void run()}>{running ? "Running…" : "Run detector check"}</button>
            {selected && !result && mode === "guided" && expectedVerdict ? <small className="synthetic-validation-expected">Expected: {expectedVerdict.label}</small> : null}
          </div>
        </details>
        {result && verdict ? (
          <div
            className={`synthetic-validation-result ${verdict.tone}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-labelledby={verdictId}
            aria-describedby={`${targetId} ${detailId} ${validationId}`}
          >
            <div className="synthetic-validation-verdict">
              <h3 id={verdictId}>{verdict.label}</h3>
              <p className="synthetic-validation-target" id={targetId}><b>Band</b><span>{formatTarget(resultTargetLabel, resultTargetCenterHz)}</span></p>
              <p className="synthetic-validation-detail" id={detailId}>{verdict.detail}</p>
            </div>
            <dl>
              <div><dt>Scenario</dt><dd>{result.scenarioName ?? selected?.name ?? result.scenarioId ?? "Synthetic test"}</dd></div>
              <div><dt>Validation</dt><dd id={validationId} className={result.pass === false || !targetAvailable ? "failed" : result.pass === true ? "passed" : undefined}>{resultLabel}</dd></div>
            </dl>
            <button type="button" disabled={report === undefined} onClick={() => report !== undefined && downloadReport(report, result)}><Download size={14} aria-hidden="true" />Download report</button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
