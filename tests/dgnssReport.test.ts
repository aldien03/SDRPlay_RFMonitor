import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { validateDgnssConfig } from "../src/shared/dgnss";
import { mergeSbs, parseSbs, SbsParser, type SbsParseWindow } from "../src/server/positioning/sbs";
import { reportWindow } from "../src/server/positioning/pipeline";
import { analyseRf, defaultRfLanes, RfAccumulator } from "../src/server/positioning/rfAnalysis";
import { streamSessionFrames } from "../src/server/positioning/evidenceSource";
import { DgnssReportService, DgnssUserError } from "../src/server/positioning/service";
import type { RfFrame } from "../src/server/positioning/rfEvidence";

const SYSTEMS = [
  { id: "DGPS1", output: "G4", receiver: "Starpack A", antenna: "Tualcom", beam: "EASAT" },
  { id: "DGPS2", output: "G4", receiver: "Starpack A", antenna: "Tualcom", beam: "EASAT" },
  { id: "DGPS3", output: "XP3", receiver: "Starpack B", antenna: "Calian", beam: "EASAT" },
  { id: "DGPS4", output: "G4", receiver: "AsteRx", antenna: "Calian", beam: "ERSAT" },
];

/**
 * A small Gator SBS export: pages per DGPS, value + Quality column pairs.
 * Shot n is at start + (n - 1) x 5 s, so files cut from one export share times and values.
 */
function sbsText(options: { shots?: number; startSeconds?: number; systems?: number; firstShot?: number; firstPage?: number; zeroTail?: boolean; lineName?: string } = {}): string {
  const shots = options.shots ?? 60;
  const first = options.firstShot ?? 1;
  const start = options.startSeconds ?? Date.parse("2026-11-10T08:00:00Z") / 1000;
  const zeroTail = options.zeroTail ?? true;
  const lines: string[] = [];
  const firstPage = options.firstPage ?? 1;
  for (let page = firstPage; page < firstPage + (options.systems ?? 4); page += 1) {
    const qc = `SSTDG${page}_QC`;
    lines.push(`# Line name\t${options.lineName ?? "314-08.00.00"}`, `Page ${page}\tDGPS${page}_QC\tAll Shots`);
    const fields = [
      `${qc} SST Latitude`, `${qc} SST Longitude`, `${qc} SST Height`, `${qc} SST Easting`, `${qc} SST Northing`,
      `${qc} SSTDG${page} Latitude`, `${qc} SSTDG${page} Longitude`, `${qc} SSTDG${page} Height`, `${qc} SSTDG${page} Easting`, `${qc} SSTDG${page} Northing`,
      `Raw: SST_DGPS${page} PDOP`, `Raw: SST_DGPS${page} HDOP`, `Raw: SST_DGPS${page} PCALC`, `Raw: SST_DGPS${page} Unit Variance`, `Raw: SST_DGPS${page} NSats Tracked`, `Raw: SST_DGPS${page} Age Correction`,
    ];
    lines.push(["Shot", "Raw Time", "Time", "Date", ...fields.flatMap((field) => [field, "Quality"])].join("\t"), "");
    for (let shot = first; shot < first + shots; shot += 1) {
      const last = zeroTail && shot >= first + shots - 2;
      const wobble = Math.sin(shot + page) * 0.02;
      const values = [34.6, 33.0, 0, 501612 + page * 0.01 + wobble, 3834773 + wobble, 34.6, 33.0, 25.9, 501611.5, 3834773.6,
        last ? 0 : 1.2, last ? 0 : 0.7, last ? 0 : 5, 0, last ? 0 : 20 + page, last ? 0 : 6];
      lines.push([String(shot), (start + (shot - 1) * 5 + 0.999).toFixed(6), "08:00:00", "10 Nov 2026", ...values.flatMap((value) => [String(value), "[OK]"])].join("\t"));
    }
  }
  return `${lines.join("\n")}\n`;
}

