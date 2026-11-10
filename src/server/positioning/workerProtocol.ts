/** Messages between the DGNSS report service and its worker thread. */
import type { DataDomain } from "../../shared/types";
import type { DgnssConfig, DgnssStatus, DgnssWindowRequest } from "../../shared/dgnss";
import type { PipelineResult } from "./pipeline";
import type { PositioningReportIdentity } from "./types";

export interface DgnssWorkerInput {
  sbsPath: string;
  outDir: string;
  file: { name: string; bytes: number; sha256: string };
  config: DgnssConfig;
  identity: PositioningReportIdentity;
  window: DgnssWindowRequest;
  evidenceRoot: string;
  dataDomain: DataDomain;
}

export type DgnssWorkerMessage =
  | { type: "stage"; stage: string; progress: number }
  | { type: "done"; status: DgnssStatus; verdict: string; facts: PipelineResult["facts"]; windowStartMs: number; rfSource?: string; peakHeapMb?: number }
  | { type: "error"; message: string; detail: string; user: boolean };
