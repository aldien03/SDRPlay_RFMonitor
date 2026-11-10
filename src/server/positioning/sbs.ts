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
  /** Shots of this page whose raw QC block was all zero and was treated as missing. */
  missingRawQcShots?: number;
}

/** What one input file contributed (inside the parse window). */
export interface SbsFileStats {
  lineName: string;
  /** NaN when the file has no shots inside the window. */
  startMs: number;
  endMs: number;
  /** Shots of the file's fullest system (one per epoch). */
  epochs: number;
}

export interface SbsDataset {
  /** Distinct Gator line names, joined. */
  lineName: string;
  lineNames: string[];
  systems: SbsSystem[];
  startMs: number;
  endMs: number;
  /** Most common shot interval. */
  intervalMs: number;
  shotCount: number;
  /** Shots whose raw QC block was all zero (end-of-line export artefact) and was treated as missing. */
  missingRawQcShots: number;
  /** Time spans with Gator data: [first shot, last shot + interval), split where shots stop for more than 3 intervals. */
  coverage: Array<[number, number]>;
  /** Shots that appeared more than once for the same system and time (overlapping files); the first is kept. */
  duplicateShots: number;
  /** Repeated shots whose values differed from the kept one. */
  conflictingShots: number;
  /** One entry per input file, in input order. */
  files: SbsFileStats[];
}

/** Shots outside [fromMs, toMs) are skipped while parsing, so memory follows the report window. */
export interface SbsParseWindow {
  fromMs: number;
  toMs: number;
}

/** One parsed file before it is merged. */
export interface SbsPart {
  lineName: string;
  systems: SbsSystem[];
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

