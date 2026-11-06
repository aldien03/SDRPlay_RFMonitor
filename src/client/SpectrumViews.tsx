import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { SignalMetricSample, SpectrumFrame } from "../shared/types";
import { buildWaterfallPalette, composeWaterfall, rasterizeRow, waterfallColor } from "./waterfallRaster";
import { detectorAnalysisForFrame, detectorAnomalyRanges, detectorBaselineAvailable } from "./detectorPresentation";

export interface ViewRange { startHz: number; endHz: number }

const MIN_CARRIER_SPAN_HZ = 200_000;
const CARRIER_MARGIN_RATIO = 0.18;
const MAX_USEFUL_COVERAGE = 0.8;

/** The display window that brings a cluster of carrier guides up to full width. */
export function carrierViewRange(input: {
  guides: ReadonlyArray<{ frequencyHz: number }>;
  startHz: number;
  endHz: number;
}): ViewRange | undefined {
  const { guides, startHz, endHz } = input;
  if (endHz <= startHz) return undefined;
  const inRange = guides.filter((guide) => guide.frequencyHz >= startHz && guide.frequencyHz <= endHz);
  if (!inRange.length) return undefined;
  const lo = Math.min(...inRange.map((guide) => guide.frequencyHz));
  const hi = Math.max(...inRange.map((guide) => guide.frequencyHz));
  const centre = (lo + hi) / 2;
  const span = Math.max(hi - lo, MIN_CARRIER_SPAN_HZ) * (1 + 2 * CARRIER_MARGIN_RATIO);
  const rangeStartHz = Math.max(startHz, Math.min(endHz, centre - span / 2));
  const rangeEndHz = Math.max(startHz, Math.min(endHz, centre + span / 2));
  // A crop that changes almost nothing must not be applied.
  if ((rangeEndHz - rangeStartHz) / (endHz - startHz) >= MAX_USEFUL_COVERAGE) return undefined;
  return { startHz: rangeStartHz, endHz: rangeEndHz };
}

/** Bin window to draw, and the exact frequencies its edges fall on. */
export function visibleBinWindow(input: {
  binCount: number;
  startHz: number;
  endHz: number;
  view?: ViewRange;
}): { startBin: number; endBin: number; startHz: number; endHz: number } {
  const { binCount, startHz, endHz, view } = input;
  // Every non-Fugro feed passes no view; this must be exactly today's full-width behaviour.
  if (!view || binCount < 2 || endHz <= startHz) return { startBin: 0, endBin: binCount, startHz, endHz };
  const binFor = (hz: number) => ((hz - startHz) / (endHz - startHz)) * (binCount - 1);
  const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
  const startBin = clamp(Math.floor(binFor(view.startHz)), 0, binCount - 2);
  const endBin = clamp(Math.ceil(binFor(view.endHz)) + 1, startBin + 2, binCount);
  return {
    startBin,
    endBin,
    startHz: startHz + (startBin / (binCount - 1)) * (endHz - startHz),
    endHz: startHz + ((endBin - 1) / (binCount - 1)) * (endHz - startHz),
  };
}

export interface SpectrumReadout { binIndex: number; frequencyHz: number; level: number }

/** Value under the pointer, read off the frame's own bin grid so a cropped Fugro view still reports the true frequency. */
export function spectrumReadoutAt(input: {
  frame: SpectrumFrame | undefined;
  view?: ViewRange;
  plotLeft: number;
  plotWidth: number;
  pointerX: number;
}): SpectrumReadout | undefined {
  const { frame, view, plotLeft, plotWidth, pointerX } = input;
  if (!frame || frame.bins.length < 2 || plotWidth <= 0) return undefined;
  if (pointerX < plotLeft || pointerX > plotLeft + plotWidth) return undefined;
  const window = visibleBinWindow({ binCount: frame.bins.length, startHz: frame.startHz, endHz: frame.endHz, view });
  const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
  const ratio = (pointerX - plotLeft) / plotWidth;
  const binIndex = clamp(window.startBin + Math.round(ratio * (window.endBin - window.startBin - 1)), window.startBin, window.endBin - 1);
  // Frequency from the frame's own full start/end/bin-count, never the cropped window's.
  const frequencyHz = frame.startHz + (binIndex / Math.max(1, frame.bins.length - 1)) * (frame.endHz - frame.startHz);
  return { binIndex, frequencyHz, level: frame.bins[binIndex] };
}

