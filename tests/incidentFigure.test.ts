import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { IncidentFigureBuilder, captionText, chooseRowMs, composeCaptionedPng, encodePng, type FigureFrame, type IncidentFigureInput } from "../src/server/incidentFigure";
import { describeAnalysis } from "../src/server/incidentAnalysis";
import { buildWaterfallPalette, packPixel } from "../src/shared/waterfallRaster";

const T0 = Date.parse("2026-11-07T06:00:00.000Z");

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Independent decoder: checks every chunk CRC and returns RGBA rows. */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  let ended = false;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    expect(view.getUint32(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect([body[8], body[9]]).toEqual([8, 6]);
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") ended = true;
    offset += 12 + length;
  }
  expect(ended).toBe(true);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    expect(raw[row * (stride + 1)]).toBe(0);
    rgba.set(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)), row * stride);
  }
  return { width, height, rgba };
}

function baseInput(overrides: Partial<IncidentFigureInput> = {}): IncidentFigureInput {
  return {
    incidentId: "incident-1",
    label: "GPS L1",
    rangeHz: [1_571_416_094, 1_579_404_375],
    evidenceStrength: "Medium",
    lifecycle: "cleared",
    observed: "Narrowband energy stayed above its usual level.",
    windowStartMs: T0,
    windowEndMs: T0 + 120_000,
    incidentStartMs: T0 + 30_000,
    incidentEndMs: T0 + 90_000,
    frameTimestampsMs: [],
    generatedAtMs: Date.parse("2026-11-07T06:30:12.000Z"),
    ...overrides,
  };
}

function frameAt(seconds: number, bins: Uint8Array, overrides: Partial<FigureFrame> = {}): FigureFrame {
  return {
    timestampMs: T0 + seconds * 1000,
    bins,
    startHz: 1_570_420_000,
    endHz: 1_580_420_000,
    analysisStartBin: 0,
    analysisEndBin: bins.length,
    ...overrides,
  };
}

function pixelAt(png: { width: number; rgba: Uint8Array }, x: number, y: number): number {
  const offset = (y * png.width + x) * 4;
  return packPixel(png.rgba[offset], png.rgba[offset + 1], png.rgba[offset + 2]);
}