  constructor(private readonly window?: SbsParseWindow) {}

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
    const timeMs = Math.round(seconds * 1000);
    if (this.window && (timeMs < this.window.fromMs || timeMs >= this.window.toMs)) return;
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
      current.missingRawQcShots = (current.missingRawQcShots ?? 0) + 1;
    }
    if (pdop === 0) pdop = null;
    current.shots.push({
      shot: numberAt(cells, columns.shot) ?? current.shots.length + 1,
      timeMs,
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

  /** The file as parsed, before merging; may hold no shots when a window is set. */
  part(): SbsPart {
    return { lineName: this.lineName, systems: this.systems.filter((system) => system.shots.length) };
  }

  finish(): SbsDataset {
    return mergeSbs([this.part()]);
  }
}

function sameValue(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 1e-9;
}

function sameShot(left: SbsShot, right: SbsShot): boolean {
  return sameValue(left.crpE, right.crpE) && sameValue(left.crpN, right.crpN) && sameValue(left.nsats, right.nsats) && sameValue(left.hdop, right.hdop) && sameValue(left.pcalc, right.pcalc) && sameValue(left.ageS, right.ageS);
}

const RAW_LABELS: Array<[keyof SbsShot, string]> = [["pdop", "PDOP"], ["hdop", "HDOP"], ["pcalc", "PCALC"], ["nsats", "NSats"], ["ageS", "Age Correction"]];

/**
 * Combines Gator files into one dataset. Pages are matched by Gator system id
 * (a split export, or a page repeated inside one file, becomes one system),
 * shots are put in time order, and a shot repeated for the same system and
 * time (overlapping files) is kept once: the first file's copy wins.
 */
export class SbsMerger {
  private readonly byId = new Map<string, SbsSystem>();
  private readonly files: SbsFileStats[] = [];
  private readonly lineNames: string[] = [];

  add(part: SbsPart): void {
    const perId = new Map<string, number>();
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    for (const system of part.systems) {
      if (!system.shots.length) continue;
      perId.set(system.id, (perId.get(system.id) ?? 0) + system.shots.length);
      for (const shot of system.shots) {
        if (shot.timeMs < startMs) startMs = shot.timeMs;
        if (shot.timeMs > endMs) endMs = shot.timeMs;
      }
      const target = this.byId.get(system.id);
      if (!target) {
        this.byId.set(system.id, { id: system.id, page: system.page, shots: system.shots, absentFields: [], missingRawQcShots: system.missingRawQcShots ?? 0 });
        continue;
      }
      for (const shot of system.shots) target.shots.push(shot);
      target.missingRawQcShots = (target.missingRawQcShots ?? 0) + (system.missingRawQcShots ?? 0);
    }
    const epochs = Math.max(0, ...perId.values());
    this.files.push({ lineName: part.lineName, startMs: epochs ? startMs : Number.NaN, endMs: epochs ? endMs : Number.NaN, epochs });
    if (part.lineName && !this.lineNames.includes(part.lineName)) this.lineNames.push(part.lineName);
  }

  finish(): SbsDataset {
    const populated = [...this.byId.values()].filter((system) => system.shots.length);
    if (!populated.length) throw new SbsParseError("No DGNSS pages with shots were found");
    let duplicateShots = 0;
    let conflictingShots = 0;
    let total = 0;
    for (const system of populated) {
      // Stable sort: equal times keep input order, so the first file's shot is kept.
      system.shots.sort((left, right) => left.timeMs - right.timeMs);
      let write = 0;
      for (let read = 0; read < system.shots.length; read += 1) {
        const shot = system.shots[read];
        const kept = write > 0 ? system.shots[write - 1] : undefined;
        if (kept && kept.timeMs === shot.timeMs) {
          duplicateShots += 1;
          if (!sameShot(kept, shot)) conflictingShots += 1;
          continue;
        }
        system.shots[write] = shot;
        write += 1;
      }
      system.shots.length = write;
      total += write;
      system.absentFields = RAW_LABELS.filter(([key]) => system.shots.every((shot) => shot[key] === null)).map(([, label]) => label);
    }
    const startMs = Math.min(...populated.map((system) => system.shots[0].timeMs));
    const endMs = Math.max(...populated.map((system) => system.shots.at(-1)!.timeMs));
    const steps = new Map<number, number>();
    const reference = populated[0];
    for (let index = 1; index < reference.shots.length; index += 1) {
      const step = Math.round((reference.shots[index].timeMs - reference.shots[index - 1].timeMs) / 100) * 100;
      if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1);
    }
    const intervalMs = [...steps.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 1000;

    // Coverage over every system's shot times.
    const times = new Float64Array(total);
    let offset = 0;
    for (const system of populated) for (const shot of system.shots) times[offset++] = shot.timeMs;
    times.sort();
    const coverage: Array<[number, number]> = [];
    for (const time of times) {
      const last = coverage.at(-1);
      if (last && time - (last[1] - intervalMs) <= intervalMs * 3) last[1] = Math.max(last[1], time + intervalMs);
      else coverage.push([time, time + intervalMs]);
    }

    return {
      lineName: this.lineNames.join(", "),
      lineNames: [...this.lineNames],
      systems: populated,
      startMs,
      endMs,
      intervalMs,
      shotCount: reference.shots.length,
      missingRawQcShots: reference.missingRawQcShots ?? 0,
      coverage,
      duplicateShots,
      conflictingShots,
      files: this.files,
    };
  }
}

export function mergeSbs(parts: SbsPart[]): SbsDataset {
  const merger = new SbsMerger();
  for (const part of parts) merger.add(part);
  return merger.finish();
}

export function parseSbs(text: string, window?: SbsParseWindow): SbsDataset {
  const parser = new SbsParser(window);
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    parser.line(text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end));
    start = end + 1;
  }
  return parser.finish();
}

async function parsePart(file: string, window?: SbsParseWindow): Promise<SbsPart> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const parser = new SbsParser(window);
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) parser.line(line);
  return parser.part();
}

/** Streams an SBS file from disk. */
export async function parseSbsFile(file: string, window?: SbsParseWindow): Promise<SbsDataset> {
  return mergeSbs([await parsePart(file, window)]);
}

/**
 * Streams several SBS files (one at a time) into one dataset. Each file's
 * shots are merged before the next file is read, so only the window's
 * shots are ever held.
 */
export async function parseSbsFiles(files: string[], window?: SbsParseWindow, onFile?: (index: number) => void): Promise<SbsDataset> {
  const merger = new SbsMerger();
  for (const [index, file] of files.entries()) {
    onFile?.(index);
    merger.add(await parsePart(file, window));
  }
  return merger.finish();
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
