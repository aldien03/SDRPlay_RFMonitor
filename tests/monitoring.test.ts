import { describe, expect, it } from "vitest";
import { getMonitoringReadiness } from "../src/shared/monitoring";
import type { ReceiverState } from "../src/shared/types";

const now = Date.parse("2026-08-20T12:00:00.000Z");

function receiver(overrides: Partial<ReceiverState>): ReceiverState {
  return { id: 0, url: "ws://127.0.0.1:5454/", connection: "live", ...overrides };
}

describe("monitoring readiness", () => {
  it("explains when the physical receiver is unplugged", () => {
    expect(getMonitoringReadiness([receiver({ hardwareState: "absent", streamState: "stopped" })], now)).toEqual({
      ready: false,
      issue: "The SDRplay USB receiver is not detected. Reconnect its USB cable; RF Monitor will retry automatically.",
    });
  });

  it("rejects SDRconnect's IQ File fallback as live RF", () => {
    expect(getMonitoringReadiness([receiver({ deviceName: "IQ File" })], now)).toEqual({
      ready: false,
      issue: "SDRconnect is running, but no physical SDRplay RSP is selected. IQ File is not live RF.",
    });
  });

  it.each(["Clone RSPdx", "RSPdx Pro", "RSPdx (TEST)", "NotRSPdx"])(
    "rejects deceptive or unsupported receiver identity %s even with fresh frames",
    (deviceName) => {
      expect(getMonitoringReadiness([receiver({
        deviceName,
        lastFrameAt: "2026-08-20T11:59:55.000Z",
      })], now)).toEqual({
        ready: false,
        issue: "SDRconnect reports an unsupported receiver model. Select an RSPdx or RSPdx R2.",
      });
    },
  );

  it("requires a recent spectrum frame from the selected physical receiver", () => {
    expect(getMonitoringReadiness([receiver({ deviceName: "RSPdx-R2" })], now).ready).toBe(false);
    expect(getMonitoringReadiness([receiver({
      deviceName: "RSPdx-R2",
      lastFrameAt: "2026-08-20T11:59:55.000Z",
    })], now)).toEqual({ ready: true });
    expect(getMonitoringReadiness([receiver({
      deviceName: "RSPdx-R2",
      lastFrameAt: "2026-08-20T11:59:30.000Z",
    })], now).ready).toBe(false);
    expect(getMonitoringReadiness([receiver({
      deviceName: "RSPdx (2237073D48)",
      lastFrameAt: "2026-08-20T11:59:55.000Z",
    })], now)).toEqual({ ready: true });
  });

  it("keeps explicit simulation available without presenting IQ replay as hardware", () => {
    expect(getMonitoringReadiness([receiver({ connection: "simulated" })], now)).toEqual({ ready: true });
  });
});
