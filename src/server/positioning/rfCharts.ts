/** RF signal and RF-to-navigation charts for the positioning report. */
import { frequencyAxisTicks, numericTicks, type ChartPoint, type ChartSeries, type ChartSpec } from "../report/chartSpec";
import { REPORT_COLORS } from "../report/theme";
import { percentile } from "./analysis";
import { limitText, type PositioningAnalysis } from "./analysis";
import { niceCeil, noDataRegions, timeAxis, timeSeries } from "./charts";
import { RF_RULES, rfAt, type GroupSeries, type RfBucketSeries, type RfLaneAnalysis } from "./rfAnalysis";

/** Antenna-group colours (validated all-pairs on white, both >= 3:1). */
export const GROUP_COLORS = ["#6250d6", "#eb6834"] as const;
const WIDE = 760;

function episodeRegions(analysis: PositioningAnalysis, lane: RfLaneAnalysis) {
  return [...noDataRegions(analysis), ...lane.episodes.map((episode) => ({ from: episode.fromMs, to: episode.toMs, color: REPORT_COLORS.anomaly, opacity: 0.12 }))];
}

/** Bucketed lane series as chart points; empty buckets break the line. */
function bucketPoints(lane: RfLaneAnalysis, key: Exclude<keyof RfBucketSeries, "timeMs">): ChartPoint[] {
  const points: ChartPoint[] = [];
  lane.series[key].forEach((value, index) => {
    if (value === null) {
      if (points.length && points.at(-1) !== null) points.push(null);
    } else points.push([lane.series.timeMs[index], value]);
  });
  return points;
}

