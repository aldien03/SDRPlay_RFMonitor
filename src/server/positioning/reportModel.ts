/** One model, two renderers (HTML and PDF). Tables first, no narrative. */
import type { ChartSpec } from "../report/chartSpec";
import { durationText, utcDateTime, utcTime } from "../report/format";
import { limitText, metres, type PositioningAnalysis, type SpreadStats } from "./analysis";
import { buildPositioningCharts, colorOf } from "./charts";
import { groupSeries, relateRfToNavigation, RF_RULES, RF_TYPE_LABEL, type RfEpisode, type RfLaneAnalysis } from "./rfAnalysis";
import { relationshipCharts, rfLaneCharts } from "./rfCharts";
import type { PositioningReportIdentity } from "./types";

export type Status = "PASS" | "FAIL" | "ALERT" | "CHECK" | "INFO";

export interface ReportTable {
  columns: Array<{ title: string; width: number; align?: "left" | "right" | "center" }>;
  rows: string[][];
  /** Column holding a Status value, coloured by the renderers. */
  statusColumn?: number;
}

export type TableId = "project" | "result" | "events" | "motion" | "systems" | "stats" | "control" | "quality" | "lanes" | "incidents" | "evidence" | "sources" | "rfSummary" | "rfEpisodes" | "relationship";

export interface KeyItem {
  name: string;
  color: string;
  dash?: boolean;
}

export type ReportBlock =
  | { table: TableId; heading?: string }
  | { chart: string }
  | { charts: string[] }
  | { pair: [string, string]; key: KeyItem[] }
  | { notes: true; heading: string };

export interface ReportPage {
  title: string;
  /** Continue on the current page when there is room, instead of starting a new one. */
  flow?: boolean;
  blocks: ReportBlock[];
}

export interface PositioningReportModel {
  title: string;
  subtitle: string;
  firstObs: string;
  lastObs: string;
  source: string;
  generatedAtText: string;
  generatedAt: string;
  vesselName: string;
  simulatedRf: boolean;
  verdict: string;
  verdictStatus: Status;
  tables: Record<TableId, ReportTable>;
  notes: string[];
  pages: ReportPage[];
  charts: ChartSpec[];
  /** CSV data for the evidence package (data/<name>). */
  dataFiles: Array<{ name: string; content: string }>;
}

const fixed = (value: number | undefined, decimals: number) => (value !== undefined && Number.isFinite(value) ? value.toFixed(decimals) : "–");
const pct = (fraction: number) => (Number.isFinite(fraction) ? `${(fraction * 100).toFixed(fraction >= 0.999 || fraction === 0 ? 0 : 1)}` : "–");

function spreadText(stats: SpreadStats | undefined, decimals: number, withMin: boolean): string {
  if (!stats) return "Not output";
  return withMin ? `${fixed(stats.median, decimals)} (${fixed(stats.min, decimals)}–${fixed(stats.max, decimals)})` : `${fixed(stats.median, decimals)} (${fixed(stats.max, decimals)})`;
}

function span(fromMs: number, toMs: number): string {
  return `${utcTime(fromMs)}–${utcTime(toMs)}`;
}

function duration(ms: number): string {
  return durationText(new Date(0).toISOString(), new Date(ms).toISOString());
}

