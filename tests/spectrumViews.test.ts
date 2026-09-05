import { describe, expect, it } from "vitest";
import {
  carrierViewRange,
  spectrumReadoutAt,
  spectrumReadoutCopy,
  visibleBinWindow,
  waterfallColor,
  waterfallLegendFits,
  waterfallTimeMarkers,
} from "../src/client/SpectrumViews";
import type { SpectrumFrame } from "../src/shared/types";

function makeFrame(bins: number[], startHz: number, endHz: number): SpectrumFrame {
  return {
    id: "frame-1",
    timestamp: "2026-08-23T04:00:00.000Z",
    receiver: 0,
    bandId: "gps-l1",
    startHz,
    endHz,
    bins: new Uint8Array(bins),
    source: "sdrconnect",
    calibrated: false,
  };
}

describe("carrierViewRange", () => {
  it("returns undefined when the guide list is empty", () => {
    expect(carrierViewRange({ guides: [], startHz: 0, endHz: 10_000_000 })).toBeUndefined();
  });

  it("returns undefined when every guide lies outside the frame", () => {
    expect(carrierViewRange({
      guides: [{ frequencyHz: 20_000_000 }, { frequencyHz: -5_000_000 }],
      startHz: 0,
      endHz: 10_000_000,
    })).toBeUndefined();
  });

  it("returns undefined when the crop would cover 80% or more of the frame span", () => {
    // Guides near opposite edges force a span that, once clamped, spans the whole frame.
    expect(carrierViewRange({
      guides: [{ frequencyHz: 50_000 }, { frequencyHz: 950_000 }],
      startHz: 0,
      endHz: 1_000_000,
    })).toBeUndefined();
  });

  it("contains all six real Fugro carriers in a range narrower than 2 MHz", () => {
    const guides = [
      { frequencyHz: 1_545_245_000 },
      { frequencyHz: 1_545_815_000 },
      { frequencyHz: 1_545_875_000 },
      { frequencyHz: 1_545_950_000 },
      { frequencyHz: 1_546_230_000 },
      { frequencyHz: 1_546_240_000 },
    ];
    const result = carrierViewRange({ guides, startHz: 1_540_742_500, endHz: 1_550_742_500 });
    expect(result).toBeDefined();
    for (const guide of guides) {
      expect(guide.frequencyHz).toBeGreaterThanOrEqual(result!.startHz);
      expect(guide.frequencyHz).toBeLessThanOrEqual(result!.endHz);
    }
    expect(result!.endHz - result!.startHz).toBeLessThan(2_000_000);
  });

  it("applies MIN_CARRIER_SPAN_HZ so a single carrier still produces a real span", () => {
    const result = carrierViewRange({
      guides: [{ frequencyHz: 1_545_000_000 }],
      startHz: 1_540_000_000,
      endHz: 1_550_000_000,
    });
    expect(result).toBeDefined();
    expect(result!.endHz - result!.startHz).toBeGreaterThanOrEqual(200_000);
  });

  it("clamps to the frame edges so a cluster near the start does not undershoot startHz", () => {
    const result = carrierViewRange({
      guides: [{ frequencyHz: 50_000 }, { frequencyHz: 60_000 }],
      startHz: 0,
      endHz: 10_000_000,
    });
    expect(result).toBeDefined();
    expect(result!.startHz).toBe(0);
  });
});

describe("visibleBinWindow", () => {
  it("with no view, returns the full window and the frame's own frequencies unchanged", () => {
    const result = visibleBinWindow({ binCount: 2048, startHz: 1_540_742_500, endHz: 1_550_742_500 });
    expect(result).toEqual({ startBin: 0, endBin: 2048, startHz: 1_540_742_500, endHz: 1_550_742_500 });
  });

  // Frame span chosen so 1 bin == 1000 Hz exactly (2048 bins over 2,047,000 Hz), so the
  // view edges below land precisely on bin boundaries and the round-trip is exact.
  const alignedBinCount = 2048;
  const alignedStartHz = 0;
  const alignedEndHz = 2_047_000;
  const alignedView = { startHz: 900_000, endHz: 1_100_000 }; // ~ a tenth of the frame, centred

  it("crops to roughly a tenth of the bins for a view covering the middle tenth of the frame", () => {
    const result = visibleBinWindow({ binCount: alignedBinCount, startHz: alignedStartHz, endHz: alignedEndHz, view: alignedView });
    const width = result.endBin - result.startBin;
    expect(width).toBeGreaterThan(150);
    expect(width).toBeLessThan(250);
  });

  it("returns startHz/endHz that fully cover the requested view, even between bin edges", () => {
    // Deliberately off a bin boundary. Rounding out must widen the window, never
    // clip it, or a carrier sitting at the edge of the view would be cropped away.
    const view = { startHz: 900_450, endHz: 1_100_550 };
    const result = visibleBinWindow({ binCount: alignedBinCount, startHz: alignedStartHz, endHz: alignedEndHz, view });
    expect(result.startHz).toBeLessThanOrEqual(view.startHz);
    expect(result.endHz).toBeGreaterThanOrEqual(view.endHz);
    expect(result.startHz).toBeLessThan(result.endHz);
    expect(result.startBin).toBeLessThan(result.endBin);
  });

  it("returns startHz/endHz exactly on the view when it lands on bin edges", () => {
    const result = visibleBinWindow({ binCount: alignedBinCount, startHz: alignedStartHz, endHz: alignedEndHz, view: alignedView });
    expect(result.startHz).toBe(alignedView.startHz);
    expect(result.endHz).toBe(alignedView.endHz);
  });

  it("returns the full window for degenerate inputs: binCount of 1", () => {
    const result = visibleBinWindow({
      binCount: 1,
      startHz: 0,
      endHz: 10_000_000,
      view: { startHz: 1_000_000, endHz: 2_000_000 },
    });
    expect(result).toEqual({ startBin: 0, endBin: 1, startHz: 0, endHz: 10_000_000 });
  });

  it("returns the full window for degenerate inputs: endHz <= startHz", () => {
    const result = visibleBinWindow({
      binCount: 2048,
      startHz: 10_000_000,
      endHz: 10_000_000,
      view: { startHz: 1_000_000, endHz: 2_000_000 },
    });
    expect(result).toEqual({ startBin: 0, endBin: 2048, startHz: 10_000_000, endHz: 10_000_000 });
  });
});