function present(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function legendFor(series: ChartSeries[], extra: ChartSpec["legend"] = []): ChartSpec["legend"] {
  return [...series.filter((entry) => entry.kind === "line").map((entry) => ({ name: entry.name, color: entry.color, style: ("dash" in entry && entry.dash ? "dash" : "line") as "dash" | "line" })), ...extra];
}

export function rfLaneCharts(analysis: PositioningAnalysis, lane: RfLaneAnalysis): ChartSpec[] {
  const id = lane.definition.id;
  const regions = episodeRegions(analysis, lane);
  const anomalyLegend = lane.episodes.length ? [{ name: "Interference episode", color: REPORT_COLORS.anomaly, style: "region" as const }] : [];
  const charts: ChartSpec[] = [];

  if (lane.waterfall && lane.analysisHz) {
    const [low, high] = lane.analysisHz;
    charts.push({
      id: `rf-${id}-waterfall`,
      title: "Waterfall (time × frequency)",
      caption: "",
      ariaLabel: `Waterfall of ${lane.definition.label}: received level by frequency over time.`,
      width: WIDE,
      height: 170,
      x: timeAxis(analysis),
      y: { label: "Frequency (MHz)", min: low, max: high, ticks: frequencyAxisTicks(low, high, 4) },
      image: lane.waterfall,
      series: [],
      vRules: lane.episodes.map((episode) => ({ value: episode.fromMs, color: REPORT_COLORS.white, dash: [3, 3], label: episode.id })),
      legend: [],
    });
  }

  const levels = [...present(lane.series.meanLevel), ...present(lane.series.peakLevel), ...present(lane.series.baseline)];
  const levelMax = niceCeil(Math.max(10, ...levels) * 1.1, 10);
  const levelSeries: ChartSeries[] = [
    { kind: "line", name: "Strongest point", color: REPORT_COLORS.anomaly, width: 1.1, points: bucketPoints(lane, "peakLevel") },
    { kind: "line", name: "Band mean", color: REPORT_COLORS.received, width: 1.4, points: bucketPoints(lane, "meanLevel") },
    { kind: "line", name: "Usual level", color: REPORT_COLORS.usual, width: 1.4, dash: [5, 3], points: bucketPoints(lane, "baseline") },
  ];
  charts.push({
    id: `rf-${id}-level`,
    title: "Received level vs usual (relative)",
    caption: "",
    ariaLabel: `${lane.definition.label} received level against the learned usual level.`,
    width: WIDE,
    height: 130,
    x: timeAxis(analysis),
    y: { label: "Level (0–255)", min: 0, max: levelMax, ticks: numericTicks(0, levelMax, 4, (value) => String(Math.round(value))) },
    xRegions: regions,
    series: levelSeries,
    legend: legendFor(levelSeries, anomalyLegend),
  });

  const excessMax = niceCeil(Math.max(RF_RULES.narrowbandPeakSigma * 1.3, lane.stats.peakZMax * 1.1), 5);
  const excessSeries: ChartSeries[] = [
    { kind: "line", name: "Peak excess", color: REPORT_COLORS.anomaly, width: 1.2, points: bucketPoints(lane, "peakZ") },
    { kind: "line", name: "Median excess", color: REPORT_COLORS.received, width: 1.4, points: bucketPoints(lane, "medianZ") },
  ];
  charts.push({
    id: `rf-${id}-excess`,
    title: "Excess over usual (× normal variation)",
    caption: "",
    ariaLabel: `${lane.definition.label} peak and median excess over the usual level.`,
    width: WIDE,
    height: 130,
    x: timeAxis(analysis),
    y: { label: "× normal variation", min: 0, max: excessMax, ticks: numericTicks(0, excessMax, 4, (value) => String(Math.round(value))) },
    xRegions: regions,
    series: excessSeries,
    hRules: [
      { value: RF_RULES.narrowbandPeakSigma, color: REPORT_COLORS.anomaly, dash: [5, 3] },
      { value: RF_RULES.noiseFloorSigma, color: REPORT_COLORS.received, dash: [5, 3] },
    ],
    legend: legendFor(excessSeries, [{ name: `Narrowband ${RF_RULES.narrowbandPeakSigma}×`, color: REPORT_COLORS.anomaly, style: "dash" }, { name: `Noise floor ${RF_RULES.noiseFloorSigma}×`, color: REPORT_COLORS.received, style: "dash" }, ...anomalyLegend]),
  });

  const occupiedSeries: ChartSeries[] = [
    { kind: "line", name: "Band raised", color: REPORT_COLORS.anomaly, width: 1.4, points: bucketPoints(lane, "occupied") },
    { kind: "line", name: "Widest raised block", color: REPORT_COLORS.alertLevel, width: 1.2, points: bucketPoints(lane, "maxWidth") },
  ];
  charts.push({
    id: `rf-${id}-occupied`,
    title: "Raised bandwidth (% of analysed band)",
    caption: "",
    ariaLabel: `${lane.definition.label} share of the band above usual and widest raised block.`,
    width: WIDE,
    height: 130,
    x: timeAxis(analysis),
    y: { label: "% of band", min: 0, max: 100, ticks: numericTicks(0, 100, 4, (value) => String(Math.round(value))) },
    xRegions: regions,
    series: occupiedSeries,
    hRules: [
      { value: RF_RULES.widebandOccupancy * 100, color: REPORT_COLORS.anomaly, dash: [5, 3] },
      { value: RF_RULES.partialWidth * 100, color: REPORT_COLORS.alertLevel, dash: [5, 3] },
    ],
    legend: legendFor(occupiedSeries, [{ name: `Wideband ${RF_RULES.widebandOccupancy * 100}%`, color: REPORT_COLORS.anomaly, style: "dash" }, { name: `Partial ${RF_RULES.partialWidth * 100}%`, color: REPORT_COLORS.alertLevel, style: "dash" }, ...anomalyLegend]),
  });

  const powers = present(lane.series.power);
  if (powers.length) {
    const low = Math.floor(Math.min(...powers) / 5) * 5 - 5;
    const high = Math.ceil(Math.max(...powers) / 5) * 5 + 5;
    charts.push({
      id: `rf-${id}-power`,
      title: "Signal power (SDRconnect-reported, uncalibrated)",
      caption: "",
      ariaLabel: `${lane.definition.label} SDRconnect-reported signal power over time.`,
      width: WIDE,
      height: 110,
      x: timeAxis(analysis),
      y: { label: "dBm", min: low, max: high, ticks: numericTicks(low, high, 4, (value) => String(Math.round(value))) },
      xRegions: regions,
      series: [{ kind: "line", name: "Power", color: REPORT_COLORS.received, width: 1.3, points: bucketPoints(lane, "power") }],
      legend: anomalyLegend,
    });
  }

  if (lane.spectrum) {
    const spectrum = lane.spectrum;
    const toPoints = (values: number[]) => spectrum.hz.map((hz, index) => [hz, values[index]] as [number, number]);
    const all = [...spectrum.alert, ...spectrum.clearMax, ...(spectrum.episodeMax ?? [])];
    // Clip the receiver's centre spur so the band shape stays readable.
    const max = niceCeil(percentile(all, 0.99) * 1.15, 10);
    const series: ChartSeries[] = [
      { kind: "line", name: "Usual (median)", color: REPORT_COLORS.usual, width: 1.6, points: toPoints(spectrum.usual) },
      { kind: "line", name: `Raised level (${RF_RULES.segmentSigma}×)`, color: REPORT_COLORS.usual, width: 1.1, dash: [5, 3], points: toPoints(spectrum.alert) },
      { kind: "line", name: "Clear max", color: REPORT_COLORS.before, width: 1, points: toPoints(spectrum.clearMax) },
      ...(spectrum.episodeMax ? [{ kind: "line" as const, name: `${spectrum.episodeId} max`, color: REPORT_COLORS.anomaly, width: 1.3, points: toPoints(spectrum.episodeMax) }] : []),
      ...(spectrum.episodeMean ? [{ kind: "line" as const, name: `${spectrum.episodeId} mean`, color: REPORT_COLORS.alertLevel, width: 1.3, points: toPoints(spectrum.episodeMean) }] : []),
    ];
    charts.push({
      id: `rf-${id}-spectrum`,
      title: "Spectrum: worst episode vs usual",
      caption: "",
      ariaLabel: `${lane.definition.label} spectrum during the worst episode against the usual level.`,
      width: WIDE,
      height: 160,
      x: { label: "Frequency (MHz)", min: spectrum.hz[0], max: spectrum.hz.at(-1)!, ticks: frequencyAxisTicks(spectrum.hz[0], spectrum.hz.at(-1)!, 8) },
      y: { label: "Level (0–255)", min: 0, max, ticks: numericTicks(0, max, 4, (value) => String(Math.round(value))) },
      series,
      legend: legendFor(series),
    });
  }
  return charts;
}

export function relationshipCharts(analysis: PositioningAnalysis, lane: RfLaneAnalysis | undefined, series: GroupSeries[]): ChartSpec[] {
  const charts: ChartSpec[] = [];
  const regions = lane ? episodeRegions(analysis, lane) : noDataRegions(analysis);
  const groupLegend = series.map((entry, index) => ({ name: `${entry.group} antenna`, color: GROUP_COLORS[index % 2], style: "line" as const }));
  const anomalyLegend = lane?.episodes.length ? [{ name: "Interference episode", color: REPORT_COLORS.anomaly, style: "region" as const }] : [];
  if (lane) {
    const max = niceCeil(Math.max(RF_RULES.narrowbandPeakSigma * 1.3, lane.stats.peakZMax * 1.1), 5);
    charts.push({
      id: "rel-excess",
      title: `${lane.definition.shortLabel}: RF peak excess (× normal variation)`,
      caption: "",
      ariaLabel: "RF peak excess over time.",
      width: WIDE,
      height: 170,
      x: timeAxis(analysis),
      y: { label: "× normal variation", min: 0, max, ticks: numericTicks(0, max, 4, (value) => String(Math.round(value))) },
      xRegions: regions,
      series: [{ kind: "line", name: "Peak excess", color: REPORT_COLORS.anomaly, width: 1.2, points: bucketPoints(lane, "peakZ") }],
      hRules: [{ value: RF_RULES.narrowbandPeakSigma, color: REPORT_COLORS.anomaly, dash: [5, 3] }],
      legend: anomalyLegend,
    });
  }
  const lossValues = series.flatMap((entry) => entry.satsLoss.map(([, value]) => value).filter((value): value is number => value !== null));
  const lossMin = Math.min(-10, Math.floor(Math.min(...lossValues, 0) / 10) * 10);
  const lossMax = Math.max(40, Math.ceil(Math.max(...lossValues, 0) / 10) * 10);
  charts.push({
    id: "rel-sats",
    title: "Satellite loss by antenna group (% of own median)",
    caption: "",
    ariaLabel: "Median satellite loss per antenna group over time.",
    width: WIDE,
    height: 170,
    x: timeAxis(analysis),
    y: { label: "Loss (%)", min: lossMin, max: lossMax, ticks: numericTicks(lossMin, lossMax, 4, (value) => String(Math.round(value))) },
    xRegions: regions,
    series: series.map((entry, index) => ({ kind: "line" as const, name: `${entry.group} antenna`, color: GROUP_COLORS[index % 2], width: 1.4, points: timeSeries(entry.satsLoss, analysis) })),
    hRules: [{ value: analysis.thresholds.satsDropFraction * 100, color: REPORT_COLORS.alertLevel, dash: [5, 3], label: `Loss flag ${analysis.thresholds.satsDropFraction * 100}%` }, { value: 0, color: REPORT_COLORS.rule }],
    legend: [...groupLegend, ...anomalyLegend],
  });
  const ranges = series.flatMap((entry) => entry.range.map(([, value]) => value).filter((value): value is number => value !== null));
  const limit = analysis.thresholds.agreementM;
  const rangeMax = niceCeil(Math.max(limit * 1.2, ...ranges.map((value) => value * 1.1)), 0.1);
  charts.push({
    id: "rel-range",
    title: analysis.systems.some((system) => system.vsControl?.underWay) ? "Agreement distance to control by antenna group (max; 2D static, across track under way)" : "2D range to control by antenna group (max)",
    caption: "",
    ariaLabel: "Largest distance to the control per antenna group over time.",
    width: WIDE,
    height: 170,
    x: timeAxis(analysis),
    y: { label: "Range (m)", min: 0, max: rangeMax, ticks: numericTicks(0, rangeMax, 4, (value) => value.toFixed(rangeMax <= 2 ? 1 : 0)) },
    xRegions: regions,
    series: series.map((entry, index) => ({ kind: "line" as const, name: `${entry.group} antenna`, color: GROUP_COLORS[index % 2], width: 1.4, points: timeSeries(entry.range, analysis) })),
    hRules: [{ value: limit, color: REPORT_COLORS.anomaly, dash: [6, 4], label: `Control threshold (${limitText(limit)})` }],
    legend: [...groupLegend, ...anomalyLegend],
  });
  if (lane) {
    const points = series.map((entry) => entry.satsLoss.flatMap(([time, loss]) => {
      const rf = loss !== null ? rfAt(lane, analysis.window.startMs, time) : undefined;
      return rf && loss !== null ? [[rf.peakZ, loss] as [number, number]] : [];
    }));
    const xMax = niceCeil(Math.max(RF_RULES.narrowbandPeakSigma * 1.3, ...points.flat().map(([x]) => x * 1.1)), 5);
    charts.push({
      id: "rel-scatter",
      title: `Satellite loss vs ${lane.definition.shortLabel} RF excess (each Gator shot)`,
      caption: "",
      ariaLabel: "Scatter of satellite loss against RF peak excess per shot and antenna group.",
      width: WIDE,
      height: 300,
      x: { label: "RF peak excess (× normal variation)", min: 0, max: xMax, ticks: numericTicks(0, xMax, 6, (value) => String(Math.round(value))) },
      y: { label: "Satellite loss (%)", min: lossMin, max: lossMax, ticks: numericTicks(lossMin, lossMax, 4, (value) => String(Math.round(value))) },
      series: points.map((list, index) => ({ kind: "points" as const, name: `${series[index].group} antenna`, color: GROUP_COLORS[index % 2], radius: 2.2, points: list })),
      vRules: [{ value: RF_RULES.narrowbandPeakSigma, color: REPORT_COLORS.anomaly, dash: [5, 3], label: "Raised" }],
      hRules: [{ value: analysis.thresholds.satsDropFraction * 100, color: REPORT_COLORS.alertLevel, dash: [5, 3] }],
      legend: groupLegend,
    });
  }
  return charts;
}
