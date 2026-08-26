import { describe, expect, it } from "vitest";
import { formatCompactBytes, formatCompactPercent, formatCompactRate, timeOnly, timeZoneShort } from "../src/client/format";

describe("timestamp display", () => {
  it("keeps UTC and configurable display time zones distinct", () => {
    const timestamp = "2026-01-15T12:00:00.000Z";
    expect(timeOnly(timestamp, "UTC")).toContain("12:00:00");
    expect(timeOnly(timestamp, "Europe/Athens")).toContain("14:00:00");
    expect(timeZoneShort("UTC", new Date(timestamp))).toMatch(/UTC|GMT/);
  });

  it("uses concise rounded units for operator checks", () => {
    expect(formatCompactBytes(512)).toBe("512 B");
    expect(formatCompactBytes(128 * 1024 * 1024)).toBe("128 MB");
    expect(formatCompactBytes(100 * 1024 * 1024 * 1024)).toBe("100 GB");
    expect(formatCompactRate(2_000)).toBe("2 KB/s");
    expect(formatCompactPercent(30.25)).toBe("30%");
    expect(formatCompactPercent(8.5)).toBe("8.5%");
  });
});