describe("incident figure", () => {
  it("encodes a valid PNG whose pixels round-trip", () => {
    const rgba = new Uint8Array(3 * 2 * 4);
    rgba.set([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255]);
    const decoded = decodePng(encodePng(3, 2, rgba));
    expect(decoded).toMatchObject({ width: 3, height: 2 });
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
    expect(() => encodePng(3, 2, new Uint8Array(5))).toThrow("dimensions");
  });

  it("keeps a single-bin spike visible when 2048 bins are drawn into 1024 pixels", () => {
    const palette = buildWaterfallPalette();
    const frames = Array.from({ length: 6 }, (_, index) => {
      const bins = new Uint8Array(2048).fill(20);
      if (index === 3) bins[1501] = 250;
      return frameAt(35 + index * 5, bins);
    });
    const builder = new IncidentFigureBuilder(baseInput({ frameTimestampsMs: frames.map((frame) => frame.timestampMs) }));
    for (const frame of frames) builder.add(frame);
    const result = builder.finish();
    const png = decodePng(result.waterfallPng);
    expect(png.width).toBe(1024);
    const spikeColumn = Math.floor((1501 * 1024) / 2048);
    const matching = Array.from({ length: png.height }, (_, row) => pixelAt(png, spikeColumn, row)).filter((pixel) => pixel === palette.plain[250]);
    expect(matching.length).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({ derived: true, framesUsed: 6, framesDuring: 6, widthPx: 1024, levelScale: "relative-uncalibrated-uint8" });
    expect(result.svg).toContain("RF data can show interference, not intent.");
  });

  it("draws real gaps in time as a distinct neutral colour instead of interpolating", () => {
    const gap = packPixel(43, 47, 54);
    // 100 s of dense frames, a 800 s outage, then 100 s more.
    const seconds = [...Array.from({ length: 100 }, (_, index) => index), ...Array.from({ length: 100 }, (_, index) => 900 + index)];
    const builder = new IncidentFigureBuilder(baseInput({
      windowEndMs: T0 + 1_000_000,
      incidentStartMs: T0 + 50_000,
      incidentEndMs: T0 + 950_000,
      frameTimestampsMs: seconds.map((value) => T0 + value * 1000),
    }));
    for (const value of seconds) builder.add(frameAt(value, new Uint8Array(16).fill(40)));
    const png = decodePng(builder.finish().waterfallPng);
    const column = Array.from({ length: png.height }, (_, row) => pixelAt(png, 0, row));
    expect(column[0]).not.toBe(gap); // newest row
    expect(column[column.length - 1]).not.toBe(gap); // oldest row
    // The outage is about 80% of the window and stays visibly empty.
    expect(column.filter((pixel) => pixel === gap).length).toBeGreaterThan(png.height * 0.6);
  });

  it("counts frames from a different RF setup instead of mixing their axes", () => {
    const builder = new IncidentFigureBuilder(baseInput());
    builder.add(frameAt(40, new Uint8Array(64).fill(30)));
    builder.add(frameAt(41, new Uint8Array(64).fill(30), { startHz: 1_200_000_000, endHz: 1_210_000_000 }));
    builder.add(frameAt(42, new Uint8Array(64).fill(30), { analysisStartBin: 8, analysisEndBin: 56 }));
    builder.add(frameAt(500, new Uint8Array(64).fill(30)));
    const result = builder.finish();
    expect(result.summary).toMatchObject({ framesUsed: 1, framesExcludedRfConfiguration: 3 });
    expect(result.svg).toContain("Left out: 3");
  });

  it("states when no learned normal level is available, and draws it when one matches", () => {
    const withoutBaseline = new IncidentFigureBuilder(baseInput());
    withoutBaseline.add(frameAt(40, new Uint8Array(32).fill(30)));
    const missing = withoutBaseline.finish();
    expect(missing.summary.baselineIncluded).toBe(false);
    expect(missing.svg).toContain("No learned normal level is available");

    const wrongSize = new IncidentFigureBuilder(baseInput({ baseline: { median: new Uint8Array(7).fill(20), mad: new Uint8Array(7).fill(1) } }));
    wrongSize.add(frameAt(40, new Uint8Array(32).fill(30)));
    expect(wrongSize.finish().summary.baselineIncluded).toBe(false);

    const matching = new IncidentFigureBuilder(baseInput({ baseline: { median: new Uint8Array(32).fill(20), mad: new Uint8Array(32).fill(2) } }));
    matching.add(frameAt(40, new Uint8Array(32).fill(90)));
    const drawn = matching.finish();
    expect(drawn.summary.baselineIncluded).toBe(true);
    expect(drawn.svg).toContain("<polygon");
    expect(drawn.svg).not.toContain("No learned normal level is available");
  });

  it("escapes incident text and keeps the package wording rules", () => {
    const builder = new IncidentFigureBuilder(baseInput({
      label: '<script>alert("x")</script> & GPS',
      observed: "Possible spoofing with confidence 91% at -42 dBm.",
    }));
    builder.add(frameAt(40, new Uint8Array(16).fill(30)));
    const { svg } = builder.finish();
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/spoof|confidence|dbm/i);
    expect(svg).toContain("navigation anomaly");
  });

  it("explains an empty figure and still returns a valid PNG", () => {
    const result = new IncidentFigureBuilder(baseInput()).finish();
    expect(result.svg).toContain("No frames were available to draw.");
    expect(result.summary.framesUsed).toBe(0);
    expect(decodePng(result.waterfallPng).height).toBeGreaterThan(0);
  });

  it("bounds the number of rows and keeps a normal inter-frame gap inside one row", () => {
    const longWindow = 48 * 3_600_000;
    expect(longWindow / chooseRowMs([0, 1000, 2000], 0, longWindow)).toBeLessThanOrEqual(360);
    const timestamps = Array.from({ length: 200 }, (_, index) => index * 6000);
    expect(chooseRowMs(timestamps, 0, 200 * 6000)).toBeGreaterThanOrEqual(6000);
  });

  it("burns the time stamp into the PNG itself", () => {
    const frames = [frameAt(40, new Uint8Array(32).fill(30))];
    const builder = new IncidentFigureBuilder(baseInput({ frameTimestampsMs: frames.map((frame) => frame.timestampMs) }));
    for (const frame of frames) builder.add(frame);
    const result = builder.finish();
    expect(result.summary.generatedAt).toBe("2026-11-07T06:30:12.000Z");
    expect(result.summary.pngCaption.join(" ")).toContain("GENERATED 2026-11-07 06:30:12 UTC");
    expect(result.summary.pngCaption[0]).toContain("UTC 2026-11-07 06:00:00 TO 2026-11-07 06:02:00");
    expect(result.svg).toContain("Figure generated (UTC) 2026-11-07 06:30:12");
    const png = decodePng(result.waterfallPng);
    expect(png.width).toBeGreaterThanOrEqual(1024);
    // The caption strip (top rows) holds white text pixels over its own dark background.
    const white = packPixel(255, 255, 255);
    let textPixels = 0;
    for (let y = 0; y < 30; y += 1) for (let x = 0; x < png.width; x += 1) if (pixelAt(png, x, y) === white) textPixels += 1;
    expect(textPixels).toBeGreaterThan(200);
  });

  it("draws different captions differently and keeps the caption ASCII-safe", () => {
    expect(captionText("GPS L1 \u2014 Möbius <b>spoofing</b>")).toBe("GPS L1 M BIUS B NAVIGATION ANOMALY /B");
    const pixels = new Uint32Array(8 * 4).fill(packPixel(10, 20, 30));
    const left = decodePng(composeCaptionedPng(pixels, 8, 4, ["AAAA", ""]));
    const right = decodePng(composeCaptionedPng(pixels, 8, 4, ["BBBB", ""]));
    expect(Buffer.from(left.rgba).equals(Buffer.from(right.rgba))).toBe(false);
    expect(left.height).toBe(right.height);
  });

  it("describes a fixed spike at the window centre, with the learned level and a receiver caution", () => {
    const frames = Array.from({ length: 20 }, (_, index) => {
      const bins = new Uint8Array(64).fill(20);
      if (index >= 5) bins[32] = 90; // exactly the centre of the capture window
      return frameAt(index * 5, bins);
    });
    const builder = new IncidentFigureBuilder(baseInput({
      windowEndMs: T0 + 100_000,
      incidentStartMs: T0 + 25_000,
      incidentEndMs: T0 + 100_000,
      frameTimestampsMs: frames.map((frame) => frame.timestampMs),
      baseline: { median: new Uint8Array(64).fill(20), mad: new Uint8Array(64).fill(1) },
    }));
    for (const frame of frames) builder.add(frame);
    const result = builder.finish();
    expect(result.summary.analysis).toMatchObject({
      framesBefore: 5, framesDuring: 15, strongestLevel: 90, peakStablePct: 100, peakAtWindowCentre: true,
      duringFramesAboveUsualPct: 100, learnedTypical: 20,
    });
    expect(result.summary.analysis.maxExcessSpreads).toBeGreaterThan(30);
    expect(result.summary.analysis.typicalBefore).toBeCloseTo(20, 0);
    const text = result.summary.findings.join(" ");
    expect(text).toContain("fixed-frequency feature");
    expect(text).toContain("centre of the capture window");
    expect(text).toContain("can also come from the receiver itself");
    expect(text).not.toMatch(/intent|jam|spoof|confidence|dbm/i);
    expect(result.analysis.charts.map((chart) => chart.file)).toEqual([
      "figures/chart-level-over-time.svg", "figures/chart-excess-over-time.svg",
      "figures/chart-strongest-frequency.svg", "figures/chart-above-normal-by-frequency.svg",
    ]);
    for (const chart of result.analysis.charts) {
      expect(chart.svg).toContain("Figure generated 2026-11-07 06:30:12 UTC");
      expect(chart.svg).toContain("RF data can show interference, not intent.");
    }
    expect(result.analysis.sheetSvg).toContain("What the recorded frames show");
  });

  it("describes a moving signal differently, and says so when there is no learned level", () => {
    const frames = Array.from({ length: 24 }, (_, index) => {
      const bins = new Uint8Array(200).fill(20);
      bins[10 + index * 7] = 120; // sweeps across the band
      return frameAt(index * 4, bins);
    });
    const builder = new IncidentFigureBuilder(baseInput({
      windowEndMs: T0 + 100_000,
      incidentStartMs: T0,
      incidentEndMs: T0 + 100_000,
      frameTimestampsMs: frames.map((frame) => frame.timestampMs),
    }));
    for (const frame of frames) builder.add(frame);
    const result = builder.finish();
    const text = result.summary.findings.join(" ");
    expect(text).toContain("The strongest signal moved");
    expect(text).toContain("No learned normal level is available");
    expect(result.summary.analysis.peakAtWindowCentre).toBe(false);
    expect(result.summary.analysis.maxExcessSpreads).toBeUndefined();
    expect(result.analysis.charts[1].svg).toContain("No learned normal level is available");
  });

  it("states plainly when there are no frames during the incident", () => {
    const result = new IncidentFigureBuilder(baseInput()).finish();
    expect(result.summary.findings[0]).toContain("No frames were recorded");
    expect(describeAnalysis).toBeTypeOf("function");
  });
});