function frame(timeMs: number, raised: boolean): RfFrame {
  const bins = new Uint8Array(512).fill(20);
  if (raised) for (let bin = 120; bin < 380; bin += 1) bins[bin] = 60;
  return {
    timeMs, targetId: "gnss-l1-e1-b1c-sbas", bandId: "gps-l1", meanLevel: raised ? 40 : 20, peakLevel: raised ? 70 : 30, baselineLevel: 20,
    medianZ: raised ? 9 : 0.5, peakZ: raised ? 30 : 2, occupied: raised ? 0.6 : 0, maxWidth: raised ? 0.6 : 0, powerDbm: raised ? -95 : -107, snrDb: 7,
    overload: false, startHz: 1_570_420_000, endHz: 1_580_420_000, analysisStartBin: 51, analysisEndBin: 460, bins,
  };
}

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dgnss-test-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Gator SBS parser", () => {
  it("reads pages by header name and treats the end-of-line all-zero raw QC as missing", () => {
    const dataset = parseSbs(sbsText());
    expect(dataset.lineName).toBe("314-08.00.00");
    expect(dataset.systems.map((system) => system.id)).toEqual(["DGPS1", "DGPS2", "DGPS3", "DGPS4"]);
    expect(dataset.shotCount).toBe(60);
    expect(dataset.intervalMs).toBe(5000);
    expect(dataset.missingRawQcShots).toBe(2);
    const shot = dataset.systems[0].shots.at(-1)!;
    expect(shot.nsats).toBeNull();
    expect(shot.crpE).toBeCloseTo(501612, 0);
    expect(dataset.systems[0].shots[0].ageS).toBe(6);
  });

  it("rejects files that are not SBS exports", () => {
    expect(() => parseSbs("Time,Easting,Northing\n1,2,3\n")).toThrow(/No DGNSS pages/);
  });
});

describe("combining split Gator files", () => {
  const T0 = Date.parse("2026-11-10T08:00:00Z");
  const part = (text: string, window?: SbsParseWindow) => {
    const parser = new SbsParser(window);
    for (const line of text.split("\n")) parser.line(line);
    return parser.part();
  };

  it("joins a contiguous split into one dataset with one coverage span", () => {
    const dataset = mergeSbs([part(sbsText({ shots: 60, zeroTail: false })), part(sbsText({ firstShot: 61, shots: 60, zeroTail: false }))]);
    expect(dataset.systems.map((system) => system.id)).toEqual(["DGPS1", "DGPS2", "DGPS3", "DGPS4"]);
    expect(dataset.shotCount).toBe(120);
    expect(dataset.intervalMs).toBe(5000);
    expect(dataset.coverage).toHaveLength(1);
    expect(dataset.duplicateShots).toBe(0);
    expect(dataset.files.map((file) => file.epochs)).toEqual([60, 60]);
  });

  it("keeps a shot repeated by overlapping files once and counts it", () => {
    const dataset = mergeSbs([part(sbsText({ shots: 60, zeroTail: false })), part(sbsText({ firstShot: 41, shots: 80, zeroTail: false }))]);
    expect(dataset.shotCount).toBe(120);
    expect(dataset.duplicateShots).toBe(20 * 4);
    expect(dataset.conflictingShots).toBe(0);
    const times = dataset.systems[0].shots.map((shot) => shot.timeMs);
    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort((left, right) => left - right)).toEqual(times);
  });

  it("marks a gap between files and counts repeated shots whose values differ", () => {
    const dataset = mergeSbs([part(sbsText({ shots: 60 })), part(sbsText({ firstShot: 59, shots: 60, zeroTail: false })), part(sbsText({ firstShot: 201, shots: 20, zeroTail: false }))]);
    expect(dataset.coverage).toHaveLength(2);
    expect(dataset.coverage[0][1]).toBe(T0 + 117 * 5000 + 999 + 5000);
    expect(dataset.conflictingShots).toBe(2 * 4);
  });

  it("joins files holding different systems for the same period", () => {
    const dataset = mergeSbs([part(sbsText({ systems: 2 })), part(sbsText({ systems: 2, firstPage: 3 }))]);
    expect(dataset.systems.map((system) => system.id)).toEqual(["DGPS1", "DGPS2", "DGPS3", "DGPS4"]);
    expect(dataset.duplicateShots).toBe(0);
  });

  it("treats a page repeated inside one file as one system", () => {
    const dataset = parseSbs(`${sbsText({ shots: 30, zeroTail: false })}${sbsText({ firstShot: 31, shots: 30 })}`);
    expect(dataset.systems).toHaveLength(4);
    expect(dataset.shotCount).toBe(60);
    expect(dataset.missingRawQcShots).toBe(2);
  });

  it("parses only the shots inside a window", () => {
    const dataset = parseSbs(sbsText(), { fromMs: T0 + 100_000, toMs: T0 + 200_000 });
    expect(dataset.shotCount).toBe(20);
    expect(dataset.startMs).toBeGreaterThanOrEqual(T0 + 100_000);
  });

  it("allows the SBS span window only up to 24 h and checks the chosen day", () => {
    const long = { startMs: T0, endMs: T0 + 30 * 3_600_000, intervalMs: 5000 };
    expect(() => reportWindow(long, { mode: "sbs" })).toThrow(/more than 24 h/);
    expect(reportWindow(long, { mode: "utc-day", day: "2026-11-11" }).startMs).toBe(Date.parse("2026-11-11T00:00:00Z"));
    expect(() => reportWindow(long, { mode: "utc-day", day: "2026-11-14" })).toThrow(/no Gator data/);
    expect(() => reportWindow(long, { mode: "utc-day", day: "11/11/2026" })).toThrow(/Choose a UTC day/);
  });
});

