import { describe, expect, it } from "vitest";
import {
  buildWaterfallPalette,
  composeWaterfall,
  packPixel,
  pixelBinSpan,
  rasterizeRow,
  waterfallColor,
  waterfallRgb,
} from "../src/client/waterfallRaster";
import { visibleBinWindow } from "../src/client/SpectrumViews";

const palette = buildWaterfallPalette();

describe("waterfall palette", () => {
  it("matches waterfallColor for every one of the 256 levels", () => {
    for (let level = 0; level < 256; level += 1) {
      const [r, g, b] = waterfallRgb(level);
      expect(waterfallColor(level)).toBe(`rgb(${r}, ${g}, ${b})`);
      expect(palette.plain[level]).toBe(packPixel(r, g, b));
    }
  });

  it("is built once", () => {
    expect(buildWaterfallPalette()).toBe(palette);
  });

  it("blends the anomaly tint the way rgba(227,22,22,.32) would over the plain colour", () => {
    const [r, g, b] = waterfallRgb(128);
    expect(palette.anomaly[128]).toBe(packPixel(
      Math.round(r * 0.68 + 227 * 0.32), Math.round(g * 0.68 + 22 * 0.32), Math.round(b * 0.68 + 22 * 0.32)));
    expect(palette.anomalyHatch[128]).not.toBe(palette.anomaly[128]);
  });
});

describe("rasterizeRow", () => {
  it("keeps a single-bin spike when 2048 bins are drawn into 1000 pixels", () => {
    const bins = new Uint8Array(2048).fill(10);
    bins[1537] = 250;
    const row = rasterizeRow({ bins, startBin: 0, endBin: 2048, widthPx: 1000, palette });
    expect(row.some((pixel) => pixel === palette.plain[250])).toBe(true);
    expect(row.filter((pixel) => pixel === palette.plain[10]).length).toBe(999);
  });

  it("keeps the spike at every width that downsamples", () => {
    const bins = new Uint8Array(2048).fill(5);
    bins[777] = 200;
    for (const widthPx of [97, 333, 640, 1000, 1023, 2047]) {
      const row = rasterizeRow({ bins, startBin: 0, endBin: 2048, widthPx, palette });
      expect(row.some((pixel) => pixel === palette.plain[200])).toBe(true);
    }
  });

  it("replicates bins when there are fewer bins than pixels, like the previous nearest-bin draw", () => {
    const bins = Uint8Array.from([0, 255]);
    const row = rasterizeRow({ bins, startBin: 0, endBin: 2, widthPx: 10, palette });
    expect([...row.slice(0, 5)].every((pixel) => pixel === palette.plain[0])).toBe(true);
    expect([...row.slice(5)].every((pixel) => pixel === palette.plain[255])).toBe(true);
  });

  it("covers every bin exactly: spans tile the window without gap", () => {
    for (const [width, start, end] of [[1000, 0, 2048], [333, 100, 1900], [64, 0, 64], [50, 10, 14]] as const) {
      let covered = new Set<number>();
      for (let pixel = 0; pixel < width; pixel += 1) {
        const { lo, hi } = pixelBinSpan(pixel, width, start, end);
        expect(lo).toBeGreaterThanOrEqual(start);
        expect(hi).toBeLessThanOrEqual(end);
        expect(hi).toBeGreaterThan(lo);
        for (let i = lo; i < hi; i += 1) covered.add(i);
      }
      if (width <= end - start) expect(covered.size).toBe(end - start);
    }
  });

  it("maps pixel columns to the same frequency as the spectrum window mapping", () => {
    const frame = { binCount: 2048, startHz: 1_570_000_000, endHz: 1_580_000_000 };
    const view = { startHz: 1_575_000_000, endHz: 1_576_000_000 };
    const window = visibleBinWindow({ ...frame, view });
    const bins = new Uint8Array(2048);
    const target = window.startBin + Math.floor((window.endBin - window.startBin) / 2);
    bins[target] = 255;
    const width = 400;
    const row = rasterizeRow({ bins, startBin: window.startBin, endBin: window.endBin, widthPx: width, palette });
    const lit = row.findIndex((pixel) => pixel === palette.plain[255]);
    const span = window.endBin - window.startBin;
    const pixelCentreBin = window.startBin + ((lit + 0.5) / width) * span;
    expect(Math.abs(pixelCentreBin - target)).toBeLessThan(span / width + 1);
  });

  it("tints anomaly pixels, clips ranges to the window and leaves the rest plain", () => {
    const bins = new Uint8Array(100).fill(100);
    const row = rasterizeRow({
      bins, startBin: 20, endBin: 80, widthPx: 60, palette,
      anomalyRanges: [{ startBin: 0, endBin: 30 }, { startBin: 200, endBin: 300 }],
    });
    expect([...row.slice(0, 10)].every((pixel) => pixel === palette.anomaly[100])).toBe(true);
    expect([...row.slice(10)].every((pixel) => pixel === palette.plain[100])).toBe(true);
  });

  it("alternates stripes only when hatch is requested", () => {
    const bins = new Uint8Array(64).fill(100);
    const common = { bins, startBin: 0, endBin: 64, widthPx: 64, palette, anomalyRanges: [{ startBin: 0, endBin: 64 }] };
    const flat = rasterizeRow(common);
    const striped = rasterizeRow({ ...common, hatch: true });
    expect(new Set(flat).size).toBe(1);
    expect(new Set(striped).size).toBe(2);
    expect(striped[0]).not.toBe(rasterizeRow({ ...common, hatch: true, rowIndex: 1 })[0]);
  });

  it("falls back to background for an unusable window and never throws", () => {
    const bins = new Uint8Array(10);
    expect(rasterizeRow({ bins, startBin: 5, endBin: 5, widthPx: 8, palette })[0]).toBe(palette.background);
    expect(rasterizeRow({ bins, startBin: 0, endBin: 11, widthPx: 8, palette })[0]).toBe(palette.background);
    expect(rasterizeRow({ bins, startBin: 0, endBin: 10, widthPx: 0, palette }).length).toBe(0);
  });

  it("reuses a supplied output buffer", () => {
    const out = new Uint32Array(16);
    const row = rasterizeRow({ bins: new Uint8Array(16).fill(1), startBin: 0, endBin: 16, widthPx: 16, palette }, out);
    expect(row).toBe(out);
  });
});

describe("composeWaterfall", () => {
  it("stacks rows newest first and backfills empty rows", () => {
    const a = new Uint32Array([1, 1, 1]);
    const b = new Uint32Array([2, 2, 2]);
    const out = composeWaterfall([a, b], 3, 4, palette);
    expect([...out]).toEqual([1, 1, 1, 2, 2, 2, ...Array(6).fill(palette.background)]);
  });

  it("ignores rows beyond capacity", () => {
    const rows = [1, 2, 3].map((value) => new Uint32Array([value, value]));
    expect([...composeWaterfall(rows, 2, 2, palette)]).toEqual([1, 1, 2, 2]);
  });
});
