import type { ReceiverState } from "./types";
import { parseReportedReceiverModel } from "./productContract";

export const MAX_LIVE_SPECTRUM_AGE_MS = 15_000;

export interface MonitoringReadiness {
  ready: boolean;
  issue?: string;
}

export function getMonitoringReadiness(
  receivers: ReceiverState[],
  nowMs = Date.now(),
): MonitoringReadiness {
  if (receivers.some((receiver) => receiver.connection === "simulated")) return { ready: true };

  if (receivers.some((receiver) => receiver.hardwareState === "absent")) {
    return { ready: false, issue: "The SDRplay USB receiver is not detected. Reconnect its USB cable; RF Monitor will retry automatically." };
  }

  const connected = receivers.filter((receiver) => receiver.connection === "live" && receiver.streamState !== "stopped");
  if (connected.length === 0) {
    return { ready: false, issue: "RF Monitor is not connected to SDRconnect." };
  }

  const liveReceivers = connected.filter((receiver) => Boolean(parseReportedReceiverModel(receiver.deviceName)));
  const hasFreshFrame = liveReceivers.some((receiver) => {
    if (!receiver.lastFrameAt) return false;
    const frameAgeMs = nowMs - Date.parse(receiver.lastFrameAt);
    return Number.isFinite(frameAgeMs) && frameAgeMs >= -5_000 && frameAgeMs <= MAX_LIVE_SPECTRUM_AGE_MS;
  });
  if (hasFreshFrame) return { ready: true };

  if (connected.some((receiver) => receiver.deviceName?.trim())) {
    const iqFileSelected = connected.some((receiver) => receiver.deviceName?.trim().toLowerCase() === "iq file");
    return {
      ready: false,
      issue: iqFileSelected
        ? "SDRconnect is running, but no physical SDRplay RSP is selected. IQ File is not live RF."
        : connected.some((receiver) => parseReportedReceiverModel(receiver.deviceName))
        ? "A physical SDRplay receiver is selected, but no recent spectrum frames are arriving."
        : "SDRconnect reports an unsupported receiver model. Select an RSPdx or RSPdx R2.",
    };
  }

  return {
    ready: false,
    issue: "SDRconnect is running, but no physical SDRplay RSP is selected. IQ File is not live RF.",
  };
}
