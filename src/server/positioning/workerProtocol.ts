/** Messages between the DGNSS report service and its worker thread. */
import type { DataDomain } from "../../shared/types";
import type { DgnssConfig, DgnssStatus, DgnssWindowRequest } from "../../shared/dgnss";
import type { PipelineResult } from "./pipeline";
import type { PositioningReportIdentity, ReportWindow } from "./types";

export interface DgnssWorkerInput {
  /** SBS files in time order; parsed one at a time and merged. */
  sbsPaths: string[];
  outDir: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  config: DgnssConfig;
  identity: PositioningReportIdentity;
  window: DgnssWindowRequest;
  /** Resolved by the service from the upload scans; only shots inside it are parsed. */
  resolvedWindow: ReportWindow;
  evidenceRoot: string;
  dataDomain: DataDomain;
}

export type DgnssWorkerMessage =
  | { type: "stage"; stage: string; progress: number }
  | { type: "done"; status: DgnssStatus; verdict: string; facts: PipelineResult["facts"]; windowStartMs: number; rfSource?: string; peakHeapMb?: number }
  | { type: "error"; message: string; detail: string; user: boolean };