describe("DGNSS configuration", () => {
  it("accepts a complete table and reports field errors otherwise", () => {
    expect(validateDgnssConfig({ systems: SYSTEMS, controlId: "DGPS1", agreementM: 0.5, movingKnots: 0.5 }).config?.systems).toHaveLength(4);
    const bad = validateDgnssConfig({ systems: [{ ...SYSTEMS[0], receiver: "" }, SYSTEMS[0]], controlId: "X", agreementM: 50, movingKnots: 0.5 });
    expect(bad.config).toBeUndefined();
    expect(bad.fields["systems.0.receiver"]).toBe("Required");
    expect(bad.fields["systems.1.id"]).toBe("Each id once");
    expect(bad.fields.controlId).toBeDefined();
    expect(bad.fields.agreementM).toBeDefined();
  });
});

describe("streaming RF analysis", () => {
  const window = { mode: "custom" as const, startMs: Date.parse("2026-11-10T08:00:00Z"), endMs: Date.parse("2026-11-10T08:10:00Z") };

  it("finds one wideband episode with k-of-n voting and ignores an isolated spike", async () => {
    const frames: RfFrame[] = [];
    for (let second = 0; second < 600; second += 1) frames.push(frame(window.startMs + second * 1000, (second >= 120 && second < 180) || second === 400));
    const result = await analyseRf({ frames, window, lanes: defaultRfLanes([]), source: "rf-monitor" });
    expect(result.episodes).toHaveLength(1);
    const [episode] = result.episodes;
    expect(episode.type).toBe("wideband");
    expect(episode.fromMs).toBe(window.startMs + 120_000);
    expect(episode.toMs).toBe(window.startMs + 180_000);
    expect(episode.widthMHz).toBeGreaterThan(3);
    expect(result.lanes[0].stats.monitoredFraction).toBeGreaterThan(0.99);
    expect(result.lanes[0].waterfall?.pngBase64).toBeTruthy();
    expect(result.lanes[1].stats.frames).toBe(0);
  });

  it("restores time order when the evidence file is written in batches", async () => {
    const session = await tempDir();
    await mkdir(path.join(session, "spectrum", "raw"), { recursive: true });
    const frames: RfFrame[] = [];
    for (let second = 0; second < 300; second += 1) frames.push(frame(window.startMs + second * 1000, second >= 100 && second < 160));
    // Batches of 30 s written newest-first inside each batch, as the recorder can.
    const order: RfFrame[] = [];
    for (let batch = 0; batch < frames.length; batch += 30) order.push(...frames.slice(batch, batch + 30).reverse());
    const raw = Buffer.concat(order.map((entry) => Buffer.from(entry.bins!)));
    await writeFile(path.join(session, "spectrum", "raw", "frames-part-001.bin"), raw);
    await writeFile(path.join(session, "spectrum", "frames.jsonl"), order.map((entry, index) => JSON.stringify({
      timestamp: new Date(entry.timeMs).toISOString(), bandId: "gps-l1", meanLevel: entry.meanLevel, peakLevel: entry.peakLevel, baselineLevel: 20,
      medianRobustZ: entry.medianZ, peakRobustZ: entry.peakZ, occupiedRatio: entry.occupied, maximumOccupiedWidthRatio: entry.maxWidth,
      rawFile: "spectrum/raw/frames-part-001.bin", rawOffset: index * 512, rawLength: 512,
      frame: { targetId: entry.targetId, startHz: entry.startHz, endHz: entry.endHz, analysisStartBin: 51, analysisEndBin: 460, inputBinCount: 512 },
    })).join("\n"));
    const accumulator = new RfAccumulator(defaultRfLanes([]), window);
    expect(await streamSessionFrames(session, window, accumulator)).toBe(300);
    const result = accumulator.finish("rf-monitor");
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].fromMs).toBe(window.startMs + 100_000);
  });
});

