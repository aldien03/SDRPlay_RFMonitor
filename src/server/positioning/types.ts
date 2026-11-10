/** Configuration and evidence inputs for the DGNSS verification and interference report. */

export interface PositioningSystemConfig {
  /** Gator system id as it appears in the SBS page name, e.g. "DGPS1". */
  id: string;
  /** Correction service / solution, e.g. "G4 SPEL". */
  output: string;
  receiver: string;
  antenna: string;
  /** Solutions on one splitter share an antenna group; used to separate antenna from receiver causes. */
  antennaGroup: string;
  /** Fugro L-band beam, e.g. "EASAT"; matched to the rf-monitor lane "fugro-<beam>". */
  beam: string;
  ip?: string;
}

export interface PositioningReportIdentity {
  companyName?: string;
  vesselName: string;
  clientName?: string;
  survey?: string;
  harbour?: string;
  area?: string;
  geodetics?: string;
}

export interface PositioningThresholds {
  /** Limit on distance between a solution's CRP and the six-system mean CRP. */
  agreementM: number;
  /** Flag satellites below (1 - fraction) x the solution's own median... */
  satsDropFraction: number;
  /** ...and at least this many below it. */
  satsDropMin: number;
  /** Flag HDOP above max(factor x own median, own median + excess). */
  hdopFactor: number;
  hdopExcess: number;
  /** Flag correction age more than this many seconds above the solution's own median. */
  ageExcessS: number;
  /** Speed of the mean CRP above which the vessel counts as moving. */
  movingKnots: number;
  /** Flags on the same solution closer than this are one event. */
  mergeGapS: number;
}

export const DEFAULT_THRESHOLDS: PositioningThresholds = {
  agreementM: 0.5,
  satsDropFraction: 0.3,
  satsDropMin: 4,
  hdopFactor: 2,
  hdopExcess: 1,
  ageExcessS: 30,
  movingKnots: 0.5,
  mergeGapS: 300,
};

export type ReportWindowMode = "sbs" | "utc-day" | "custom";

export interface ReportWindow {
  mode: ReportWindowMode;
  startMs: number;
  endMs: number;
}

export type RfLaneState = "clear" | "anomaly" | "unmonitored";

export interface RfLaneInterval {
  fromMs: number;
  toMs: number;
  state: RfLaneState;
}

export interface RfLane {
  /** Catalog id: a GNSS capture target or "fugro-<beam>". */
  id: string;
  label: string;
  shortLabel: string;
  service: "gnss" | "fugro";
  intervals: RfLaneInterval[];
}

export interface RfIncidentSummary {
  id: string;
  title: string;
  fromMs: number;
  toMs: number;
  laneIds: string[];
  evidenceStrength: "Low" | "Medium";
}

export interface RfEvidence {
  /** "simulated" marks every RF element of the report as mock data. */
  source: "simulated" | "rf-monitor";
  lanes: RfLane[];
  incidents: RfIncidentSummary[];
}
