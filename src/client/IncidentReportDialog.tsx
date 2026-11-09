import { useState } from "react";
import { Download, ExternalLink, FileDown, RefreshCw, X } from "lucide-react";
import { DialogShell } from "./DialogShell";
import { rfVerdictFor } from "../shared/productContract";
import { incidentPackageBaseName, incidentReference } from "../shared/incidentNaming";
import type { DetectionEvent } from "../shared/types";

/**
 * The client report exactly as it is delivered: the same server-rendered HTML
 * that goes into the evidence package, shown in a sandboxed frame, with the
 * PDF and the full evidence package one click away.
 */
export function IncidentReportDialog({
  event,
  exporting,
  onExport,
  onClose,
  onToast,
}: {
  event: DetectionEvent;
  exporting: boolean;
  onExport: () => void;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const base = `/api/events/${encodeURIComponent(event.id)}`;
  const synthetic = Boolean(event.syntheticExercise);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${base}/report/refresh`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The report could not be refreshed");
      setRevision((value) => value + 1);
      onToast("Report updated with the latest recorded data.");
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <DialogShell backdropClassName="report-backdrop" dialogClassName="report-dialog" labelledBy="report-dialog-title" onClose={onClose}>
      <header className="report-dialog-header">
        <div>
          <span>{incidentReference(event)}</span>
          <strong id="report-dialog-title">Incident report · {rfVerdictFor(event)}</strong>
        </div>
        <div className="report-dialog-actions">
          <button type="button" className="button secondary compact" onClick={() => void refresh()} disabled={refreshing || synthetic}>
            <RefreshCw size={15} aria-hidden="true" /> {refreshing ? "Updating…" : "Update"}
          </button>
          <a className="button secondary compact" href={`${base}/report.pdf?v=${revision}`} download={`${incidentPackageBaseName(event)}.pdf`} aria-disabled={synthetic}>
            <FileDown size={15} aria-hidden="true" /> PDF
          </a>
          <a className="button secondary compact" href={`${base}/report.html?v=${revision}`} target="_blank" rel="noopener">
            <ExternalLink size={15} aria-hidden="true" /> Open to print
          </a>
          <button type="button" className="button primary compact" onClick={onExport} disabled={exporting || synthetic}>
            <Download size={15} aria-hidden="true" /> {exporting ? "Preparing…" : "Evidence package"}
          </button>
          <button type="button" className="report-dialog-close" onClick={onClose} aria-label="Close report"><X size={20} /></button>
        </div>
      </header>
      {synthetic ? (
        <p className="report-dialog-empty">Simulation incidents are test data and have no client report.</p>
      ) : (
        <iframe
          key={revision}
          className="report-frame"
          title={`Incident report for ${incidentReference(event)}`}
          src={`${base}/report.html?v=${revision}`}
          sandbox=""
          referrerPolicy="no-referrer"
        />
      )}
    </DialogShell>
  );
}
