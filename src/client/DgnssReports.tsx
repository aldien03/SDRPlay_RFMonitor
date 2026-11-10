import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Archive, CircleCheck, Download, Eye, FileText, FileUp, LoaderCircle, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import type { DgnssConfigResponse, DgnssReportSummary, DgnssStatus, DgnssUploadPreview, DgnssWindowMode } from "../shared/dgnss";
import { cancelDgnssReport, dgnssFileUrl, generateDgnssReport, getDgnssConfig, getDgnssReport, listDgnssReports, uploadSbs } from "./dgnssApi";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Reports are UTC throughout, so the panel is too. */
function utc(ms: number, withDate = true): string {
  const date = new Date(ms);
  const time = date.toISOString().slice(11, 19);
  return withDate ? `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${time}` : time;
}

function span(startMs: number, endMs: number): string {
  const sameDay = new Date(startMs).toISOString().slice(0, 10) === new Date(endMs - 1).toISOString().slice(0, 10);
  return `${utc(startMs)} – ${sameDay ? utc(endMs, false) : utc(endMs)}`;
}

function bytes(value: number): string {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

const WINDOW_LABEL: Record<DgnssWindowMode, string> = { sbs: "SBS span", "utc-day": "UTC day", custom: "Custom window" };

function statusClass(status?: DgnssStatus): string {
  return status === "PASS" ? "pass" : status === "ALERT" || status === "FAIL" ? "alert" : status === "CHECK" ? "check" : "info";
}

function isLive(report?: DgnssReportSummary): boolean {
  return report?.state === "queued" || report?.state === "running";
}

/** Value for a datetime-local input showing UTC. */
function utcInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

type Phase = "idle" | "uploading" | "checked" | "building" | "ready" | "failed";

export function DgnssReports({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [config, setConfig] = useState<DgnssConfigResponse>();
  const [reports, setReports] = useState<DgnssReportSummary[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<DgnssUploadPreview>();
  const [job, setJob] = useState<DgnssReportSummary>();
  const [error, setError] = useState<string>();
  const [windowMode, setWindowMode] = useState<DgnssWindowMode>("sbs");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [dragging, setDragging] = useState(false);
  const [listError, setListError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, list] = await Promise.all([getDgnssConfig(), listDgnssReports()]);
      setConfig(nextConfig);
      setReports(list.reports);
      setListError(undefined);
    } catch (reason) {
      setListError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Follow the running report, then refresh the list once it finishes.
  useEffect(() => {
    if (!job || !isLive(job)) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getDgnssReport(job.id);
        setJob(next);
        if (next.state === "ready") setPhase("ready");
        else if (next.state === "failed" || next.state === "cancelled") {
          setPhase(next.state === "cancelled" ? "checked" : "failed");
          setError(next.state === "failed" ? next.error ?? "The report could not be built." : undefined);
        }
        if (!isLive(next)) void refresh();
      } catch {
        // Keep polling; the next tick retries.
        setJob({ ...job });
      }
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [job, refresh]);

  // Keep other running reports in the list moving.
  useEffect(() => {
    if (!reports.some((report) => isLive(report) && report.id !== job?.id)) return;
    const timer = window.setTimeout(() => void refresh(), 3_000);
    return () => window.clearTimeout(timer);
  }, [reports, job, refresh]);

  const startUpload = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    setPreview(undefined);
    setJob(undefined);
    setPhase("uploading");
    setProgress(0);
    try {
      const result = await uploadSbs(file, setProgress);
      setPreview(result);
      setWindowMode("sbs");
      setCustomStart(utcInput(result.windows.sbs[0]));
      setCustomEnd(utcInput(result.windows.sbs[1]));
      setPhase("checked");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("idle");
    }
  };

  const generate = async () => {
    if (!preview) return;
    setError(undefined);
    try {
      const window = windowMode === "custom" ? { mode: windowMode, start: `${customStart}:00Z`, end: `${customEnd}:00Z` } : { mode: windowMode };
      const created = await generateDgnssReport(preview.uploadId, window);
      setJob(created);
      setPhase("building");
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const reset = () => {
    setPhase("idle");
    setPreview(undefined);
    setJob(undefined);
    setError(undefined);
    if (fileInput.current) fileInput.current.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void startUpload(event.dataTransfer.files?.[0]);
  };

  const cfg = config?.config;
  const groups = cfg ? new Set(cfg.systems.map((system) => system.antennaGroup)).size : 0;
  const hasFile = Boolean(preview) && phase !== "idle" && phase !== "uploading";
  const configured = config?.configured === true;
  const stepState = phase === "building" ? "Generating" : hasFile ? "Step 2 of 3" : "Step 1 of 3";

  return (
    <section className="panel evidence-panel evidence-history dgnss-panel" aria-labelledby="dgnss-title">
      <header className="evidence-history-heading">
        <div><span>Archive</span><h2 id="dgnss-title">DGNSS reports</h2><p>Gator SBS positioning checked against rf-monitor RF evidence.</p></div>
        <button type="button" onClick={() => void refresh()} aria-label="Refresh DGNSS reports"><RefreshCw size={16} />Refresh</button>
      </header>
      {config ? (
        <div className={`dgnss-config${configured ? "" : " missing"}`}>
          {configured && cfg
            ? <span>Control <b>{cfg.controlId}</b> · Threshold <b>{cfg.agreementM} m</b> · <b>{cfg.systems.length}</b> systems on <b>{groups}</b> antenna{groups === 1 ? "" : "s"}</span>
            : <span><b>DGNSS systems not set up.</b> An administrator saves them once in Settings › Site.</span>}
          <button type="button" className="dgnss-link" onClick={onOpenSettings}><Lock size={13} aria-hidden="true" />Systems in Settings</button>
        </div>
      ) : null}

      {phase === "ready" && job ? (
        <article className="dgnss-card" aria-live="polite">
          <header>
            <div className="evidence-session-title"><FileText size={18} aria-hidden="true" /><span><small>Report ready · {utc(Date.parse(job.finishedAt ?? job.createdAt))} UTC</small><strong>{job.lineName} · {span(job.window.startMs, job.window.endMs)}</strong></span></div>
            <span className={`dgnss-chip ${statusClass(job.status)}`}>{job.status ?? "Ready"}</span>
          </header>
          {job.verdict ? <p className="dgnss-verdict">{job.verdict}</p> : null}
          <dl className="evidence-session-facts dgnss-facts">
            <div><dt>Max to control</dt><dd>{job.facts?.maxToControlM !== undefined ? `${job.facts.maxToControlM.toFixed(3)} m (${job.facts.maxSystem})` : "–"}</dd></div>
            <div><dt>RF interference</dt><dd>{job.facts ? (job.facts.interferenceEvents ? `${job.facts.interferenceEvents} affecting positioning` : job.facts.rfEpisodes ? `${job.facts.rfEpisodes} episode${job.facts.rfEpisodes === 1 ? "" : "s"}, no impact` : "None") : "–"}</dd></div>
            <div><dt>Events</dt><dd>{job.facts?.events ?? "–"}</dd></div>
            <div><dt>Pages</dt><dd>{job.facts?.pages ?? "–"}</dd></div>
          </dl>
          <div className="dgnss-actions">
            <a className="primary" href={dgnssFileUrl(job.id, "pdf")} download={job.files?.pdf}><Download size={15} aria-hidden="true" />Download PDF</a>
            <a href={dgnssFileUrl(job.id, "html")} target="_blank" rel="noopener noreferrer"><Eye size={15} aria-hidden="true" />Open HTML</a>
            <a href={dgnssFileUrl(job.id, "package")} download={job.files?.package}><Archive size={15} aria-hidden="true" />Evidence package</a>
            <button type="button" onClick={reset}>New report</button>
          </div>
        </article>
      ) : (
        <article className="dgnss-card">
          <header>
            <div className="evidence-session-title"><FileUp size={18} aria-hidden="true" /><span><small>New report</small><strong>{phase === "building" ? "Building report" : hasFile ? "Choose window and generate" : "Upload a Gator SBS export"}</strong></span></div>
            <span className={`evidence-status${phase === "building" ? " lifecycle-active" : ""}`}>{stepState}</span>
          </header>

          <div className="dgnss-step">
            <span className={`dgnss-step-no${hasFile ? " done" : ""}`} aria-hidden="true">{hasFile ? "✓" : "1"}</span>
            <div>
              <h3>Gator SBS file</h3>
              <input ref={fileInput} type="file" accept=".sbs,.SBS,.txt,text/plain" hidden onChange={(event) => void startUpload(event.target.files?.[0])} />
              {phase === "idle" || phase === "uploading" ? (
                <div
                  className={`dgnss-dropzone${dragging ? " dragging" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label="Choose a Gator SBS file"
                  aria-busy={phase === "uploading"}
                  onClick={() => phase !== "uploading" && fileInput.current?.click()}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && phase !== "uploading") {
                      event.preventDefault();
                      fileInput.current?.click();
                    }
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  {phase === "uploading" ? (
                    <>
                      <LoaderCircle size={22} className="dgnss-spin" aria-hidden="true" />
                      <strong>{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : "Checking the file…"}</strong>
                      <span className="dgnss-progress" aria-hidden="true"><b style={{ width: `${Math.round(progress * 100)}%` }} /></span>
                    </>
                  ) : (
                    <>
                      <FileUp size={22} aria-hidden="true" />
                      <strong>Drop .sbs file here or <u>browse</u></strong>
                      <span>DGPS QC pages · up to 24 h · UTC</span>
                    </>
                  )}
                </div>
              ) : preview ? (
                <>
                  <div className="dgnss-file">
                    <FileText size={18} aria-hidden="true" />
                    <div><strong>{preview.fileName}</strong><small>{bytes(preview.bytes)} · SHA-256 {preview.sha256.slice(0, 12)}…{preview.sha256.slice(-8)}</small></div>
                    <span className={`dgnss-chip ${preview.rf.sessionCoverage > 0 ? "pass" : "check"}`}>{preview.rf.sessionCoverage > 0 ? "Checked" : "No RF"}</span>
                    {phase !== "building" ? <button type="button" className="dgnss-link" onClick={reset}>Replace</button> : null}
                  </div>
                  <dl className="evidence-session-facts dgnss-facts">
                    <div><dt>Gator line</dt><dd>{preview.lineName}</dd></div>
                    <div><dt>UTC</dt><dd>{span(preview.startMs, preview.endMs + preview.intervalMs)}</dd></div>
                    <div><dt>Systems</dt><dd>{preview.systemsFound.length - preview.unknownSystems.length} of {cfg?.systems.length || preview.systemsFound.length}</dd></div>
                    <div><dt>Shots</dt><dd>{preview.shotCount.toLocaleString()} × {preview.intervalMs / 1000} s</dd></div>
                  </dl>
                  <div className="dgnss-coverage">
                    <div className="dgnss-coverage-title"><span>rf-monitor RF in this span</span><span>{Math.round(preview.rf.sessionCoverage * 100)}% recorded</span></div>
                    <div className="dgnss-lane"><span>Recording</span><i><b style={{ width: `${Math.round(preview.rf.sessionCoverage * 100)}%` }} /></i><span>{preview.rf.sessions} session{preview.rf.sessions === 1 ? "" : "s"}</span></div>
                    <p>{preview.rf.targets.length ? `Bands: ${preview.rf.targets.map((target) => target.label).join(" · ")}` : "No rf-monitor bands recorded in this span."}</p>
                  </div>
                  {preview.warnings.length ? <ul className="dgnss-warnings">{preview.warnings.map((warning) => <li key={warning}><TriangleAlert size={13} aria-hidden="true" />{warning}</li>)}</ul> : null}
                </>
              ) : null}
            </div>
          </div>

          <div className="dgnss-step">
            <span className={`dgnss-step-no${hasFile ? "" : " off"}`} aria-hidden="true">2</span>
            <div>
              <h3>Report window (UTC)</h3>
              <div className="dgnss-seg" role="radiogroup" aria-label="Report window">
                {(["sbs", "utc-day", "custom"] as const).map((mode) => (
                  <label key={mode} className={windowMode === mode ? "on" : ""}>
                    <input type="radio" name="dgnss-window" value={mode} checked={windowMode === mode} disabled={!hasFile || phase === "building"} onChange={() => setWindowMode(mode)} />
                    <strong>{WINDOW_LABEL[mode].replace(" window", "")}</strong>
                    <small>{preview ? (mode === "sbs" ? span(preview.windows.sbs[0], preview.windows.sbs[1]).replace(/^\d+ \w+ /, "") : mode === "utc-day" ? `${utc(preview.windows.utcDay[0]).slice(0, 6).trim()} 00:00 – 24:00` : "Up to 24 h") : mode === "custom" ? "Up to 24 h" : "–"}</small>
                  </label>
                ))}
              </div>
              {windowMode === "custom" && hasFile ? (
                <div className="dgnss-custom">
                  <label>Start (UTC)<input type="datetime-local" value={customStart} disabled={phase === "building"} onChange={(event) => setCustomStart(event.target.value)} /></label>
                  <label>End (UTC)<input type="datetime-local" value={customEnd} disabled={phase === "building"} onChange={(event) => setCustomEnd(event.target.value)} /></label>
                </div>
              ) : null}
            </div>
          </div>

          <div className="dgnss-step">
            <span className={`dgnss-step-no${hasFile ? "" : " off"}`} aria-hidden="true">3</span>
            <div>
              <h3>Generate</h3>
              {phase === "building" && job ? (
                <div aria-live="polite">
                  <span className="dgnss-progress large" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((job.progress ?? 0) * 100)}><b style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></span>
                  <p className="dgnss-stage"><LoaderCircle size={13} className="dgnss-spin" aria-hidden="true" />{job.stage ?? "Working"} · {Math.round((job.progress ?? 0) * 100)}%</p>
                  <div className="dgnss-generate">
                    <button type="button" className="button secondary compact" onClick={() => void cancelDgnssReport(job.id).then(setJob).catch(() => undefined)}>Cancel</button>
                    <span>You can close this drawer; the report keeps building.</span>
                  </div>
                </div>
              ) : (
                <div className="dgnss-generate">
                  <button type="button" className="button primary compact" disabled={!hasFile || !configured} onClick={() => void generate()}>Generate report</button>
                  <span>{!hasFile ? "Upload a file first" : !configured ? "Set up DGNSS systems in Settings first" : "Builds the PDF and HTML report"}</span>
                </div>
              )}
            </div>
          </div>
        </article>
      )}

      {error ? <div className="dgnss-notice error" role="alert"><TriangleAlert size={16} aria-hidden="true" /><div><strong>{phase === "failed" ? "Report failed" : "Could not continue"}</strong>{error} {phase === "failed" ? <button type="button" className="dgnss-link" onClick={() => setPhase("checked")}>Try again</button> : null}</div></div> : null}

      <div className="dgnss-list-title"><span>Previous reports</span>{listError ? <em>{listError}</em> : <em>Kept with the evidence</em>}</div>
      {reports.length ? (
        <div className="evidence-session-list">
          {reports.map((report) => (
            <article className="evidence-session" key={report.id}>
              <header>
                <div className="evidence-session-title"><FileText size={18} aria-hidden="true" /><span><small>DGNSS report · {WINDOW_LABEL[report.window.mode]}</small><strong>{span(report.window.startMs, report.window.endMs)} · line {report.lineName}</strong></span></div>
                {report.state === "ready"
                  ? <span className={`dgnss-chip ${statusClass(report.status)}`}>{report.status}</span>
                  : <span className={`evidence-status${isLive(report) ? " lifecycle-active" : report.state === "failed" ? " lifecycle-incomplete" : ""}`}>{isLive(report) ? `${Math.round((report.progress ?? 0) * 100)}%` : report.state === "failed" ? "Failed" : "Cancelled"}</span>}
              </header>
              <p className="evidence-session-description">{report.state === "ready" ? report.verdict : isLive(report) ? report.stage : report.error ?? "Cancelled."}</p>
              {report.state === "ready" ? (
                <div className="dgnss-actions">
                  <a className="primary" href={dgnssFileUrl(report.id, "pdf")} download={report.files?.pdf}><Download size={15} aria-hidden="true" />PDF</a>
                  <a href={dgnssFileUrl(report.id, "html")} target="_blank" rel="noopener noreferrer"><Eye size={15} aria-hidden="true" />HTML</a>
                  <a href={dgnssFileUrl(report.id, "package")} download={report.files?.package}><Archive size={15} aria-hidden="true" />Evidence package</a>
                  <code title={`SBS SHA-256 ${report.sbsSha256}`}>SBS {report.sbsSha256.slice(0, 4)}…{report.sbsSha256.slice(-4)}</code>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : <div className="evidence-history-empty"><strong>No DGNSS reports yet</strong><span>Upload a Gator SBS file to create the first one.</span></div>}
      {phase === "ready" ? <p className="dgnss-hidden-note"><CircleCheck size={12} aria-hidden="true" /> Saved in Previous reports.</p> : null}
    </section>
  );
}
