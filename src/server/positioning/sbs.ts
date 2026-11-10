/**
 * Parser for Gator "SBS" QC exports: tab-separated, one page per DGNSS solution
 * ("Page n<TAB>DGPSn_QC<TAB>All Shots"), a "Shot" header row, then one row per
 * shot. Every value column is followed by a Quality column ([OK]/[AB]), which
 * is ignored by design. Raw Time is Unix seconds (UTC).
 *
 * Columns are found by header name, not position, so a re-ordered or extended
 * export (for example with Age Correction added) still parses.
 */

export interface SbsShot {
  shot: number;
  timeMs: number;
  /** Vessel reference point (CRP) reduced by Gator from this solution. */
  crpE: number;
  crpN: number;
  /** Logged antenna position, no offsets applied. */
  antE: number;
  antN: number;
  antH: number | null;
  pdop: number | null;
  hdop: number | null;
  pcalc: number | null;
  nsats: number | null;
  ageS: number | null;
}

export interface SbsSystem {
  /** "DGPS1" from page "DGPS1_QC". */
  id: string;
  page: string;
  shots: SbsShot[];
  /** Raw QC fields that never carried a value (e.g. a receiver that does not output PDOP). */
  absentFields: string[];
}

export interface SbsDataset {
  lineName: string;
  systems: SbsSystem[];
  startMs: number;
  endMs: number;
  /** Most common shot interval. */
  intervalMs: number;
  shotCount: number;
  /** Shots whose raw QC block was all zero (end-of-line export artefact) and was treated as missing. */
  missingRawQcShots: number;
}

type FieldKey = "crpE" | "crpN" | "antE" | "antN" | "antH" | "pdop" | "hdop" | "pcalc" | "nsats" | "ageS";

const RAW_FIELDS: Record<string, FieldKey> = {
  PDOP: "pdop",
  HDOP: "hdop",
  PCALC: "pcalc",
  "NSats Tracked": "nsats",
  "Age Correction": "ageS",
};

function mapHeader(header: string[]): { time: number; shot: number; fields: Partial<Record<FieldKey, number>> } {
  const fields: Partial<Record<FieldKey, number>> = {};
  header.forEach((name, index) => {
    const trimmed = name.trim();
    const raw = /^Raw:\s.*?\s(PDOP|HDOP|PCALC|Unit Variance|NSats Tracked|Age Correction)$/.exec(trimmed);
    if (raw) {
      const key = RAW_FIELDS[raw[1]];
      if (key) fields[key] = index;
      return;
    }
    // "<PAGE> <OBJECT> <Field>": OBJECT is the vessel CRP ("SST") or an antenna ("SSTDG1").
    const position = /^\S+\s(\S+)\s(Easting|Northing|Height)$/.exec(trimmed);
    if (!position) return;
    const antenna = /DG\d+$/.test(position[1]);
    const key = (antenna ? { Easting: "antE", Northing: "antN", Height: "antH" } : { Easting: "crpE", Northing: "crpN", Height: undefined })[position[2] as "Easting" | "Northing" | "Height"] as FieldKey | undefined;
    if (key) fields[key] = index;
  });
  return { time: header.indexOf("Raw Time"), shot: header.indexOf("Shot"), fields };
}

function numberAt(cells: string[], index: number | undefined): number | null {
  if (index === undefined || index < 0 || index >= cells.length) return null;
  const value = Number.parseFloat(cells[index]);
  return Number.isFinite(value) ? value : null;
}

export class SbsParseError extends Error {}

/** Line-at-a-time parser so a 24 h export never needs its whole text split in memory. */
export class SbsParser {
  private readonly systems: SbsSystem[] = [];
  private lineName = "";
  private current?: SbsSystem;
  private columns?: ReturnType<typeof mapHeader>;
  private missingRawQcShots = 0;

  line(rawLine: string): void {
    if (!rawLine.trim()) return;
    const cells = rawLine.split("\t");
    if (cells[0] === "# Line name") {
      this.lineName ||= (cells[1] ?? "").trim();
      return;
    }
    if (/^Page\s+\d+$/.test(cells[0])) {
      const page = (cells[1] ?? "").trim();
      this.current = { id: page.replace(/_QC$/i, ""), page, shots: [], absentFields: [] };
      this.systems.push(this.current);
      this.columns = undefined;
      return;
    }
    if (cells[0] === "Shot") {
      this.columns = mapHeader(cells);
      if (this.columns.time < 0 || this.columns.fields.crpE === undefined || this.columns.fields.crpN === undefined) {
        throw new SbsParseError(`Page ${this.current?.page ?? "?"} has no Raw Time or CRP Easting/Northing column`);
      }
      return;
    }
    const current = this.current;
    const columns = this.columns;
    if (!current || !columns) return;
    const seconds = numberAt(cells, columns.time);
    const crpE = numberAt(cells, columns.fields.crpE);
    const crpN = numberAt(cells, columns.fields.crpN);
    if (seconds === null || crpE === null || crpN === null) return;
    const field = (key: FieldKey) => numberAt(cells, columns.fields[key]);
    let pdop = field("pdop");
    let hdop = field("hdop");
    let pcalc = field("pcalc");
    let nsats = field("nsats");
    let ageS = field("ageS");
    // Gator writes the raw QC block as zeros when no raw message arrived
    // (always the last shots of a line). Zero satellites with zero HDOP is
    // "no data", never a real fix.
    if ((nsats ?? 0) === 0 && (hdop ?? 0) === 0 && (pcalc ?? 0) === 0) {
      pdop = hdop = pcalc = nsats = ageS = null;
      if (current === this.systems[0]) this.missingRawQcShots += 1;
    }
    if (pdop === 0) pdop = null;
    current.shots.push({
      shot: numberAt(cells, columns.shot) ?? current.shots.length + 1,
      timeMs: Math.round(seconds * 1000),
      crpE,
      crpN,
      antE: field("antE") ?? Number.NaN,
      antN: field("antN") ?? Number.NaN,
      antH: field("antH"),
      pdop,
      hdop,
      pcalc,
      nsats,
      ageS,
    });
  }