export function spectrumReadoutCopy(readout: SpectrumReadout): string {
  return `${(readout.frequencyHz / 1_000_000).toFixed(3)} MHz · ${readout.level}/255`;
}

interface SpectrumViewProps {
  frame?: SpectrumFrame;
  metrics?: SignalMetricSample;
  showBaseline: boolean;
  showMarkers: boolean;
  frequencyGuides?: ReadonlyArray<{ frequencyHz: number; label: string }>;
  view?: ViewRange;
}

function guideX(frequencyHz: number, startHz: number, endHz: number, width: number): number {
  return ((frequencyHz - startHz) / Math.max(1, endHz - startHz)) * width;
}

function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | undefined {
  const rectangle = canvas.getBoundingClientRect();
  if (!rectangle.width || !rectangle.height) return undefined;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rectangle.width * ratio));
  const height = Math.max(1, Math.round(rectangle.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rectangle.width, rectangle.height);
  return context;
}

/**
 * One ResizeObserver per canvas for its whole life; the latest draw closure is held in a ref,
 * and any number of triggers in one animation frame cost a single draw.
 */
function useRedraw(canvasRef: React.RefObject<HTMLCanvasElement | null>, draw: () => void): void {
  const drawRef = useRef(draw);
  const pendingFrame = useRef(0);
  useLayoutEffect(() => {
    drawRef.current = draw;
  });
  const schedule = useCallback(() => {
    if (pendingFrame.current) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = 0;
      drawRef.current();
    });
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = 0;
    };
  }, [canvasRef, schedule]);
  // Every render means new props (the components are memoised): redraw once, coalesced.
  useEffect(() => {
    schedule();
  });
}

