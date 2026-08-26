import { describe, expect, it } from "vitest";
import { compileScanTargets, createScanJobs, createScanWindows, generateChannelCenters, mergeBandOverrides } from "../src/shared/bands";
import { FOUR_DX_BAND, GNSS_BANDS, STARTRACK_BAND } from "./catalogFixture";

describe("band registry", () => {
  it("generates all 91 4DX centers at 280 kHz spacing", () => {
    const centers = generateChannelCenters(FOUR_DX_BAND);
    expect(centers).toHaveLength(91);
    expect(centers[0]).toBe(902_400_000);
    expect(centers[1]).toBe(902_680_000);
    expect(centers[45]).toBe(915_000_000);
    expect(centers[90]).toBe(927_600_000);
  });

  it("preserves the StarTrack 25 kHz channel plan", () => {
    const centers = generateChannelCenters(STARTRACK_BAND);
    expect(centers).toHaveLength(2_401);
    expect(centers[1] - centers[0]).toBe(25_000);
    expect(centers.at(-1)).toBe(470_000_000);
  });

  it("contains common GPS, GLONASS, Galileo, BeiDou, and SBAS signal groups", () => {
    expect(new Set(GNSS_BANDS.map((band) => band.constellation))).toEqual(
      new Set(["GPS", "GLONASS", "Galileo", "BeiDou", "SBAS"]),
    );
    expect(GNSS_BANDS.some((band) => band.id === "gps-l1" && band.centerHz === 1_575_420_000)).toBe(true);
    expect(GNSS_BANDS.some((band) => band.id === "beidou-b3i" && band.centerHz === 1_268_520_000)).toBe(true);
  });

  it("marks explicit coverage gaps with one receiver", () => {
    const jobs = createScanJobs([STARTRACK_BAND, FOUR_DX_BAND, GNSS_BANDS[0]], 1, 0);
    expect(jobs[0].status).toBe("active");
    expect(jobs.slice(1).every((job) => job.status === "coverage-gap")).toBe(true);
    expect(jobs.every((job) => job.mode === "priority-scan")).toBe(true);
  });

  it("covers broad presets with overlapping instantaneous windows", () => {
    const windows = createScanWindows(STARTRACK_BAND, 10_000_000, 0.2);
    expect(windows).toHaveLength(8);
    expect(windows[0]).toMatchObject({ startHz: 410_000_000, endHz: 420_000_000, centerHz: 415_000_000 });
    expect(windows.at(-1)).toMatchObject({ startHz: 460_000_000, endHz: 470_000_000, centerHz: 465_000_000 });
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].startHz).toBeLessThan(windows[index - 1].endHz);
    }

    const fourDxWindows = createScanWindows(FOUR_DX_BAND, 10_000_000, 0.2);
    expect(fourDxWindows[0].startHz).toBe(902_400_000);
    expect(fourDxWindows.at(-1)?.endHz).toBe(927_600_000);
  });

  it("coalesces shared GNSS windows without losing band attribution", () => {
    const shared = GNSS_BANDS.filter((band) => ["gps-l1", "galileo-e1", "beidou-b1c"].includes(band.id));
    const targets = compileScanTargets(shared, 10_000_000);
    expect(targets.length).toBeLessThan(shared.flatMap((band) => createScanWindows(band, 10_000_000)).length);
    expect(new Set(targets.flatMap((target) => target.coverage.map((entry) => entry.band.id)))).toEqual(new Set(shared.map((band) => band.id)));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: "gnss-l1-e1-b1c-sbas", centerHz: 1_575_420_000, analysisSpanHz: 8_000_000 });
  });

  it("narrows experimental 9 MS/s physical frequency metadata instead of claiming a 10 MHz capture", () => {
    const shared = GNSS_BANDS.filter((band) => band.captureTargetId === "gnss-l1-e1-b1c-sbas");
    const [target] = compileScanTargets(shared, 9_000_000);
    expect(target.endHz - target.startHz).toBe(9_000_000);
    expect(target.centerHz).toBe(1_575_420_000);
    expect(target.analysisSpanHz).toBe(8_000_000);
  });

  it("can disable defaults and add a fully configured custom band", () => {
    const configured = mergeBandOverrides([STARTRACK_BAND], [
      { id: STARTRACK_BAND.id, enabled: false },
      {
        id: "custom-band",
        label: "Custom band",
        service: "gnss",
        startHz: 1_000_000,
        endHz: 2_000_000,
        centerHz: 1_500_000,
        priority: 1,
        dwellMs: 1_000,
        editable: true,
      },
    ]);
    expect(configured.map((band) => band.id)).toEqual(["custom-band"]);
  });
});