describe("waterfallColor", () => {
  it("regression: 143 and 255 no longer render identically (the old mapping saturated at bin 143)", () => {
    expect(waterfallColor(143)).not.toBe(waterfallColor(255));
  });

  it("samples across the full range yield nine distinct colours", () => {
    const samples = [0, 32, 64, 96, 128, 160, 192, 224, 255].map(waterfallColor);
    expect(new Set(samples).size).toBe(9);
  });

  it("bin 0 is the darkest stop and bin 255 is the final stop, exactly", () => {
    expect(waterfallColor(0)).toBe("rgb(4, 32, 84)");
    expect(waterfallColor(255)).toBe("rgb(255, 60, 30)");
  });

  it("clamps out-of-range input instead of extrapolating", () => {
    expect(waterfallColor(-40)).toBe(waterfallColor(0));
    expect(waterfallColor(999)).toBe(waterfallColor(255));
  });
});

describe("waterfallTimeMarkers", () => {
  it("returns [] for no frames", () => {
    expect(waterfallTimeMarkers({ frames: [], nowMs: 1_000 })).toEqual([]);
  });

  it("returns exactly one marker at index 0 for a single frame", () => {
    const markers = waterfallTimeMarkers({
      frames: [{ timestamp: "2024-01-01T00:00:00.000Z" }],
      nowMs: Date.parse("2024-01-01T00:00:00.000Z") + 5_000,
    });
    expect(markers).toEqual([{ index: 0, label: "5s ago" }]);
  });

  it("several frames get two markers, and index 0 describes the newest (last) frame, not the first", () => {
    // Ascending timestamps: the fixture would read backwards if index 0 were wrongly taken
    // from frames[0] instead of the last element.
    const frames = [
      { timestamp: "2024-01-01T00:00:00.000Z" },
      { timestamp: "2024-01-01T00:01:00.000Z" },
      { timestamp: "2024-01-01T00:05:00.000Z" },
    ];
    const nowMs = Date.parse("2024-01-01T00:05:00.000Z") + 500;
    const markers = waterfallTimeMarkers({ frames, nowMs });
    expect(markers).toEqual([
      { index: 0, label: "now" },
      { index: 2, label: "5m ago" },
    ]);
  });

  it("formats ages across the now/seconds/minutes/hours boundaries, never negative", () => {
    const at = (nowMs: number) => waterfallTimeMarkers({ frames: [{ timestamp: "1970-01-01T00:00:00.000Z" }], nowMs })[0].label;
    expect(at(1_999)).toBe("now");
    expect(at(45_000)).toBe("45s ago");
    expect(at(125_000)).toBe("2m ago");
    expect(at(7_530_000)).toBe("2h ago");
    expect(at(-5_000)).toBe("now"); // a future timestamp must clamp to zero elapsed, not go negative
  });
});

describe("waterfallLegendFits", () => {
  it("is false below either threshold and true at exactly 180 by 48", () => {
    expect(waterfallLegendFits(179, 48)).toBe(false);
    expect(waterfallLegendFits(180, 47)).toBe(false);
    expect(waterfallLegendFits(180, 48)).toBe(true);
  });
});