export const SpectrumView = memo(function SpectrumView({
  frame,
  metrics,
  showBaseline,
  showMarkers,
  frequencyGuides = [],
  view,
}: SpectrumViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Ref, not state: pointer moves at 4 spectrum updates/sec across up to nine cards must not re-render this memoised component.
  const pointerXRef = useRef<number | undefined>(undefined);
  const frameDetectorAnalysis = detectorAnalysisForFrame(frame);
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = fitCanvas(canvas);
    if (!context) return;
    const { width, height } = canvas.getBoundingClientRect();
    const plotTop = 10;
    const plotLeft = 0;
    const plotRight = width;
    const plotBottom = height - 12;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#dbe1e7";
    context.lineWidth = 1;
    for (let row = 0; row <= 4; row += 1) {
      const y = plotTop + (plotHeight * row) / 4;
      context.beginPath();
      context.moveTo(plotLeft, y + 0.5);
      context.lineTo(plotRight, y + 0.5);
      context.stroke();
    }
    for (let column = 0; column <= 6; column += 1) {
      const x = plotLeft + (plotWidth * column) / 6;
      context.beginPath();
      context.moveTo(x + 0.5, plotTop);
      context.lineTo(x + 0.5, plotBottom);
      context.stroke();
    }

    if (!frame?.bins.length) {
      context.fillStyle = "#667482";
      context.font = "600 13px Arial, sans-serif";
      context.textAlign = "center";
      context.fillText("Waiting for scan", width / 2, height / 2);
      return;
    }

    const bins = frame.bins;
    const window = visibleBinWindow({ binCount: bins.length, startHz: frame.startHz, endHz: frame.endHz, view });
    const xFor = (index: number) => plotLeft + ((index - window.startBin) / Math.max(1, window.endBin - window.startBin - 1)) * plotWidth;
    const yFor = (value: number) => plotBottom - (Math.max(0, Math.min(255, value)) / 255) * plotHeight;
    const analysisStartRatio = Math.max(0, Math.min(1, ((frame.analysisStartBin ?? 0) - window.startBin) / Math.max(1, window.endBin - window.startBin)));
    const analysisEndRatio = Math.max(analysisStartRatio, Math.min(1, ((frame.analysisEndBin ?? bins.length) - window.startBin) / Math.max(1, window.endBin - window.startBin)));
    const anomalyRanges = detectorAnomalyRanges(frame);
    // Clips a detector range to the visible window; undefined when it falls entirely outside it.
    const clipToWindow = (range: { startBin: number; endBin: number }) =>
      range.endBin <= window.startBin || range.startBin >= window.endBin
        ? undefined
        : { startBin: Math.max(range.startBin, window.startBin), endBin: Math.min(range.endBin, window.endBin) };

    context.beginPath();
    context.moveTo(plotLeft, plotBottom);
    for (let index = window.startBin; index < window.endBin; index += 1) context.lineTo(xFor(index), yFor(bins[index]));
    context.lineTo(plotRight, plotBottom);
    context.closePath();
    context.fillStyle = "rgba(0, 105, 205, 0.13)";
    context.fill();

    context.beginPath();
    for (let index = window.startBin; index < window.endBin; index += 1) {
      const x = xFor(index);
      const y = yFor(bins[index]);
      if (index === window.startBin) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = "#0867c9";
    context.lineWidth = 1.7;
    context.stroke();

    if (analysisStartRatio > 0 || analysisEndRatio < 1) {
      const analysisStartX = plotLeft + analysisStartRatio * plotWidth;
      const analysisEndX = plotLeft + analysisEndRatio * plotWidth;
      context.fillStyle = "rgba(38, 51, 63, 0.16)";
      context.fillRect(plotLeft, plotTop, analysisStartX - plotLeft, plotHeight);
      context.fillRect(analysisEndX, plotTop, plotRight - analysisEndX, plotHeight);
      context.strokeStyle = "rgba(72, 85, 96, 0.66)";
      context.setLineDash([3, 3]);
      for (const x of [analysisStartX, analysisEndX]) {
        context.beginPath();
        context.moveTo(x, plotTop);
        context.lineTo(x, plotBottom);
        context.stroke();
      }
      context.setLineDash([]);
      context.fillStyle = "#4e5c68";
      context.font = "600 9px Arial, sans-serif";
      context.textAlign = "center";
      if (analysisStartX - plotLeft > 34) context.fillText("GUARD", (plotLeft + analysisStartX) / 2, plotTop + 12);
      if (plotRight - analysisEndX > 34) context.fillText("GUARD", (analysisEndX + plotRight) / 2, plotTop + 12);
      context.textAlign = "left";
    }

    const visibleGuides = frequencyGuides.filter((guide) => guide.frequencyHz >= window.startHz && guide.frequencyHz <= window.endHz);
    if (visibleGuides.length) {
      context.strokeStyle = "rgba(206, 121, 0, 0.78)";
      context.fillStyle = "#865300";
      context.lineWidth = 1;
      context.font = "700 8px Arial, sans-serif";
      context.textAlign = "center";
      const laneRight = [-Infinity, -Infinity, -Infinity];
      for (const guide of [...visibleGuides].sort((left, right) => left.frequencyHz - right.frequencyHz)) {
        const x = guideX(guide.frequencyHz, window.startHz, window.endHz, plotWidth);
        context.setLineDash([2, 3]);
        context.beginPath();
        context.moveTo(x + 0.5, plotTop);
        context.lineTo(x + 0.5, plotBottom);
        context.stroke();
        context.setLineDash([]);
        const labelWidth = context.measureText(guide.label).width + 6;
        const naturalX = Math.max(labelWidth / 2, Math.min(width - labelWidth / 2, x));
        const candidates = laneRight.map((right, lane) => {
          const shiftedX = Math.max(naturalX, right + 3 + labelWidth / 2);
          return { lane, labelX: shiftedX, shift: shiftedX - naturalX, fits: shiftedX + labelWidth / 2 <= width };
        });
        const selected = candidates.filter((candidate) => candidate.fits).sort((left, right) => left.shift - right.shift || left.lane - right.lane)[0]
          ?? candidates.sort((left, right) => left.shift - right.shift || left.lane - right.lane)[0];
        const lane = selected.lane;
        const labelX = Math.max(labelWidth / 2, Math.min(width - labelWidth / 2, selected.labelX));
        laneRight[lane] = labelX + labelWidth / 2;
        if (Math.abs(labelX - x) > 1) {
          const y = plotTop + lane * 10 + 4.5;
          context.strokeStyle = "rgba(206, 121, 0, 0.78)";
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(labelX, y);
          context.stroke();
        }
        context.fillStyle = "rgba(255, 248, 230, 0.94)";
        context.fillRect(labelX - labelWidth / 2, plotTop + lane * 10, labelWidth, 9);
        context.fillStyle = "#865300";
        context.fillText(guide.label, labelX, plotTop + 8 + lane * 10);
      }
      context.textAlign = "left";
    }

    for (const range of anomalyRanges) {
      const clipped = clipToWindow(range);
      if (!clipped) continue;
      context.beginPath();
      for (let index = clipped.startBin; index < clipped.endBin; index += 1) {
        const x = xFor(index);
        const y = yFor(bins[index]);
        if (index === clipped.startBin) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      if (clipped.endBin - clipped.startBin === 1) {
        const x = xFor(clipped.startBin);
        const y = yFor(bins[clipped.startBin]);
        context.moveTo(Math.max(plotLeft, x - 2), y);
        context.lineTo(Math.min(plotRight, x + 2), y);
      }
      context.strokeStyle = "#e31616";
      context.lineWidth = 2.8;
      context.stroke();
    }

    if (showBaseline && detectorBaselineAvailable(frame, metrics)) {
      const y = yFor(metrics!.baselineLevel);
      context.setLineDash([5, 5]);
      context.beginPath();
      context.moveTo(plotLeft, y);
      context.lineTo(plotRight, y);
      context.strokeStyle = "#15943c";
      context.lineWidth = 1;
      context.stroke();
      context.setLineDash([]);
    }

    if (showMarkers && anomalyRanges.length) {
      const clippedRanges = anomalyRanges.map(clipToWindow).filter((range): range is { startBin: number; endBin: number } => Boolean(range));
      if (clippedRanges.length) {
        let peakIndex = clippedRanges[0].startBin;
        for (const range of clippedRanges) {
          for (let index = range.startBin; index < range.endBin; index += 1) {
            if (bins[index] > bins[peakIndex]) peakIndex = index;
          }
        }
        const x = xFor(peakIndex);
        context.beginPath();
        context.moveTo(x, plotTop);
        context.lineTo(x, plotBottom);
        context.strokeStyle = "#e31616";
        context.lineWidth = 1.4;
        context.setLineDash([4, 3]);
        context.stroke();
        context.setLineDash([]);
      }
    }
    const pointerX = pointerXRef.current;
    if (pointerX !== undefined) {
      const readout = spectrumReadoutAt({ frame, view, plotLeft, plotWidth, pointerX });
      if (readout) {
        context.strokeStyle = "rgba(38, 51, 63, 0.55)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(pointerX + 0.5, plotTop);
        context.lineTo(pointerX + 0.5, plotBottom);
        context.stroke();
        const copy = spectrumReadoutCopy(readout);
        context.font = "700 8px Arial, sans-serif";
        const padding = 3;
        const labelWidth = context.measureText(copy).width + padding * 2;
        const overflowsRight = pointerX + 4 + labelWidth > plotRight;
        const labelX = overflowsRight ? pointerX - 4 - labelWidth : pointerX + 4;
        const labelY = plotTop + 1;
        context.fillStyle = "rgba(255, 255, 255, 0.92)";
        context.fillRect(labelX, labelY, labelWidth, 11);
        context.fillStyle = "#26333f";
        context.textAlign = "left";
        context.fillText(copy, labelX + padding, labelY + 9);
      }
    }
    canvas.dataset.renderReady = "true";
  };
  useRedraw(canvasRef, draw);

  const clearPointer = () => { pointerXRef.current = undefined; draw(); };
  return (
    <canvas
      ref={canvasRef}
      className="spectrum-canvas"
      onPointerMove={(event) => {
        pointerXRef.current = event.clientX - event.currentTarget.getBoundingClientRect().left;
        draw();
      }}
      onPointerLeave={clearPointer}
      onPointerCancel={clearPointer}
      aria-label={frame ? `${frame.syntheticExercise ? "Synthetic exercise " : ""}spectrum for ${frame.bandId}; relative scale 0 to 255; peak ${metrics?.peakLevel ?? 0}; higher values mean stronger received activity; shaded outer bins are guard roll-off and are not analyzed${frameDetectorAnalysis?.overload ? "; receiver overloaded; no RF anomaly bins attributed" : frameDetectorAnalysis?.anomalyBinRanges.length ? `; detector marked ${frameDetectorAnalysis.anomalyBinRanges.length} anomaly ${frameDetectorAnalysis.anomalyBinRanges.length === 1 ? "range" : "ranges"}` : "; no detector anomaly ranges"}${view ? "; view zoomed to the correction carriers" : ""}${frequencyGuides.length ? `; ${frequencyGuides.length} expected correction carrier guides` : ""}` : "Spectrum waiting for data"}
    />
  );
});

export { waterfallColor };

/** A legend is only drawn where it will not crowd the rows it explains. */
export function waterfallLegendFits(width: number, height: number): boolean {
  return width >= 180 && height >= 48;
}

export interface WaterfallTimeMarker { index: number; label: string }

/** "12s ago" style age, never negative — a clock skewed frame must not read as a future one. */
function waterfallAgeLabel(elapsedMs: number): string {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < 2_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

/** Age labels for the newest and oldest rows, so the covered time span is visible. */
export function waterfallTimeMarkers(input: {
  frames: ReadonlyArray<{ timestamp: string }>;
  nowMs: number;
}): WaterfallTimeMarker[] {
  const { frames, nowMs } = input;
  if (!frames.length) return [];
  // Rows draw newest first via [...frames].reverse(), so index 0 is the LAST element here.
  const ageOf = (frame: { timestamp: string }): string | undefined => {
    const parsed = Date.parse(frame.timestamp);
    return Number.isNaN(parsed) ? undefined : waterfallAgeLabel(nowMs - parsed);
  };
  const markers: WaterfallTimeMarker[] = [];
  const newestLabel = ageOf(frames[frames.length - 1]);
  if (newestLabel !== undefined) markers.push({ index: 0, label: newestLabel });
  if (frames.length >= 2) {
    const oldestLabel = ageOf(frames[0]);
    if (oldestLabel !== undefined) markers.push({ index: frames.length - 1, label: oldestLabel });
  }
  return markers;
}

interface WaterfallTexture {
  surface: HTMLCanvasElement;
  width: number;
  rows: number;
  pixels: Uint32Array;
  image: ImageData;
}

export const WaterfallView = memo(function WaterfallView({ frames, frequencyGuides = [], view }: { frames: SpectrumFrame[]; frequencyGuides?: ReadonlyArray<{ frequencyHz: number; label: string }>; view?: ViewRange }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rowCache = useRef(new WeakMap<SpectrumFrame, { key: string; row: Uint32Array }>());
  const textureRef = useRef<WaterfallTexture | undefined>(undefined);
  const timeMarkers = waterfallTimeMarkers({ frames, nowMs: Date.now() });
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = fitCanvas(canvas);
    if (!context) return;
    const { width, height } = canvas.getBoundingClientRect();
    context.fillStyle = "#06285d";
    context.fillRect(0, 0, width, height);
    if (!frames.length) {
      context.fillStyle = "#d8e7f7";
      context.font = "600 13px Arial, sans-serif";
      context.textAlign = "center";
      context.fillText("No scan history", width / 2, height / 2);
      return;
    }
    const rowCapacity = Math.max(24, frames.length);
    const rowHeight = Math.max(1, height / rowCapacity);
    // Rows are rasterised once per frame and geometry, then composed into one texture.
    const textureWidth = Math.max(1, Math.min(canvas.width, 2048));
    const palette = buildWaterfallPalette();
    const rows: Uint32Array[] = [];
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index];
      const frameWindow = visibleBinWindow({ binCount: frame.bins.length, startHz: frame.startHz, endHz: frame.endHz, view });
      const key = `${textureWidth}|${frameWindow.startBin}|${frameWindow.endBin}`;
      let entry = rowCache.current.get(frame);
      if (!entry || entry.key !== key) {
        entry = {
          key,
          row: rasterizeRow({
            bins: frame.bins,
            startBin: frameWindow.startBin,
            endBin: frameWindow.endBin,
            widthPx: textureWidth,
            anomalyRanges: detectorAnomalyRanges(frame),
            palette,
            hatch: true,
          }),
        };
        rowCache.current.set(frame, entry);
      }
      rows.push(entry.row);
    }
    let texture = textureRef.current;
    if (!texture || texture.width !== textureWidth || texture.rows !== rowCapacity) {
      const surface = document.createElement("canvas");
      surface.width = textureWidth;
      surface.height = rowCapacity;
      const pixels = new Uint32Array(textureWidth * rowCapacity);
      texture = {
        surface,
        width: textureWidth,
        rows: rowCapacity,
        pixels,
        image: new ImageData(new Uint8ClampedArray(pixels.buffer), textureWidth, rowCapacity),
      };
      textureRef.current = texture;
    }
    composeWaterfall(rows, textureWidth, rowCapacity, palette, texture.pixels);
    texture.surface.getContext("2d")?.putImageData(texture.image, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(texture.surface, 0, 0, textureWidth, rowCapacity, 0, 0, width, height);
    const guideFrame = frames[frames.length - 1];
    if (guideFrame?.bins.length) {
      const guideWindow = visibleBinWindow({ binCount: guideFrame.bins.length, startHz: guideFrame.startHz, endHz: guideFrame.endHz, view });
      const analysisStartRatio = Math.max(0, Math.min(1, ((guideFrame.analysisStartBin ?? 0) - guideWindow.startBin) / Math.max(1, guideWindow.endBin - guideWindow.startBin)));
      const analysisEndRatio = Math.max(analysisStartRatio, Math.min(1, ((guideFrame.analysisEndBin ?? guideFrame.bins.length) - guideWindow.startBin) / Math.max(1, guideWindow.endBin - guideWindow.startBin)));
      if (analysisStartRatio > 0 || analysisEndRatio < 1) {
        const analysisStartX = width * analysisStartRatio;
        const analysisEndX = width * analysisEndRatio;
        context.fillStyle = "rgba(2, 12, 29, 0.38)";
        context.fillRect(0, 0, analysisStartX, height);
        context.fillRect(analysisEndX, 0, width - analysisEndX, height);
        context.strokeStyle = "rgba(255, 255, 255, 0.48)";
        context.setLineDash([3, 3]);
        for (const x of [analysisStartX, analysisEndX]) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
        }
        context.setLineDash([]);
      }
      context.strokeStyle = "rgba(255, 210, 91, 0.74)";
      context.lineWidth = 1;
      context.setLineDash([2, 3]);
      for (const guide of frequencyGuides) {
        if (guide.frequencyHz < guideWindow.startHz || guide.frequencyHz > guideWindow.endHz) continue;
        const x = guideX(guide.frequencyHz, guideWindow.startHz, guideWindow.endHz, width);
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, height);
        context.stroke();
      }
      context.setLineDash([]);
    }
    if (timeMarkers.length) {
      // Same measure-plate-text treatment as the frequency guide labels above, but a dark plate:
      // a waterfall row can be any colour, unlike the fixed light plot background.
      context.font = "700 8px Arial, sans-serif";
      context.textAlign = "right";
      const rightEdge = width - 4;
      for (const marker of timeMarkers) {
        if (marker.index !== 0 && height < 40) continue; // a short card has room for only the newest label
        const y = Math.min(height - 2, marker.index * rowHeight + rowHeight / 2 + 3);
        const labelWidth = context.measureText(marker.label).width + 6;
        context.fillStyle = "rgba(2, 10, 26, 0.72)";
        context.fillRect(rightEdge - labelWidth, y - 9, labelWidth, 11);
        context.fillStyle = "#eef4ff";
        context.fillText(marker.label, rightEdge, y);
      }
      context.textAlign = "left";
    }
    if (waterfallLegendFits(width, height)) {
      const rampWidth = 64;
      const rampHeight = 6;
      const rampY = height - 8 - rampHeight;
      context.font = "700 8px Arial, sans-serif";
      const quietWidth = context.measureText("Quiet").width;
      const strongWidth = context.measureText("Strong").width;
      // Lay the group out from the left edge so the first label cannot fall
      // outside the canvas; measuring back from the ramp used to clip "Quiet".
      const groupLeft = 8;
      const quietX = groupLeft + 4;
      const rampX = quietX + quietWidth + 4;
      const strongX = rampX + rampWidth + 4;
      const groupRight = strongX + strongWidth + 4;
      context.fillStyle = "rgba(2, 10, 26, 0.72)";
      context.fillRect(groupLeft, rampY - 5, groupRight - groupLeft, rampHeight + 10);
      for (let step = 0; step < 32; step += 1) {
        context.fillStyle = waterfallColor((step / 31) * 255);
        context.fillRect(rampX + (step / 32) * rampWidth, rampY, rampWidth / 32 + 0.5, rampHeight);
      }
      context.fillStyle = "#eef4ff";
      context.textAlign = "left";
      context.fillText("Quiet", quietX, rampY + rampHeight - 1);
      context.fillText("Strong", strongX, rampY + rampHeight - 1);
    }
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.lineWidth = 1;
    for (let column = 0; column <= 6; column += 1) {
      const x = (width * column) / 6;
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    canvas.dataset.renderReady = "true";
  };
  useRedraw(canvasRef, draw);

  const anomalyRows = frames.filter((frame) => detectorAnomalyRanges(frame).length > 0).length;
  // timeMarkers[0], when present, is always the newest row; timeMarkers[1], when present, the oldest.
  // A single row spans no interval, so name the one moment rather than "now to now".
  const coverageClause = timeMarkers.length === 0
    ? ""
    : timeMarkers.length === 1
      ? `; covering ${timeMarkers[0].label}`
      : `; covering ${timeMarkers[1].label} to ${timeMarkers[0].label}`;
  return <canvas ref={canvasRef} className="waterfall-canvas" aria-label={`${frames.some((frame) => frame.syntheticExercise) ? "Synthetic exercise " : ""}waterfall with ${frames.length} recent spectrum frames; newest row on top; ${anomalyRows} detector-marked anomaly ${anomalyRows === 1 ? "row" : "rows"}${coverageClause}; colour scale runs quiet to strong; shaded outer columns are guard roll-off and are not analyzed${view ? "; view zoomed to the correction carriers" : ""}${frequencyGuides.length ? `; ${frequencyGuides.length} expected correction carrier guides` : ""}`} />;
});