export function buildPositioningReportModel(input: {
  analysis: PositioningAnalysis;
  identity: PositioningReportIdentity;
  /** Input SBS files, in parse order (dataset.files has the same order). */
  files: Array<{ name: string; bytes: number; sha256: string }>;
  generatedAt: Date;
  /** Spectrum-level RF analysis; without it only RF lane states are reported. */
  rf?: { lanes: RfLaneAnalysis[]; episodes: RfEpisode[]; sourceText: string };
}): PositioningReportModel {
  const { analysis, identity } = input;
  const { thresholds, systems, dataset, motion, events } = analysis;
  const simulatedRf = analysis.rf.source === "simulated";
  const limit = limitText(thresholds.agreementM);
  const control = systems.find((system) => system.isControl)!;
  const others = systems.filter((system) => !system.isControl);
  const largest = (pick: (stats: NonNullable<(typeof others)[number]["vsControl"]>) => number) => {
    const candidates = others.filter((system) => system.vsControl && Number.isFinite(pick(system.vsControl)));
    const best = candidates.reduce<(typeof others)[number] | undefined>((top, system) => (!top || pick(system.vsControl!) > pick(top.vsControl!) ? system : top), undefined);
    return best ? { system: best, value: pick(best.vsControl!) } : undefined;
  };
  const staticWorst = largest((stats) => (stats.static.n ? stats.static.max : Number.NaN));
  const staticP95 = Math.max(0, ...others.map((system) => (system.vsControl?.static.n ? system.vsControl.static.p95 : 0)));
  const crossWorst = largest((stats) => stats.underWay?.crossMax ?? Number.NaN);
  const steadyWorst = largest((stats) => (stats.underWay ? Math.abs(stats.underWay.alongSteadyM) : Number.NaN));
  const underWay = others.some((system) => system.vsControl?.underWay);
  const failures = analysis.agreementFailures;
  const label = motion.state === "static" ? "Static" : motion.state === "dynamic" ? "Dynamic" : "Mixed";
  const name = (system: (typeof systems)[number]) => `${system.config.receiver} · ${system.config.output}`;
  const coverage = analysis.positioningCoverage;
  const gapText = (list: Array<[number, number]>) => (list.length <= 3 ? list.map(([from, to]) => `${span(from, to)} UTC`).join(", ") : `${list.length} gaps, longest ${duration(Math.max(...list.map(([from, to]) => to - from)))}`);
  const multiFile = input.files.length > 1;
  const continuityIssues = [
    coverage.gaps.length ? `No Gator data ${gapText(coverage.gaps)}` : undefined,
    dataset.conflictingShots ? `${dataset.conflictingShots.toLocaleString("en-GB")} repeated shot(s) differ between files; first file used` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  const continuityRow: string[] | undefined = multiFile || coverage.gaps.length || dataset.duplicateShots
    ? [
        "Gator data continuity",
        "No gaps",
        [
          multiFile ? `${input.files.length} SBS files combined` : undefined,
          ...continuityIssues,
          dataset.duplicateShots ? `${dataset.duplicateShots.toLocaleString("en-GB")} repeated shot(s) counted once` : undefined,
        ].filter(Boolean).join("; ") || "No gaps",
        continuityIssues.length ? "CHECK" : "INFO",
        "A2",
      ]
    : undefined;

  // ---- result checks ----------------------------------------------------------
  const interference = events.filter((event) => event.kind === "rf-and-nav-common");
  const commonNoRf = events.filter((event) => event.kind === "nav-common-no-rf" || event.kind === "nav-common-rf-unknown");
  const chainEvents = events.filter((event) => ["antenna-group", "single-receiver", "single-solution", "correction-link"].includes(event.kind));
  const rfEpisodes = analysis.lanes.flatMap((summary) => summary.lane.intervals.filter((interval) => interval.state === "anomaly").map((interval) => ({ lane: summary.lane, ...interval })));
  const rfLanesHit = [...new Set(rfEpisodes.map((episode) => episode.lane.shortLabel))];
  const gnssCoverage = Math.min(...analysis.lanes.filter((summary) => summary.lane.service === "gnss").map((summary) => summary.monitoredFraction));
  /** "E1" / "E1, E4" / "E1–E35 (35)" so long days stay readable. */
  const ids = (input: typeof events) => {
    const list = [...input].sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
    return list.length <= 3 ? list.map((event) => event.id).join(", ") : `${list[0].id}–${list.at(-1)!.id} (${list.length})`;
  };
  /** Same findings grouped: "PCALC changes on DGPS4 only ×35 (E1–E35 (35))". */
  const grouped = (list: typeof events) => [...new Map(list.map((event) => [event.title, list.filter((other) => other.title === event.title)])).entries()]
    .map(([title, group]) => (group.length > 1 ? `${title} ×${group.length} (${ids(group)})` : `${group[0].id} ${title}`))
    .join("; ");
  const series = input.rf ? groupSeries(analysis) : [];
  const relation = input.rf ? relateRfToNavigation(analysis, input.rf, series) : { impacts: [], stats: [] };
  const impactRank = { alert: 3, check: 2, info: 1 } as const;
  const worstImpact = [...relation.impacts].sort((left, right) => impactRank[right.level] - impactRank[left.level])[0];
  const jammingRow: string[] = input.rf
    ? [
        "GNSS interference / jamming",
        "No impact",
        relation.impacts.length ? relation.impacts.map((impact) => `${impact.episode.id} ${RF_TYPE_LABEL[impact.episode.type]} on ${impact.episode.shortLabel}${impact.episode.simulated ? " (SIM)" : ""}: ${impact.level === "alert" ? "both antennas degraded" : impact.level === "check" ? (impact.covered ? "one antenna degraded" : "no Gator data") : "no positioning impact"}`).join("; ") : "No interference episodes",
        !worstImpact ? "PASS" : worstImpact.level === "alert" ? "ALERT" : worstImpact.level === "check" ? "CHECK" : "INFO",
        "A1",
      ]
    : ["RF anomalies (rf-monitor)", "None", "", "", "A1"];
  const result: ReportTable = {
    columns: [{ title: "Check", width: 23 }, { title: "Criterion", width: 18 }, { title: "Result", width: 42 }, { title: "Status", width: 10, align: "center" }, { title: "See", width: 7, align: "center" }],
    statusColumn: 3,
    rows: [
      ...(underWay
        ? [
            ...(staticWorst ? [["CRP agreement, static", `≤ ${limit} from ${control.id} (below ${motion.alongTrackKnots} kn)`, `Max ${metres(staticWorst.value)} (${staticWorst.system.id}); 95% ≤ ${metres(staticP95)}`, staticWorst.value <= thresholds.agreementM ? "PASS" : "FAIL", "A3"]] : []),
            [
              "CRP agreement under way",
              `≤ ${limit} across track; steady along track ≤ ${limit}`,
              `Across-track max ${crossWorst ? `${metres(crossWorst.value)} (${crossWorst.system.id})` : "–"}; steady along-track ≤ ${steadyWorst ? `${metres(steadyWorst.value)} (${steadyWorst.system.id})` : "–"}`,
              (crossWorst?.value ?? 0) <= thresholds.agreementM && (steadyWorst?.value ?? 0) <= thresholds.agreementM ? "PASS" : "FAIL",
              "A3",
            ],
          ]
        : [["CRP agreement with control", `≤ ${limit} from ${control.id}`, staticWorst ? `Max ${metres(staticWorst.value)} (${staticWorst.system.id}); 95% ≤ ${metres(staticP95)}` : "–", failures.length ? "FAIL" : "PASS", "A3"]]),
      ["Interference affecting positioning", "None", interference.length ? `${interference.length} event(s): ${ids(interference)}` : commonNoRf.length ? `Common degradation without RF evidence: ${ids(commonNoRf)}` : "None", interference.length ? "ALERT" : commonNoRf.length ? "CHECK" : "PASS", "A1"],
      input.rf ? jammingRow : ["RF anomalies (rf-monitor)", "None", rfEpisodes.length ? `${rfEpisodes.length} episode(s) on ${rfLanesHit.join(", ")}; ${duration(rfEpisodes.reduce((sum, episode) => sum + episode.toMs - episode.fromMs, 0))} total` : "None", rfEpisodes.length ? "INFO" : "PASS", "A1"],
      ["Single-chain anomalies", "None", chainEvents.length ? grouped(chainEvents) : "None", chainEvents.length ? "CHECK" : "PASS", chainEvents.length ? "Events" : "–"],
      ["Data coverage", "Full window", `Gator ${pct(coverage.fraction)}%; GNSS RF monitored ≥ ${pct(gnssCoverage)}%`, coverage.fraction >= 0.999 && gnssCoverage >= 0.9 ? "PASS" : "INFO", "A1, A2"],
      ...(continuityRow ? [continuityRow] : []),
    ],
  };
  const verdictStatus: Status = interference.length || worstImpact?.level === "alert" ? "ALERT" : failures.length ? "FAIL" : commonNoRf.length || chainEvents.length ? "CHECK" : "PASS";

  const eventsTable: ReportTable = {
    columns: [{ title: "ID", width: 5 }, { title: "Time (UTC)", width: 13 }, { title: "Finding", width: 25 }, { title: "Basis", width: 33 }, { title: "Action", width: 24 }],
    rows: events.map((event) => {
      const episode = input.rf?.episodes.find((entry) => entry.fromMs < event.toMs && entry.toMs > event.fromMs);
      const title = episode ? event.title.replace("RF anomaly on", `${RF_TYPE_LABEL[episode.type]} interference (${episode.id}) on`) : event.title;
      return [event.id, span(event.fromMs, event.toMs), title, `${event.explanation} [${event.evidence}]`, event.action];
    }),
  };

  const shotsAll = motion.shots.all.n;
  const motionRow = (name: string, stats: typeof motion.shots.all, threshold: string) => [name, String(stats.n), fixed(stats.min, 2), fixed(stats.max, 2), fixed(stats.mean, 2), fixed(stats.median, 2), shotsAll ? fixed((stats.n / shotsAll) * 100, 1) : "–", threshold];
  const motionTable: ReportTable = {
    columns: [{ title: "Period", width: 16 }, { title: "Shots", width: 10, align: "right" }, { title: "Min kn", width: 11, align: "right" }, { title: "Max kn", width: 11, align: "right" }, { title: "Mean kn", width: 11, align: "right" }, { title: "Median kn", width: 12, align: "right" }, { title: "% of shots", width: 13, align: "right" }, { title: "Speed", width: 16, align: "right" }],
    rows: shotsAll
      ? [
          ...(motion.shots.static.n ? [motionRow("Static", motion.shots.static, `≤ ${thresholds.movingKnots} kn`)] : []),
          ...(motion.shots.underWay.n ? [motionRow("Under way", motion.shots.underWay, `> ${thresholds.movingKnots} kn`)] : []),
          motionRow(`All (${label.toLowerCase()})`, motion.shots.all, "–"),
        ]
      : [[label, String(motion.n), fixed(motion.minKnots, 2), fixed(motion.maxKnots, 2), fixed(motion.meanKnots, 2), fixed(motion.medianKnots, 2), fixed(motion.movingFraction * 100, 1), `> ${thresholds.movingKnots} kn`]],
  };

  const systemsTable: ReportTable = {
    columns: [{ title: "System", width: 11 }, { title: "Entered Name", width: 25 }, { title: "Antenna", width: 24 }, { title: "Beam", width: 12 }, { title: "Use", width: 14, align: "center" }],
    rows: systems.map((system) => [system.id, name(system), system.config.antenna, system.config.beam, system.isControl ? "Control" : "Comparison"]),
  };

  const basis = systems.find((system) => system.ellipse)?.ellipse?.basis;
  const delta = basis === "control-delta";
  const statsTable: ReportTable = {
    columns: [{ title: "System", width: 11 }, { title: "N", width: 8, align: "right" }, { title: delta ? "Mean dE" : "Mean E", width: 15, align: "right" }, { title: delta ? "Mean dN" : "Mean N", width: 15, align: "right" }, { title: "SD E", width: 9, align: "right" }, { title: "SD N", width: 9, align: "right" }, { title: "SMA", width: 9, align: "right" }, { title: "SMI", width: 9, align: "right" }, { title: "Orient.", width: 9, align: "right" }],
    rows: systems.map((system) => {
      const ellipse = system.ellipse;
      return [system.id, String(system.shots.length), fixed(ellipse?.meanE, 3), fixed(ellipse?.meanN, 3), fixed(ellipse?.sdE, 3), fixed(ellipse?.sdN, 3), fixed(ellipse?.sma, 3), fixed(ellipse?.smi, 3), ellipse ? `${ellipse.orientDeg.toFixed(1)}°` : "–"];
    }),
  };

  const controlTable: ReportTable = underWay
    ? {
        columns: [{ title: "Sensor / Control", width: 20 }, { title: "Static N", width: 10, align: "right" }, { title: "Static max (m)", width: 11, align: "right" }, { title: "Static 95% (m)", width: 11, align: "right" }, { title: "Under way N", width: 11, align: "right" }, { title: "Across max (m)", width: 12, align: "right" }, { title: "Across 95% (m)", width: 12, align: "right" }, { title: "Steady along (m)", width: 13, align: "right" }],
        rows: others.map((system) => {
          const stats = system.vsControl!;
          const moving = stats.underWay;
          return [`${system.id} / ${control.id}`, String(stats.static.n), stats.static.n ? fixed(stats.static.max, 3) : "–", stats.static.n ? fixed(stats.static.p95, 3) : "–", String(moving?.n ?? 0), fixed(moving?.crossMax, 3), fixed(moving?.crossP95, 3), fixed(moving?.alongSteadyM, 3)];
        }),
      }
    : {
        columns: [{ title: "Sensor / Control", width: 22 }, { title: "N", width: 10, align: "right" }, { title: "Min (m)", width: 13, align: "right" }, { title: "Max (m)", width: 13, align: "right" }, { title: "Average (m)", width: 14, align: "right" }, { title: "95% (m)", width: 13, align: "right" }, { title: `≤ ${limit} (%)`, width: 15, align: "right" }],
        rows: others.map((system) => {
          const stats = system.vsControl!;
          return [`${system.id} / ${control.id}`, String(stats.n), fixed(stats.min, 3), fixed(stats.max, 3), fixed(stats.mean, 3), fixed(stats.p95, 3), pct(stats.withinLimit)];
        }),
      };

  const qualityTable: ReportTable = {
    columns: [{ title: "System", width: 11 }, { title: "#Sats med (min–max)", width: 18 }, { title: "HDOP med (max)", width: 14 }, { title: "PDOP med (max)", width: 14 }, { title: "Age s med (max)", width: 14 }, { title: "PCALC code×shots (changes)", width: 17 }, { title: "Flagged", width: 12 }],
    rows: systems.map((system) => {
      const q = system.quality;
      const codes = q.pcalcCodes.map(([code, count]) => `${code}×${count}`).join(", ");
      const flagged = system.flags.size;
      return [system.id, spreadText(q.sats, 0, true), spreadText(q.hdop, 1, false), spreadText(q.pdop, 1, false), spreadText(q.age, 0, false), q.pcalcUsual === undefined ? "Not output" : `${codes} (${q.pcalcChanges})`, flagged ? `${flagged} shots` : "None"];
    }),
  };

  const laneTable: ReportTable = {
    columns: [{ title: "RF lane (rf-monitor)", width: 40 }, { title: "Monitored (%)", width: 16, align: "right" }, { title: "Anomaly time", width: 18, align: "right" }, { title: "Episodes", width: 12, align: "right" }, { title: "Systems", width: 14 }],
    rows: analysis.lanes.map((summary) => [
      summary.lane.label,
      pct(summary.monitoredFraction),
      summary.anomalyMs ? duration(summary.anomalyMs) : "None",
      String(summary.anomalyCount),
      summary.lane.service === "gnss" ? "All" : systems.filter((system) => `fugro-${system.config.beam.toLowerCase()}` === summary.lane.id).map((system) => system.id.replace("DGPS", "")).join(", ") || "–",
    ]),
  };
  const incidentTable: ReportTable = {
    columns: [{ title: "Incident", width: 12 }, { title: "Time (UTC)", width: 18 }, { title: "Title", width: 46 }, { title: "Evidence", width: 12 }, { title: "Event", width: 8 }],
    rows: analysis.rf.incidents
      .filter((incident) => incident.toMs > analysis.window.startMs && incident.fromMs < analysis.window.endMs)
      .map((incident) => [incident.id, span(incident.fromMs, incident.toMs), incident.title, incident.evidenceStrength, events.find((event) => incident.fromMs < event.toMs && incident.toMs > event.fromMs)?.id ?? "–"]),
  };

  const f1 = (value: number | undefined) => fixed(value, 1);
  const rfSummary: ReportTable = {
    columns: [{ title: "RF band (rf-monitor)", width: 20 }, { title: "Frames", width: 8, align: "right" }, { title: "Monitored %", width: 10, align: "right" }, { title: "Mean / usual level", width: 12, align: "right" }, { title: "Peak excess ×", width: 10, align: "right" }, { title: "Raised band max %", width: 11, align: "right" }, { title: "Power dBm med (max)", width: 13, align: "right" }, { title: "SNR dB med (min)", width: 11, align: "right" }, { title: "Episodes", width: 8, align: "right" }],
    rows: (input.rf?.lanes ?? []).map((lane) => [
      lane.definition.label,
      lane.stats.frames.toLocaleString("en-GB"),
      pct(lane.stats.monitoredFraction),
      lane.stats.frames ? `${f1(lane.stats.meanLevel)} / ${f1(lane.stats.usualLevel)}` : "–",
      lane.stats.frames ? f1(lane.stats.peakZMax) : "–",
      lane.stats.frames ? fixed(lane.stats.occupiedMax * 100, 0) : "–",
      lane.stats.powerMedian !== undefined ? `${f1(lane.stats.powerMedian)} (${f1(lane.stats.powerMax)})` : "–",
      lane.stats.snrMedian !== undefined ? `${f1(lane.stats.snrMedian)} (${f1(lane.stats.snrMin)})` : "–",
      lane.stats.frames ? String(lane.episodes.length) : "Not monitored",
    ]),
  };
  const groupText = (impact: (typeof relation.impacts)[number]) =>
    impact.covered
      ? impact.groups.map((group) => `${group.group}: sats ${group.satsLossPct !== undefined ? `${group.satsLossPct >= 0 ? "−" : "+"}${Math.abs(group.satsLossPct).toFixed(0)}%` : "–"}, HDOP ${group.hdopRise !== undefined ? `${group.hdopRise >= 0 ? "+" : "−"}${Math.abs(group.hdopRise).toFixed(1)}` : "–"}, range ${group.maxRangeM !== undefined ? metres(group.maxRangeM) : "–"}`).join("; ")
      : "No Gator data";
  const rfEpisodesTable: ReportTable = {
    columns: [{ title: "ID", width: 6 }, { title: "Band", width: 11 }, { title: "Time (UTC)", width: 12 }, { title: "Type", width: 11 }, { title: "Signal", width: 22 }, { title: "Navigation impact (vs 5 min before)", width: 22 }, { title: "Assessment", width: 16 }],
    rows: relation.impacts.map((impact) => {
      const episode = impact.episode;
      const signal = [
        episode.centreMHz !== undefined ? `centre ${episode.centreMHz.toFixed(2)} MHz` : undefined,
        episode.widthMHz !== undefined ? `width ${episode.widthMHz.toFixed(2)} MHz` : undefined,
        `peak ${episode.peakZ.toFixed(0)}×`,
        `${(episode.occupiedMax * 100).toFixed(0)}% raised`,
        episode.powerRiseDb !== undefined ? `power +${episode.powerRiseDb.toFixed(1)} dB` : undefined,
        `${episode.raisedFrames}/${episode.frames} frames`,
      ].filter(Boolean).join(", ");
      return [`${episode.id}${episode.simulated ? " SIM" : ""}`, episode.shortLabel, span(episode.fromMs, episode.toMs), RF_TYPE_LABEL[episode.type], signal, groupText(impact), impact.assessment];
    }),
  };
  const relationshipTable: ReportTable = {
    columns: [{ title: "RF band", width: 15 }, { title: "Antenna group", width: 13 }, { title: "Shots paired", width: 11, align: "right" }, { title: "Raised shots", width: 11, align: "right" }, { title: "Spearman r", width: 11, align: "right" }, { title: "Best lag (s)", width: 11, align: "right" }, { title: "Reading", width: 28 }],
    rows: relation.stats.map((stat) => {
      const reading = stat.raisedPairs < 5 ? "Too little RF excess to test" : stat.r === undefined ? "No variation" : stat.r >= 0.5 ? "Strong: satellite loss follows RF" : stat.r >= 0.3 ? "Moderate: loss rises with RF" : "No relationship";
      return [stat.laneLabel, stat.group, String(stat.pairs), String(stat.raisedPairs), stat.r !== undefined ? stat.r.toFixed(2) : "–", stat.lagS !== undefined ? String(stat.lagS) : "–", reading];
    }),
  };

  const project: ReportTable = {
    columns: [{ title: "Vessel", width: 15 }, { title: "Client", width: 25 }, { title: "Survey", width: 19 }, { title: "Location", width: 25 }, { title: "Geodetics", width: 16 }],
    rows: [[identity.vesselName, identity.clientName ?? "–", identity.survey ?? "–", [identity.harbour, identity.area].filter(Boolean).join(" · ") || "–", identity.geodetics ?? "–"]],
  };

  const evidence: ReportTable = {
    columns: [{ title: "Item", width: 22 }, { title: "Value", width: 78 }],
    rows: [
      multiFile
        ? ["Gator SBS files", `${input.files.length} files, ${input.files.reduce((sum, file) => sum + file.bytes, 0).toLocaleString("en-GB")} bytes; see A2`]
        : ["Gator SBS file", `${input.files[0]?.name ?? "–"} (${(input.files[0]?.bytes ?? 0).toLocaleString("en-GB")} bytes)`],
      ...(multiFile ? [] : [["SBS SHA-256", input.files[0]?.sha256 ?? "–"]]),
      ["Gator line / shots", `${dataset.lineName || "–"} · ${dataset.shotCount.toLocaleString("en-GB")} shots × ${dataset.systems.length} systems at ${dataset.intervalMs / 1000} s`],
      ["Report window (UTC)", `${utcDateTime(analysis.window.startMs)} – ${utcDateTime(analysis.window.endMs)} (${analysis.window.mode === "sbs" ? "SBS span" : analysis.window.mode === "utc-day" ? "UTC day" : "custom"})`],
      ["Gator coverage", `${utcTime(coverage.fromMs)}–${utcTime(coverage.toMs)} UTC (${pct(coverage.fraction)}% of window)${coverage.gaps.length ? `; no data ${gapText(coverage.gaps)}` : ""}`],
      ...(dataset.duplicateShots ? [["Repeated shots", `${dataset.duplicateShots.toLocaleString("en-GB")} counted once${dataset.conflictingShots ? `; ${dataset.conflictingShots.toLocaleString("en-GB")} differed, first file used` : ""}`]] : []),
      ["Control / threshold", `${control.id} (${name(control)}) / ${limit}`],
      ["RF evidence source", input.rf?.sourceText ?? (simulatedRf ? "SIMULATED (mock-up)" : "rf-monitor evidence store")],
      ["rf-monitor incidents", analysis.rf.incidents.length ? analysis.rf.incidents.map((incident) => incident.id).join(", ") : "None"],
    ],
  };

  const sources: ReportTable = {
    columns: [{ title: "#", width: 4, align: "right" }, { title: "File", width: 22 }, { title: "Gator line", width: 12 }, { title: "First obs (UTC)", width: 14 }, { title: "Last obs (UTC)", width: 14 }, { title: "Shots in window", width: 9, align: "right" }, { title: "SHA-256", width: 25 }],
    rows: input.files.map((file, index) => {
      const stats = dataset.files[index];
      const used = stats && stats.epochs > 0;
      return [
        String(index + 1),
        `${file.name} (${file.bytes.toLocaleString("en-GB")} bytes)`,
        stats?.lineName || "–",
        used ? utcDateTime(stats.startMs).replace(" UTC", "") : "Outside window",
        used ? utcDateTime(stats.endMs).replace(" UTC", "") : "–",
        used ? stats.epochs.toLocaleString("en-GB") : "0",
        file.sha256,
      ];
    }),
  };

  // Largest along-track spread from the logging (95th percentile, s): all systems, or any system against the control.
  const loggingSeconds = Math.max(
    1,
    Math.ceil(Math.max(0, ...[analysis.commonTiming?.p95Seconds, ...others.map((system) => system.vsControl?.underWay?.timing.p95Seconds)].filter((value): value is number => value !== undefined && Number.isFinite(value))) * 2) / 2,
  );
  const absent = systems.filter((system) => system.absentFields.length).map((system) => `${system.id} ${system.absentFields.join("/")}`);
  const notes = [
    ...(input.rf ? [`RF: each frame typed with the rf-monitor Standard rules (wideband ≥ ${RF_RULES.widebandOccupancy * 100}% of band raised; partial-band block > ${RF_RULES.partialWidth * 100}%; noise floor median ≥ ${RF_RULES.noiseFloorSigma}×; narrowband peak ≥ ${RF_RULES.narrowbandPeakSigma}×). Episode = ${RF_RULES.alertVisits} of ${RF_RULES.alertWindow} frames raised, ends after ${RF_RULES.clearVisits} clear frames. Levels relative 0–255; dBm/SNR as reported by SDRconnect. Jamming-type = wideband, partial-band or noise-floor interference.`, "RF–navigation: per Gator shot, nearest RF frame within 5 s; satellite loss = median per antenna group, % of each system's own median; Spearman r at zero lag, best lag searched ±120 s. Impact = during episode minus 5 min before."] : []),
    `Positions: SST (vessel CRP) Easting/Northing reduced by Gator from each DGPS. Deltas = system − ${control.id} at the same shot.`,
    ...(underWay ? [`Under way (≥ ${motion.alongTrackKnots} kn): Gator logs one position per DGPS every ${dataset.intervalMs / 1000} s without aligning the DGPS to one instant, so positions differ along track by up to about ${loggingSeconds} s of travel. Agreement is judged across track at every shot and by the steady (median) along-track offset to a reference track (median of all systems, local quadratic over ±15 s); along-track differences are not assessed and are left out of the 2D statistics and delta figures from ${limitText(Math.min(0.2, thresholds.agreementM / 2))}.`] : []),
    `Flags against each system's own median: #Sats < ${Math.round((1 - thresholds.satsDropFraction) * 100)}% and −${thresholds.satsDropMin}; HDOP > ${thresholds.hdopFactor}× and +${thresholds.hdopExcess}; Age > +${thresholds.ageExcessS} s; PCALC ≠ usual code; CRP > ${limit} from control (the control is flagged when most comparisons exceed together).`,
    `Ellipse: 95% (chi-square 5.991) on ${delta ? "deltas to control (vessel moving)" : "positions (vessel static)"}; Orient. = major-axis bearing from grid north. Flags < ${thresholds.mergeGapS / 60} min apart form one run; runs and RF anomalies < 1 min apart form one event.`,
    `[OK]/[AB] flags ignored. All-zero raw QC (${dataset.missingRawQcShots} end-of-line shot(s)) treated as missing.${absent.length ? ` Not output: ${absent.join(", ")}.` : ""}${systems.every((system) => system.heightConstant) ? " Antenna height held constant by Gator; not assessed." : ""}`,
  ];

  const charts = buildPositioningCharts(analysis);
  const rfPages: ReportPage[] = [];
  if (input.rf) {
    const gnss = input.rf.lanes.filter((lane) => lane.definition.service === "gnss" && lane.stats.frames);
    const primary = [...gnss].sort((left, right) => Math.max(0, ...right.episodes.map((episode) => episode.peakZ)) - Math.max(0, ...left.episodes.map((episode) => episode.peakZ)))[0] ?? gnss[0];
    charts.push(...relationshipCharts(analysis, primary, series));
    const detailed = input.rf.lanes.filter((lane) => lane.stats.frames && (lane.episodes.length || lane === primary));
    for (const lane of detailed) charts.push(...rfLaneCharts(analysis, lane));
    rfPages.push(
      { title: "RF Interference and Jamming Analysis (rf-monitor)", flow: true, blocks: [{ table: "rfSummary", heading: "RF Signal Summary" }, { table: "rfEpisodes", heading: "Interference Episodes" }, { table: "relationship", heading: "RF and Navigation Relationship" }, { chart: "evidence-timeline" }] },
      { title: `RF and Navigation Relationship${primary ? ` (${primary.definition.shortLabel})` : ""}`, blocks: [{ charts: ["rel-excess", "rel-sats", "rel-range"] }, { chart: "rel-scatter" }] },
      ...detailed.map((lane) => ({ title: `RF Signal: ${lane.definition.label}`, blocks: [{ charts: ["waterfall", "level", "excess", "occupied", "power", "spectrum"].map((key) => `rf-${lane.definition.id}-${key}`) }] as ReportBlock[] })),
    );
  }

  const pages: ReportPage[] = [
    { title: "", blocks: [{ table: "project" }, { table: "result", heading: "Verification Result" }, { table: "events", heading: "Events and Actions (rules: A3)" }, { table: "motion", heading: "Vessel Motion Classification" }, { table: "systems", heading: "Systems Used" }, { table: "stats", heading: "Individual System Position Statistics (95% ellipse)" }] },
    ...rfPages,
    { title: `All Sensor Delta and Range Time Series Relative to ${control.id} (${name(control)})`, blocks: [{ chart: "delta-e" }, { chart: "delta-n" }, { chart: "delta-range" }] },
    ...(underWay ? [{ title: `Under Way Agreement Relative to ${control.id}`, flow: true, blocks: [{ chart: "uw-cross" }] as ReportBlock[] }] : []),
    { title: `All Sensor Delta Scatter Relative to ${control.id} (Control = 0)`, blocks: [{ pair: ["scatter-overview", "scatter-detail"], key: [...others.map((system) => ({ name: system.id, color: colorOf(analysis, system.id) })), { name: `Threshold (${limit})`, color: "#c8102e", dash: true }, { name: `Control ${control.id}`, color: "#14212e" }] }, { table: "control", heading: "Distance from Control Summary (method: A3)" }, { table: "quality", heading: "Solution Quality" }] },
    ...(input.rf ? [] : [{ title: "RF Environment (rf-monitor)", blocks: [{ chart: "evidence-timeline" }, { table: "lanes", heading: "RF Lane Coverage" }, { table: "incidents", heading: "rf-monitor Incidents" }] as ReportBlock[] }]),
    ...systems.map((system) => ({ title: `${system.id} Time Series (${name(system)})`, blocks: [{ charts: ["rf", "sats", "age", "pcalc", "hdop", "pdop"].map((key) => `sys-${system.id}-${key}`) }] as ReportBlock[] })),
    ...(motion.state !== "static" ? [{ title: "Vessel Speed Time Series", blocks: [{ chart: "speed" }] as ReportBlock[] }] : []),
    { title: "Appendix A · Evidence and Method", blocks: [{ table: "evidence", heading: "A1 · Evidence" }, { table: "sources", heading: "A2 · SBS source files" }, { notes: true, heading: "A3 · Method" }] },
  ];

  return {
    title: `${label} DGNSS Position Verification Report`,
    subtitle: "with rf-monitor RF interference assessment",
    firstObs: utcDateTime(coverage.intervals[0]?.[0] ?? dataset.startMs).replace(" UTC", ""),
    lastObs: utcDateTime(coverage.intervals.length ? coverage.intervals.at(-1)![1] - dataset.intervalMs : dataset.endMs).replace(" UTC", ""),
    source: multiFile
      ? `${input.files.length} Gator SBS files (line${dataset.lineNames.length > 1 ? "s" : ""} ${dataset.lineName || "–"})`
      : `${input.files[0]?.name ?? "SBS"} (Gator line ${dataset.lineName || "–"})`,
    generatedAt: input.generatedAt.toISOString(),
    generatedAtText: utcDateTime(input.generatedAt.getTime()).replace(" UTC", ""),
    vesselName: identity.vesselName,
    simulatedRf,
    verdict: [
      failures.length ? `${failures.join(", ")} beyond ${limit} of ${control.id}` : `All within ${limit} of ${control.id}`,
      interference.length ? `GNSS interference affected positioning (${ids(interference)})` : "No interference affecting positioning",
      ...(commonNoRf.length || chainEvents.length ? [`Check ${ids([...commonNoRf, ...chainEvents])}`] : []),
    ].join(" · "),
    verdictStatus,
    tables: { project, result, events: eventsTable, motion: motionTable, systems: systemsTable, stats: statsTable, control: controlTable, quality: qualityTable, lanes: laneTable, incidents: incidentTable, evidence, sources, rfSummary, rfEpisodes: rfEpisodesTable, relationship: relationshipTable },
    notes,
    pages,
    charts,
    dataFiles: dataFiles({ analysis, files: input.files, rf: input.rf }),
  };
}

/** One RFC 4180 CSV: quoted when a value holds a comma, quote or line break. */
function csv(header: string[], rows: Array<Array<string | number | undefined>>): string {
  const cell = (value: string | number | undefined) => {
    const text = value === undefined || (typeof value === "number" && !Number.isFinite(value)) ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

const iso = (ms: number) => new Date(ms).toISOString();
const round = (value: number | undefined, decimals: number) => (value !== undefined && Number.isFinite(value) ? Number(value.toFixed(decimals)) : undefined);

/** The report's tables as CSV, for checking in a spreadsheet. */
function dataFiles(input: {
  analysis: PositioningAnalysis;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  rf?: { lanes: RfLaneAnalysis[] };
}): PositioningReportModel["dataFiles"] {
  const { analysis } = input;
  const statistics = csv(
    ["dgps", "receiver", "service", "antenna", "beam", "role", "shots", "static_shots", "static_max_m", "static_p95_m", "under_way_shots", "across_track_max_m", "across_track_p95_m", "along_track_steady_m", "sats_median", "sats_min", "hdop_median", "hdop_max", "age_median_s", "age_max_s", "pcalc_codes", "flagged_shots"],
    analysis.systems.map((system) => {
      const stats = system.vsControl;
      const moving = stats?.underWay;
      const q = system.quality;
      return [
        system.id, system.config.receiver, system.config.output, system.config.antenna, system.config.beam, system.isControl ? "control" : "comparison", system.shots.length,
        stats?.static.n, stats?.static.n ? round(stats.static.max, 3) : undefined, stats?.static.n ? round(stats.static.p95, 3) : undefined,
        moving?.n, round(moving?.crossMax, 3), round(moving?.crossP95, 3), round(moving?.alongSteadyM, 3),
        round(q.sats?.median, 1), round(q.sats?.min, 0), round(q.hdop?.median, 2), round(q.hdop?.max, 2), round(q.age?.median, 1), round(q.age?.max, 1),
        q.pcalcCodes.map(([code, count]) => `${code}x${count}`).join(" "), system.flags.size,
      ];
    }),
  );
  const events = csv(
    ["id", "from_utc", "to_utc", "kind", "level", "title", "dgps", "indicators", "rf_lanes", "explanation", "action"],
    analysis.events.map((event) => [event.id, iso(event.fromMs), iso(event.toMs), event.kind, event.level, event.title, event.systems.join(" "), event.indicators.join("; "), event.rfLanes.join(" "), event.explanation, event.action]),
  );
  const coverage = csv(
    ["band", "frames", "monitored_pct", "episodes", "peak_excess", "power_median_dbm", "snr_median_db"],
    input.rf
      ? input.rf.lanes.map((lane) => [lane.definition.label, lane.stats.frames, round(lane.stats.monitoredFraction * 100, 1), lane.episodes.length, lane.stats.frames ? round(lane.stats.peakZMax, 1) : undefined, round(lane.stats.powerMedian, 1), round(lane.stats.snrMedian, 1)])
      : analysis.lanes.map((summary) => [summary.lane.label, undefined, round(summary.monitoredFraction * 100, 1), summary.anomalyCount, undefined, undefined, undefined]),
  );
  const sources = csv(
    ["file", "bytes", "gator_line", "first_obs_utc", "last_obs_utc", "shots_in_window", "sha256"],
    input.files.map((file, index) => {
      const stats = analysis.dataset.files[index];
      const used = stats && stats.epochs > 0;
      return [file.name, file.bytes, stats?.lineName, used ? iso(stats.startMs) : undefined, used ? iso(stats.endMs) : undefined, used ? stats.epochs : 0, file.sha256];
    }),
  );
  return [
    { name: "dgps-statistics.csv", content: statistics },
    { name: "events.csv", content: events },
    { name: "rf-coverage.csv", content: coverage },
    { name: "sbs-files.csv", content: sources },
  ];
}