describe("spectrumReadoutAt", () => {
  it("returns undefined for no frame, and separately for a pointer left of plotLeft and right of the plot", () => {
    expect(spectrumReadoutAt({ frame: undefined, plotLeft: 0, plotWidth: 100, pointerX: 50 })).toBeUndefined();
    const frame = makeFrame([1, 2, 3, 4, 5], 0, 10_000_000);
    expect(spectrumReadoutAt({ frame, plotLeft: 10, plotWidth: 100, pointerX: 9 })).toBeUndefined();
    expect(spectrumReadoutAt({ frame, plotLeft: 10, plotWidth: 100, pointerX: 111 })).toBeUndefined();
  });

  it("a pointer at the exact left edge returns the window's first bin; at the right edge, its last", () => {
    const frame = makeFrame([1, 2, 3, 4, 5], 0, 10_000_000);
    const left = spectrumReadoutAt({ frame, plotLeft: 0, plotWidth: 100, pointerX: 0 });
    const right = spectrumReadoutAt({ frame, plotLeft: 0, plotWidth: 100, pointerX: 100 });
    expect(left?.binIndex).toBe(0);
    expect(right?.binIndex).toBe(4);
  });

  it("a pointer at the middle of an uncropped frame returns a frequency within one bin width of the frame's centre", () => {
    const bins = Array.from({ length: 100 }, (_, index) => index);
    const startHz = 0;
    const endHz = 100_000_000;
    const frame = makeFrame(bins, startHz, endHz);
    const readout = spectrumReadoutAt({ frame, plotLeft: 0, plotWidth: 1000, pointerX: 500 });
    const centre = (startHz + endHz) / 2;
    const binWidth = (endHz - startHz) / (bins.length - 1);
    expect(readout).toBeDefined();
    expect(Math.abs(readout!.frequencyHz - centre)).toBeLessThanOrEqual(binWidth);
  });

  it("level equals frame.bins[binIndex] for a fixture with distinct bin values", () => {
    const bins = [10, 40, 90, 150, 210, 250];
    const frame = makeFrame(bins, 0, 6_000_000);
    const readout = spectrumReadoutAt({ frame, plotLeft: 0, plotWidth: 60, pointerX: 33 });
    expect(readout).toBeDefined();
    expect(readout!.level).toBe(frame.bins[readout!.binIndex]);
  });

  // 2048 bins over 2,047,000 Hz so 1 bin == 1000 Hz exactly, and the crop below lands on bin
  // edges — the same alignment visibleBinWindow's own fixtures above use.
  const alignedBinCount = 2048;
  const alignedStartHz = 0;
  const alignedEndHz = 2_047_000;
  const alignedView = { startHz: 900_000, endHz: 1_100_000 }; // the middle tenth of the frame
  const alignedBins = Array.from({ length: alignedBinCount }, (_, index) => index % 256);

  it("with a view cropping to the middle tenth, binIndex lies inside the cropped window and the frequency lies inside the cropped range", () => {
    const frame = makeFrame(alignedBins, alignedStartHz, alignedEndHz);
    // Pointer at 90% across the plot, deliberately off-centre: reading it against the frame's
    // full, uncropped bin range (i.e. forgetting to apply visibleBinWindow) lands close to the
    // full frame's own 90% mark — far outside this narrow crop — so that bug fails the assertions below.
    const readout = spectrumReadoutAt({ frame, view: alignedView, plotLeft: 0, plotWidth: 1000, pointerX: 900 });
    const window = visibleBinWindow({ binCount: alignedBinCount, startHz: alignedStartHz, endHz: alignedEndHz, view: alignedView });
    expect(readout).toBeDefined();
    expect(readout!.binIndex).toBeGreaterThanOrEqual(window.startBin);
    expect(readout!.binIndex).toBeLessThanOrEqual(window.endBin - 1);
    expect(readout!.frequencyHz).toBeGreaterThanOrEqual(alignedView.startHz);
    expect(readout!.frequencyHz).toBeLessThanOrEqual(alignedView.endHz);
  });

  it("frequencyHz is derived from the frame's full bin grid, not a position within the crop", () => {
    const frame = makeFrame(alignedBins, alignedStartHz, alignedEndHz);
    const plotLeft = 0;
    const plotWidth = 1000;
    const pointerX = 333; // an awkward ratio, so bin rounding pulls the true bin frequency away from a naive crop-position interpolation
    const readout = spectrumReadoutAt({ frame, view: alignedView, plotLeft, plotWidth, pointerX });
    expect(readout).toBeDefined();
    const trueFrequency = alignedStartHz + (readout!.binIndex / (alignedBins.length - 1)) * (alignedEndHz - alignedStartHz);
    expect(readout!.frequencyHz).toBe(trueFrequency);
    const naiveCropPosition = alignedView.startHz + ((pointerX - plotLeft) / plotWidth) * (alignedView.endHz - alignedView.startHz);
    expect(readout!.frequencyHz).not.toBe(naiveCropPosition);
  });
});

describe("spectrumReadoutCopy", () => {
  it("formats three decimals and the raw level, for example 1575.420 MHz · 128/255", () => {
    expect(spectrumReadoutCopy({ binIndex: 0, frequencyHz: 1_575_420_000, level: 128 })).toBe("1575.420 MHz · 128/255");
  });
});