  finish(): SbsDataset {
    const populated = this.systems.filter((system) => system.shots.length);
    if (!populated.length) throw new SbsParseError("No DGNSS pages with shots were found");
    for (const system of populated) {
      system.shots.sort((left, right) => left.timeMs - right.timeMs);
      const fields: Array<[keyof SbsShot, string]> = [["pdop", "PDOP"], ["hdop", "HDOP"], ["pcalc", "PCALC"], ["nsats", "NSats"], ["ageS", "Age Correction"]];
      system.absentFields = fields.filter(([key]) => system.shots.every((shot) => shot[key] === null)).map(([, label]) => label);
    }
    const startMs = Math.min(...populated.map((system) => system.shots[0].timeMs));
    const endMs = Math.max(...populated.map((system) => system.shots.at(-1)!.timeMs));
    const steps = new Map<number, number>();
    const reference = populated[0].shots;
    for (let index = 1; index < reference.length; index += 1) {
      const step = Math.round((reference[index].timeMs - reference[index - 1].timeMs) / 100) * 100;
      steps.set(step, (steps.get(step) ?? 0) + 1);
    }
    const intervalMs = [...steps.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 1000;
    return { lineName: this.lineName, systems: populated, startMs, endMs, intervalMs, shotCount: reference.length, missingRawQcShots: this.missingRawQcShots };
  }
}

export function parseSbs(text: string): SbsDataset {
  const parser = new SbsParser();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    parser.line(text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end));
    start = end + 1;
  }
  return parser.finish();
}

/** Streams an SBS file from disk. */
export async function parseSbsFile(file: string): Promise<SbsDataset> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const parser = new SbsParser();
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) parser.line(line);
  return parser.finish();
}

export interface SbsSummary {
  lineName: string;
  systems: Array<{ id: string; shots: number; startMs: number; endMs: number }>;
  startMs: number;
  endMs: number;
  intervalMs: number;
  shotCount: number;
}

/**
 * Light streaming check for the upload preview: validates the pages and
 * headers and returns counts and time span, without building shot objects.
 */
export async function scanSbsFile(file: string): Promise<SbsSummary> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const systems: SbsSummary["systems"] = [];
  let lineName = "";
  let current: SbsSummary["systems"][number] | undefined;
  let columns: ReturnType<typeof mapHeader> | undefined;
  const firstTimes: number[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const tab = rawLine.indexOf("\t");
    const head = tab < 0 ? rawLine : rawLine.slice(0, tab);
    if (head === "# Line name") {
      lineName ||= rawLine.slice(tab + 1).split("\t")[0].trim();
      continue;
    }
    if (/^Page\s+\d+$/.test(head)) {
      const page = (rawLine.split("\t")[1] ?? "").trim();
      current = { id: page.replace(/_QC$/i, ""), shots: 0, startMs: Infinity, endMs: -Infinity };
      systems.push(current);
      columns = undefined;
      continue;
    }
    if (head === "Shot") {
      columns = mapHeader(rawLine.split("\t"));
      if (columns.time < 0 || columns.fields.crpE === undefined || columns.fields.crpN === undefined) {
        throw new SbsParseError(`Page ${current?.id ?? "?"} has no Raw Time or CRP Easting/Northing column`);
      }
      continue;
    }
    if (!current || !columns || !/^\d/.test(head)) continue;
    const cells = rawLine.split("\t");
    const seconds = numberAt(cells, columns.time);
    if (seconds === null || numberAt(cells, columns.fields.crpE) === null) continue;
    const timeMs = Math.round(seconds * 1000);
    current.shots += 1;
    current.startMs = Math.min(current.startMs, timeMs);
    current.endMs = Math.max(current.endMs, timeMs);
    if (current === systems[0] && firstTimes.length < 200) firstTimes.push(timeMs);
  }
  const populated = systems.filter((system) => system.shots > 0);
  if (!populated.length) throw new SbsParseError("No DGNSS pages with shots were found");
  const steps = new Map<number, number>();
  firstTimes.sort((left, right) => left - right);
  for (let index = 1; index < firstTimes.length; index += 1) {
    const step = Math.round((firstTimes[index] - firstTimes[index - 1]) / 100) * 100;
    steps.set(step, (steps.get(step) ?? 0) + 1);
  }
  return {
    lineName,
    systems: populated,
    startMs: Math.min(...populated.map((system) => system.startMs)),
    endMs: Math.max(...populated.map((system) => system.endMs)),
    intervalMs: [...steps.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 1000,
    shotCount: populated[0].shots,
  };
}
