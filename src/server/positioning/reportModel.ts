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

export type TableId = "project" | "result" | "events" | "motion" | "systems" | "stats" | "control" | "quality" | "lanes" | "incidents" | "evidence" | "rfSummary" | "rfEpisodes" | "relationship";

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
  file: { name: string; bytes: number; sha256: string };
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
  const worst = others.reduce((best, system) => ((system.vsControl?.max ?? 0) > (best.vsControl?.max ?? 0) ? system : best), others[0]);
  const worstMax = worst?.vsControl?.max ?? 0;
  const label = motion.state === "static" ? "Static" : motion.state === "dynamic" ? "Dynamic" : "Mixed";
  const name = (system: (typeof systems)[number]) => `${system.config.receiver} · ${system.config.output}`;

  // ---- result checks ----------------------------------------------------------
  const interference = events.filter((event) => event.kind === "rf-and-nav-common");
  const commonNoRf = events.filter((event) => event.kind === "nav-common-no-rf" || event.kind === "nav-common-rf-unknown");
  const chainEvents = events.filter((event) => ["antenna-group", "single-receiver", "single-solution", "correction-link"].includes(event.kind));
  const rfEpisodes = analysis.lanes.flatMap((summary) => summary.lane.intervals.filter((interval) => interval.state === "anomaly").map((interval) => ({ lane: summary.lane, ...interval })));
  const rfLanesHit = [...new Set(rfEpisodes.map((episode) => episode.lane.shortLabel))];
  const gnssCoverage = Math.min(...analysis.lanes.filter((summary) => summary.lane.service === "gnss").map((summary) => summary.monitoredFraction));
  /** "E1" / "E1, E4" / "E1–E35 (35)" so long days stay readable. */
  const ids = (list: typeof events) => (list.length <= 3 ? list.map((event) => event.id).join(", ") : `${list[0].id}–${list.at(-1)!.id} (${list.length})`);
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
      ]
    : ["RF anomalies (rf-monitor)", "None", "", ""];
  const result: ReportTable = {
    columns: [{ title: "Check", width: 25 }, { title: "Criterion", width: 18 }, { title: "Result", width: 45 }, { title: "Status", width: 12, align: "center" }],
    statusColumn: 3,
    rows: [
      ["CRP agreement with control", `≤ ${limit} from ${control.id}`, worst ? `Max ${metres(worstMax)} (${worst.id}); 95% ≤ ${metres(Math.max(...others.map((system) => system.vsControl?.p95 ?? 0)))}` : "–", worstMax <= thresholds.agreementM ? "PASS" : "FAIL"],
      ["Interference affecting positioning", "None", interference.length ? `${interference.length} event(s): ${ids(interference)}` : commonNoRf.length ? `Common degradation without RF evidence: ${ids(commonNoRf)}` : "None", interference.length ? "ALERT" : commonNoRf.length ? "CHECK" : "PASS"],
      input.rf ? jammingRow : ["RF anomalies (rf-monitor)", "None", rfEpisodes.length ? `${rfEpisodes.length} episode(s) on ${rfLanesHit.join(", ")}; ${duration(rfEpisodes.reduce((sum, episode) => sum + episode.toMs - episode.fromMs, 0))} total` : "None", rfEpisodes.length ? "INFO" : "PASS"],
      ["Single-chain anomalies", "None", chainEvents.length ? grouped(chainEvents) : "None", chainEvents.length ? "CHECK" : "PASS"],
      ["Data coverage", "Full window", `Gator ${pct(analysis.positioningCoverage.fraction)}%; GNSS RF monitored ≥ ${pct(gnssCoverage)}%`, analysis.positioningCoverage.fraction >= 0.999 && gnssCoverage >= 0.9 ? "PASS" : "INFO"],
    ],
  };
  const verdictStatus: Status = interference.length || worstImpact?.level === "alert" ? "ALERT" : worstMax > thresholds.agreementM ? "FAIL" : commonNoRf.length || chainEvents.length ? "CHECK" : "PASS";

  const eventsTable: ReportTable = {
    columns: [{ title: "ID", width: 5 }, { title: "Time (UTC)", width: 13 }, { title: "Finding", width: 25 }, { title: "Basis", width: 33 }, { title: "Action", width: 24 }],
    rows: events.map((event) => {
      const episode = input.rf?.episodes.find((entry) => entry.fromMs < event.toMs && entry.toMs > event.fromMs);
      const title = episode ? event.title.replace("RF anomaly on", `${RF_TYPE_LABEL[episode.type]} interference (${episode.id}) on`) : event.title;
      return [event.id, span(event.fromMs, event.toMs), title, `${event.explanation} [${event.evidence}]`, event.action];
    }),
  };

  const motionTable: ReportTable = {
    columns: [{ title: "Period", width: 14 }, { title: "N", width: 10, align: "right" }, { title: "Min kn", width: 12, align: "right" }, { title: "Max kn", width: 12, align: "right" }, { title: "Mean kn", width: 12, align: "right" }, { title: "Median kn", width: 13, align: "right" }, { title: "% Moving", width: 13, align: "right" }, { title: "Threshold", width: 14, align: "right" }],
    rows: [[label, String(motion.n), fixed(motion.minKnots, 3), fixed(motion.maxKnots, 3), fixed(motion.meanKnots, 3), fixed(motion.medianKnots, 3), fixed(motion.movingFraction * 100, 1), fixed(thresholds.movingKnots, 3)]],
  };

  const systemsTable: ReportTable = {
    columns: [{ title: "System", width: 11 }, { title: "Entered Name", width: 25 }, { title: "Antenna (splitter)", width: 24 }, { title: "Beam", width: 10 }, { title: "IP", width: 8 }, { title: "Use", width: 14, align: "center" }],
    rows: systems.map((system) => [system.id, name(system), `${system.config.antenna} (${system.config.antennaGroup})`, system.config.beam, system.config.ip ?? "–", system.isControl ? "Control" : "Comparison"]),
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

  const controlTable: ReportTable = {
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
      const flagged = [...system.flags.values()].filter((set) => set.size).length;
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
      ["Gator SBS file", `${input.file.name} (${input.file.bytes.toLocaleString("en-GB")} bytes)`],
      ["SBS SHA-256", input.file.sha256],
      ["Gator line / shots", `${dataset.lineName} · ${dataset.shotCount.toLocaleString("en-GB")} shots × ${dataset.systems.length} systems at ${dataset.intervalMs / 1000} s`],
      ["Report window (UTC)", `${utcDateTime(analysis.window.startMs)} – ${utcDateTime(analysis.window.endMs)} (${analysis.window.mode === "sbs" ? "SBS span" : analysis.window.mode === "utc-day" ? "UTC day" : "custom"})`],
      ["Gator coverage", `${utcTime(analysis.positioningCoverage.fromMs)}–${utcTime(analysis.positioningCoverage.toMs)} UTC (${pct(analysis.positioningCoverage.fraction)}% of window)`],
      ["Control / threshold", `${control.id} (${name(control)}) / ${limit}`],
      ["RF evidence source", input.rf?.sourceText ?? (simulatedRf ? "SIMULATED (mock-up)" : "rf-monitor evidence store")],
      ["rf-monitor incidents", analysis.rf.incidents.length ? analysis.rf.incidents.map((incident) => incident.id).join(", ") : "None"],
    ],
  };

  const absent = systems.filter((system) => system.absentFields.length).map((system) => `${system.id} ${system.absentFields.join("/")}`);
  const notes = [
    ...(input.rf ? [`RF: each frame typed with the rf-monitor Standard rules (wideband ≥ ${RF_RULES.widebandOccupancy * 100}% of band raised; partial-band block > ${RF_RULES.partialWidth * 100}%; noise floor median ≥ ${RF_RULES.noiseFloorSigma}×; narrowband peak ≥ ${RF_RULES.narrowbandPeakSigma}×). Episode = ${RF_RULES.alertVisits} of ${RF_RULES.alertWindow} frames raised, ends after ${RF_RULES.clearVisits} clear frames. Levels relative 0–255; dBm/SNR as reported by SDRconnect. Jamming-type = wideband, partial-band or noise-floor interference.`, "RF–navigation: per Gator shot, nearest RF frame within 5 s; satellite loss = median per antenna group, % of each system's own median; Spearman r at zero lag, best lag searched ±120 s. Impact = during episode minus 5 min before."] : []),
    `Positions: SST (vessel CRP) Easting/Northing reduced by Gator from each DGPS. Deltas = system − ${control.id} at the same shot.`,
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
    { title: "", blocks: [{ table: "project" }, { table: "result", heading: "Verification Result" }, { table: "events", heading: "Events and Actions" }, { table: "motion", heading: "Vessel Motion Classification" }, { table: "systems", heading: "Systems Used" }, { table: "stats", heading: "Individual System Position Statistics (95% ellipse)" }] },
    ...rfPages,
    { title: `All Sensor Delta and Range Time Series Relative to ${control.id} (${name(control)})`, blocks: [{ chart: "delta-e" }, { chart: "delta-n" }, { chart: "delta-range" }] },
    { title: `All Sensor Delta Scatter Relative to ${control.id} (Control = 0)`, blocks: [{ pair: ["scatter-overview", "scatter-detail"], key: [...others.map((system) => ({ name: system.id, color: colorOf(analysis, system.id) })), { name: `Threshold (${limit})`, color: "#c8102e", dash: true }, { name: `Control ${control.id}`, color: "#14212e" }] }, { table: "control", heading: "Distance from Control Summary" }, { table: "quality", heading: "Solution Quality" }] },
    ...(input.rf ? [] : [{ title: "RF Environment (rf-monitor)", blocks: [{ chart: "evidence-timeline" }, { table: "lanes", heading: "RF Lane Coverage" }, { table: "incidents", heading: "rf-monitor Incidents" }] as ReportBlock[] }]),
    ...systems.map((system) => ({ title: `${system.id} Time Series (${name(system)})`, blocks: [{ charts: ["rf", "sats", "age", "pcalc", "hdop", "pdop"].map((key) => `sys-${system.id}-${key}`) }] as ReportBlock[] })),
    ...(motion.state !== "static" ? [{ title: "Vessel Speed Time Series", blocks: [{ chart: "speed" }] as ReportBlock[] }] : []),
    { title: "Evidence and Method", blocks: [{ table: "evidence", heading: "Evidence" }, { notes: true, heading: "Method" }] },
  ];

  return {
    title: `${label} DGNSS Position Verification Report`,
    subtitle: "with rf-monitor RF interference assessment",
    firstObs: utcDateTime(dataset.startMs).replace(" UTC", ""),
    lastObs: utcDateTime(dataset.endMs).replace(" UTC", ""),
    source: `${input.file.name} (Gator line ${dataset.lineName})`,
    generatedAt: input.generatedAt.toISOString(),
    generatedAtText: utcDateTime(input.generatedAt.getTime()).replace(" UTC", ""),
    vesselName: identity.vesselName,
    simulatedRf,
    verdict: [
      worstMax <= thresholds.agreementM ? `All within ${limit} of ${control.id}` : `${others.filter((system) => (system.vsControl?.max ?? 0) > thresholds.agreementM).map((system) => system.id).join(", ")} beyond ${limit} of ${control.id}`,
      interference.length ? `GNSS interference affected positioning (${ids(interference)})` : "No interference affecting positioning",
      ...(commonNoRf.length || chainEvents.length ? [`Check ${ids([...commonNoRf, ...chainEvents])}`] : []),
    ].join(" · "),
    verdictStatus,
    tables: { project, result, events: eventsTable, motion: motionTable, systems: systemsTable, stats: statsTable, control: controlTable, quality: qualityTable, lanes: laneTable, incidents: incidentTable, evidence, rfSummary, rfEpisodes: rfEpisodesTable, relationship: relationshipTable },
    notes,
    pages,
    charts,
  };
}