async function finished(svc: DgnssReportService, id: string) {
  let report = (await svc.get(id))!;
  for (let tries = 0; tries < 400 && (report.state === "queued" || report.state === "running"); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    report = (await svc.get(id))!;
  }
  return report;
}

describe("DGNSS report service", () => {
  async function service(configure = true) {
    const root = await tempDir();
    const evidenceRoot = path.join(root, "evidence");
    await mkdir(evidenceRoot, { recursive: true });
    const audit: string[] = [];
    const svc = await DgnssReportService.open({
      root: path.join(root, "dgnss"),
      configPath: path.join(root, "settings", "dgnss-report-v1.json"),
      evidenceRoot,
      dataDomain: "field",
      retentionMs: 30 * 86_400_000,
      identity: () => ({ vesselName: "Test vessel" }),
      targetLabel: (id) => id,
      canStart: () => true,
      audit: async (action) => {
        audit.push(action);
      },
    });
    if (configure) await svc.saveConfig({ systems: SYSTEMS, controlId: "DGPS1", agreementM: 0.5, movingKnots: 0.5 }, 0, "127.0.0.1");
    return { svc, root, audit };
  }

  it("uploads a gzip SBS, previews it, and builds PDF, HTML and the evidence package", async () => {
    const { svc, audit } = await service();
    expect(audit).toEqual(["dgnss-report-configuration-saved"]);
    const preview = await svc.upload(gzipSync(Buffer.from(sbsText())), "line.sbs");
    expect(preview.systemsFound).toEqual(["DGPS1", "DGPS2", "DGPS3", "DGPS4"]);
    expect(preview.rf.sessionCoverage).toBe(0);
    expect(preview.warnings.join(" ")).toMatch(/positioning only/);
    const queued = await svc.generate([preview.uploadId], { mode: "sbs" });
    const report = await finished(svc, queued.id);
    expect(report.state).toBe("ready");
    expect(report.status).toBeDefined();
    expect(report.facts?.pages).toBeGreaterThan(3);
    const pdf = await svc.file(report.id, "pdf");
    expect((await readFile(pdf!.path)).subarray(0, 4).toString()).toBe("%PDF");
    const zip = await svc.file(report.id, "package");
    expect((await stat(zip!.path)).size).toBeGreaterThan(1000);
    expect(pdf!.name).toMatch(/^DGNSS_Report_314-08\.00\.00_.*_sbs\.pdf$/);
    expect((await svc.list()).map((entry) => entry.id)).toContain(report.id);
  }, 30_000);

  it("explains a wrong file, an unconfigured table and a stale revision", async () => {
    const { svc } = await service(false);
    await expect(svc.upload(Buffer.from("not,an,sbs\n"), "x.csv")).rejects.toThrow(/Not a Gator SBS export/);
    const preview = await svc.upload(Buffer.from(sbsText()), "line.sbs");
    expect(preview.warnings[0]).toMatch(/not set up/);
    await expect(svc.generate([preview.uploadId], { mode: "sbs" })).rejects.toBeInstanceOf(DgnssUserError);
    await expect(svc.saveConfig({ systems: SYSTEMS, controlId: "DGPS1", agreementM: 0.5, movingKnots: 0.5 }, 7, "127.0.0.1")).rejects.toThrow(/changed elsewhere/);
  });

  it("combines split files across midnight into one report for a chosen UTC day", async () => {
    const { svc } = await service();
    const start = Date.parse("2026-11-10T23:50:00Z") / 1000;
    const a = await svc.upload(gzipSync(Buffer.from(sbsText({ startSeconds: start, shots: 60, zeroTail: false }))), "part-a.sbs");
    const c = await svc.upload(Buffer.from(sbsText({ startSeconds: start, firstShot: 161, shots: 60 })), "part-c.sbs");
    const b = await svc.upload(gzipSync(Buffer.from(sbsText({ startSeconds: start, firstShot: 61, shots: 60, zeroTail: false }))), "part-b.sbs");
    const again = await svc.upload(Buffer.from(sbsText({ startSeconds: start, shots: 60, zeroTail: false })), "part-a-copy.sbs");

    const preview = await svc.previewSet([c.uploadId, a.uploadId, b.uploadId, again.uploadId]);
    expect(preview.files.map((file) => file.fileName)).toEqual(["part-a.sbs", "part-b.sbs", "part-c.sbs"]);
    expect(preview.days).toEqual(["2026-11-10", "2026-11-11"]);
    expect(preview.spanFitsDay).toBe(true);
    expect(preview.gaps).toHaveLength(1);
    expect(preview.overlaps).toHaveLength(0);
    expect(preview.warnings.join(" ")).toMatch(/Same file added twice/);
    expect(preview.warnings.join(" ")).toMatch(/No Gator data/);

    const queued = await svc.generate(preview.uploadIds, { mode: "utc-day", day: "2026-11-11" });
    expect(queued.window.startMs).toBe(Date.parse("2026-11-11T00:00:00Z"));
    expect(queued.fileName).toBe("3 SBS files");
    expect(queued.sbsFiles?.map((file) => file.name)).toEqual(["part-a.sbs", "part-b.sbs", "part-c.sbs"]);
    const report = await finished(svc, queued.id);
    expect(report.error).toBeUndefined();
    expect(report.state).toBe("ready");
    const html = await readFile((await svc.file(report.id, "html"))!.path, "utf8");
    expect(html).toContain("SBS Source Files");
    expect(html).toContain("Gator data continuity");
    expect(html).toContain("Outside window");
    expect(html).toContain("3 Gator SBS files");
    const zip = await readFile((await svc.file(report.id, "package"))!.path);
    for (const name of ["input/01_part-a.sbs", "input/02_part-b.sbs", "input/03_part-c.sbs", "manifest.json", "SHA256SUMS.txt"]) expect(zip.includes(Buffer.from(name))).toBe(true);
  }, 30_000);

  it("needs a UTC day or custom window when the files cover more than 24 h", async () => {
    const { svc } = await service();
    const day1 = await svc.upload(Buffer.from(sbsText()), "day1.sbs");
    const day2 = await svc.upload(Buffer.from(sbsText({ startSeconds: Date.parse("2026-11-11T09:00:00Z") / 1000 })), "day2.sbs");
    const preview = await svc.previewSet([day1.uploadId, day2.uploadId]);
    expect(preview.spanFitsDay).toBe(false);
    expect(preview.warnings.join(" ")).toMatch(/Choose a UTC day/);
    await expect(svc.generate(preview.uploadIds, { mode: "sbs" })).rejects.toThrow(/more than 24 h/);
    await expect(svc.previewSet([])).rejects.toThrow(/at least one/);
  });

  it("loads a saved table that still has the removed IP and splitter group columns", async () => {
    const root = await tempDir();
    const configPath = path.join(root, "dgnss-report-v1.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, revision: 3, controlId: "DGPS1", agreementM: 0.5, movingKnots: 0.5, systems: SYSTEMS.map((system) => ({ ...system, antennaGroup: system.antenna, ip: ".60" })) }));
    const svc = await DgnssReportService.open({
      root: path.join(root, "dgnss"), configPath, evidenceRoot: path.join(root, "evidence"), dataDomain: "field", retentionMs: 86_400_000,
      identity: () => ({ vesselName: "Test vessel" }), targetLabel: (id) => id, canStart: () => true, audit: async () => undefined,
    });
    const response = svc.configResponse(false);
    expect(response.configured).toBe(true);
    expect(response.config.revision).toBe(3);
    expect(Object.keys(response.config.systems[0]).sort()).toEqual(["antenna", "beam", "id", "output", "receiver"]);
  });
});
