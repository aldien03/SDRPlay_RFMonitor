/** DGNSS report: configuration and API shapes shared by the browser and the server. */

export interface DgnssSystemConfig {
  /** Gator system id, as in the SBS page name (DGPS1_QC -> DGPS1). */
  id: string;
  output: string;
  receiver: string;
  /** Systems on one physical antenna use the same antenna name; the report groups them by it. */
  antenna: string;
  beam: string;
}

export interface DgnssConfig {
  schemaVersion: 1;
  revision: number;
  updatedAt?: string;
  controlId: string;
  systems: DgnssSystemConfig[];
  /** Control threshold for CRP agreement, metres. */
  agreementM: number;
  /** Vessel moving above this speed, knots. */
  movingKnots: number;
  survey?: string;
  location?: string;
  geodetics?: string;
}

export interface DgnssConfigResponse {
  config: DgnssConfig;
  /** False until the systems table has been saved once. */
  configured: boolean;
  admin: { unlocked: boolean };
}

export type DgnssWindowMode = "sbs" | "utc-day" | "custom";

export interface DgnssWindowRequest {
  mode: DgnssWindowMode;
  /** UTC ISO-8601, custom only. */
  start?: string;
  end?: string;
  /** "YYYY-MM-DD", utc-day only; defaults to the first day with Gator data. */
  day?: string;
}

/** Most SBS files one report can combine. */
export const DGNSS_MAX_FILES = 20;
/** Longest time span a set of SBS files may cover; the report window itself is at most 24 h. */
export const DGNSS_MAX_SET_SPAN_MS = 7 * 86_400_000;

export interface DgnssUploadPreview {
  uploadId: string;
  fileName: string;
  bytes: number;
  sha256: string;
  lineName: string;
  startMs: number;
  endMs: number;
  shotCount: number;
  intervalMs: number;
  systemsFound: string[];
  /** Configured systems not in the file, and file systems not configured. */
  missingSystems: string[];
  unknownSystems: string[];
  windows: { sbs: [number, number]; utcDay: [number, number] };
  rf: {
    /** Fraction of the SBS span covered by rf-monitor recording sessions. */
    sessionCoverage: number;
    sessions: number;
    targets: Array<{ id: string; label: string }>;
  };
  warnings: string[];
}

/** One uploaded file, as listed in a set preview. */
export interface DgnssSbsFile {
  uploadId: string;
  fileName: string;
  bytes: number;
  sha256: string;
  lineName: string;
  startMs: number;
  endMs: number;
  shotCount: number;
  intervalMs: number;
  systemsFound: string[];
}

/** Several uploaded SBS files checked together, before a report is generated. */
export interface DgnssSetPreview {
  /** In time order. */
  uploadIds: string[];
  files: DgnssSbsFile[];
  bytes: number;
  /** Distinct Gator line names, joined. */
  lineName: string;
  lineNames: string[];
  startMs: number;
  endMs: number;
  intervalMs: number;
  /** Sum over files; shots repeated in overlapping files are counted once in the report. */
  shotCount: number;
  systemsFound: string[];
  missingSystems: string[];
  unknownSystems: string[];
  /** UTC days ("YYYY-MM-DD") with Gator data. */
  days: string[];
  /** The SBS span itself is at most 24 h and can be the report window. */
  spanFitsDay: boolean;
  /** Spans between files without Gator data. */
  gaps: Array<[number, number]>;
  /** Spans where two files hold the same system. */
  overlaps: Array<[number, number]>;
  windows: { sbs: [number, number]; utcDay: [number, number] };
  rf: {
    sessionCoverage: number;
    sessions: number;
    targets: Array<{ id: string; label: string }>;
  };
  warnings: string[];
}

export type DgnssStatus = "PASS" | "FAIL" | "ALERT" | "CHECK" | "INFO";
export type DgnssJobState = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface DgnssReportSummary {
  id: string;
  state: DgnssJobState;
  stage?: string;
  /** 0 to 1. */
  progress?: number;
  createdAt: string;
  finishedAt?: string;
  /** File name, or "N SBS files". */
  fileName: string;
  lineName: string;
  /** SHA-256 of the SBS file; for several files, of their sorted SHA-256 list. */
  sbsSha256: string;
  /** Every input file (absent on reports made before multi-file support). */
  sbsFiles?: Array<{ name: string; sha256: string; bytes: number }>;
  window: { mode: DgnssWindowMode; startMs: number; endMs: number };
  status?: DgnssStatus;
  verdict?: string;
  facts?: {
    maxToControlM?: number;
    maxSystem?: string;
    controlId?: string;
    rfEpisodes: number;
    interferenceEvents: number;
    events: number;
    pages?: number;
    rfFrames?: number;
  };
  error?: string;
  /** Present when ready. */
  files?: { pdf: string; html: string; package: string };
}

export interface DgnssReportList {
  reports: DgnssReportSummary[];
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const TEXT_MAX = 80;

function text(value: unknown, field: string, fields: Record<string, string>, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) fields[field] = "Required";
    return undefined;
  }
  if (typeof value !== "string" || /[\u0000-\u001f]/.test(value)) {
    fields[field] = "Enter text on one line";
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > TEXT_MAX) {
    fields[field] = `Up to ${TEXT_MAX} characters`;
    return undefined;
  }
  if (required && !trimmed) fields[field] = "Required";
  return trimmed || undefined;
}

export function defaultDgnssConfig(): DgnssConfig {
  return { schemaVersion: 1, revision: 0, controlId: "", systems: [], agreementM: 0.5, movingKnots: 0.5 };
}

/** Validates a config sent by the browser. Returns field errors keyed like "systems.2.receiver". */
export function validateDgnssConfig(input: unknown): { config?: Omit<DgnssConfig, "revision" | "updatedAt" | "schemaVersion">; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { fields: { config: "Configuration is invalid" } };
  const raw = input as Record<string, unknown>;
  const list = Array.isArray(raw.systems) ? raw.systems : [];
  if (!list.length) fields.systems = "Add at least one DGNSS system";
  if (list.length > 12) fields.systems = "Up to 12 systems";
  const seen = new Set<string>();
  const systems: DgnssSystemConfig[] = list.slice(0, 12).map((entry, index) => {
    const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!ID.test(id)) fields[`systems.${index}.id`] = "Use the Gator id, e.g. DGPS1";
    else if (seen.has(id)) fields[`systems.${index}.id`] = "Each id once";
    seen.add(id);
    return {
      id,
      output: text(row.output, `systems.${index}.output`, fields, true) ?? "",
      receiver: text(row.receiver, `systems.${index}.receiver`, fields, true) ?? "",
      antenna: text(row.antenna, `systems.${index}.antenna`, fields, true) ?? "",
      beam: text(row.beam, `systems.${index}.beam`, fields, true) ?? "",
    };
  });
  const controlId = typeof raw.controlId === "string" ? raw.controlId : "";
  if (!systems.some((system) => system.id === controlId)) fields.controlId = "Choose the control system";
  const number = (value: unknown, field: string, min: number, max: number) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      fields[field] = `Enter ${min} to ${max}`;
      return min;
    }
    return parsed;
  };
  const config = {
    controlId,
    systems,
    agreementM: number(raw.agreementM, "agreementM", 0.01, 10),
    movingKnots: number(raw.movingKnots, "movingKnots", 0.05, 5),
    survey: text(raw.survey, "survey", fields),
    location: text(raw.location, "location", fields),
    geodetics: text(raw.geodetics, "geodetics", fields),
  };
  return Object.keys(fields).length ? { fields } : { config, fields };
}
