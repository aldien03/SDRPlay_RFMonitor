import { memo, useEffect, useRef } from "react";
import type { SignalMetricSample, SpectrumFrame } from "../shared/types";
import { detectorAnalysisForFrame, detectorAnomalyRanges, detectorBaselineAvailable } from "./detectorPresentation";

interface SpectrumViewProps {
  frame?: SpectrumFrame;
  metrics?: SignalMetricSample;
  showBaseline: boolean;
  showMarkers: boolean;
  frequencyGuides?: ReadonlyArray<{ frequencyHz: number; label: string }>;
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

function useRedraw(canvasRef: React.RefObject<HTMLCanvasElement | null>, draw: () => void): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [canvasRef, draw]);
}

export const SpectrumView = memo(function SpectrumView({
  frame,
  metrics,
  showBaseline,
  showMarkers,
  frequencyGuides = [],
}: SpectrumViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    const xFor = (index: number) => plotLeft + (index / Math.max(1, bins.length - 1)) * plotWidth;
    const yFor = (value: number) => plotBottom - (Math.max(0, Math.min(255, value)) / 255) * plotHeight;
    const analysisStartRatio = Math.max(0, Math.min(1, (frame.analysisStartBin ?? 0) / Math.max(1, bins.length)));
    const analysisEndRatio = Math.max(analysisStartRatio, Math.min(1, (frame.analysisEndBin ?? bins.length) / Math.max(1, bins.length)));
    const anomalyRanges = detectorAnomalyRanges(frame);

    context.beginPath();
    context.moveTo(plotLeft, plotBottom);
    for (let index = 0; index < bins.length; index += 1) context.lineTo(xFor(index), yFor(bins[index]));
    context.lineTo(plotRight, plotBottom);
    context.closePath();
    context.fillStyle = "rgba(0, 105, 205, 0.13)";
    context.fill();

    context.beginPath();
    for (let index = 0; index < bins.length; index += 1) {
      const x = xFor(index);
      const y = yFor(bins[index]);
      if (index === 0) context.moveTo(x, y);
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

    const visibleGuides = frequencyGuides.filter((guide) => guide.frequencyHz >= frame.startHz && guide.frequencyHz <= frame.endHz);
    if (visibleGuides.length) {
      context.strokeStyle = "rgba(206, 121, 0, 0.78)";
      context.fillStyle = "#865300";
      context.lineWidth = 1;
      context.font = "700 8px Arial, sans-serif";
      context.textAlign = "center";
      const laneRight = [-Infinity, -Infinity, -Infinity];
      for (const guide of [...visibleGuides].sort((left, right) => left.frequencyHz - right.frequencyHz)) {
        const x = guideX(guide.frequencyHz, frame.startHz, frame.endHz, plotWidth);
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
      context.beginPath();
      for (let index = range.startBin; index < range.endBin; index += 1) {
        const x = xFor(index);
        const y = yFor(bins[index]);
        if (index === range.startBin) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      if (range.endBin - range.startBin === 1) {
        const x = xFor(range.startBin);
        const y = yFor(bins[range.startBin]);
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
      let peakIndex = anomalyRanges[0].startBin;
      for (const range of anomalyRanges) {
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
    canvas.dataset.renderReady = "true";
  };
  useRedraw(canvasRef, draw);

  return (
    <canvas
      ref={canvasRef}
      className="spectrum-canvas"
      aria-label={frame ? `${frame.syntheticExercise ? "Synthetic exercise " : ""}spectrum for ${frame.bandId}; relative scale 0 to 255; peak ${metrics?.peakLevel ?? 0}; higher values mean stronger received activity; shaded outer bins are guard roll-off and are not analyzed${frameDetectorAnalysis?.overload ? "; receiver overloaded; no RF anomaly bins attributed" : frameDetectorAnalysis?.anomalyBinRanges.length ? `; detector marked ${frameDetectorAnalysis.anomalyBinRanges.length} anomaly ${frameDetectorAnalysis.anomalyBinRanges.length === 1 ? "range" : "ranges"}` : "; no detector anomaly ranges"}${frequencyGuides.length ? `; ${frequencyGuides.length} expected correction carrier guides` : ""}` : "Spectrum waiting for data"}
    />
  );
});

function waterfallColor(value: number): string {
  const level = Math.max(0, Math.min(1, (value - 18) / 125));
  if (level < 0.28) return `rgb(0, ${Math.round(25 + level * 175)}, ${Math.round(92 + level * 360)})`;
  if (level < 0.52) return `rgb(0, ${Math.round(120 + level * 230)}, ${Math.round(190 - level * 240)})`;
  if (level < 0.76) return `rgb(${Math.round(110 + level * 185)}, ${Math.round(225 - level * 35)}, 0)`;
  return `rgb(${Math.round(230 + level * 25)}, ${Math.round(210 - level * 190)}, 0)`;
}

export const WaterfallView = memo(function WaterfallView({ frames, frequencyGuides = [] }: { frames: SpectrumFrame[]; frequencyGuides?: ReadonlyArray<{ frequencyHz: number; label: string }> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    const newestFirst = [...frames].reverse();
    const rowHeight = Math.max(1, height / Math.max(24, newestFirst.length));
    newestFirst.forEach((frame, row) => {
      const bins = frame.bins;
      const visibleBins = Math.min(Math.ceil(width), bins.length);
      for (let column = 0; column < visibleBins; column += 1) {
        const sourceIndex = Math.min(bins.length - 1, Math.floor((column / visibleBins) * bins.length));
        const x = (column / visibleBins) * width;
        context.fillStyle = waterfallColor(bins[sourceIndex]);
        context.fillRect(x, row * rowHeight, width / visibleBins + 1, rowHeight + 0.5);
      }
      context.fillStyle = "rgba(227, 22, 22, 0.32)";
      for (const range of detectorAnomalyRanges(frame)) {
        const startX = (range.startBin / Math.max(1, bins.length)) * width;
        const endX = (range.endBin / Math.max(1, bins.length)) * width;
        context.fillRect(startX, row * rowHeight, Math.max(1, endX - startX), rowHeight + 0.5);
      }
    });
    const guideFrame = newestFirst[0];
    if (guideFrame?.bins.length) {
      const analysisStartRatio = Math.max(0, Math.min(1, (guideFrame.analysisStartBin ?? 0) / guideFrame.bins.length));
      const analysisEndRatio = Math.max(analysisStartRatio, Math.min(1, (guideFrame.analysisEndBin ?? guideFrame.bins.length) / guideFrame.bins.length));
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
        if (guide.frequencyHz < guideFrame.startHz || guide.frequencyHz > guideFrame.endHz) continue;
        const x = guideX(guide.frequencyHz, guideFrame.startHz, guideFrame.endHz, width);
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, height);
        context.stroke();
      }
      context.setLineDash([]);
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
  return <canvas ref={canvasRef} className="waterfall-canvas" aria-label={`${frames.some((frame) => frame.syntheticExercise) ? "Synthetic exercise " : ""}waterfall with ${frames.length} recent spectrum frames; newest row on top; ${anomalyRows} detector-marked anomaly ${anomalyRows === 1 ? "row" : "rows"}; shaded outer columns are guard roll-off and are not analyzed${frequencyGuides.length ? `; ${frequencyGuides.length} expected correction carrier guides` : ""}`} />;
});
