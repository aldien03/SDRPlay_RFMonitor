#!/usr/bin/env node
import WebSocket from "ws";

const argumentsList = process.argv.slice(2);
const spectrumRequested = argumentsList.includes("--spectrum");
const urlArgument = argumentsList.find((argument) => argument.startsWith("--url="));
const endpoint = urlArgument?.slice("--url=".length)
  || process.env.SDRCONNECT_URL?.split(",")[0]?.trim()
  || "ws://127.0.0.1:5454/";
const timeoutMs = Number(process.env.SDRCONNECT_VERIFY_TIMEOUT_MS)
  || (spectrumRequested ? 10_000 : 4_000);
const deviceIndex = Number(process.env.SDRCONNECT_DEVICE_INDEX ?? 0);

if (!Number.isInteger(deviceIndex) || deviceIndex < 0) {
  console.error("SDRCONNECT_DEVICE_INDEX must be a non-negative integer.");
  process.exitCode = 1;
} else {
  await verify();
}

async function verify() {
  const summary = {
    endpoint,
    connected: false,
    apiVersion: null,
    activeDevice: null,
    deviceSerialPresent: false,
    validDevices: null,
    properties: {},
    spectrumRequested,
    spectrumFrames: 0,
    lastSpectrumType: null,
    lastSpectrumBytes: 0,
    readiness: { socket: false, api: false, device: false, stream: false },
  };
  let finished = false;
  let timer;
  let socket;

  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    const activeDevice = String(summary.activeDevice ?? "").trim();
    const supportedReceiver = /^(?:RSPdx|RSPdx(?: |-)R2)$/i.test(activeDevice);
    summary.readiness = {
      socket: summary.connected,
      api: Boolean(summary.apiVersion),
      device: supportedReceiver && summary.deviceSerialPresent,
      stream: summary.spectrumFrames > 0,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (error) {
      console.error(`SDRconnect verification failed: ${error.message}`);
      process.exitCode = 1;
    }
  };

  const send = (eventType, property = "", value = "") => {
    socket.send(JSON.stringify({
      event_type: eventType,
      property,
      value: String(value),
    }));
  };

  socket = new WebSocket(endpoint, {
    rejectUnauthorized: process.env.SDRCONNECT_TLS_REJECT_UNAUTHORIZED !== "false",
  });

  timer = setTimeout(() => {
    if (!summary.apiVersion) {
      finish(new Error("WebSocket opened, but SDRconnect did not return api_version."));
      return;
    }
    if (spectrumRequested && summary.spectrumFrames === 0) {
      finish(new Error("JSON API responded, but no type 3 or type 6 spectrum frame arrived. Select and start a physical RSP device, then retry."));
      return;
    }
    finish();
  }, timeoutMs);

  socket.on("open", () => {
    summary.connected = true;
    for (const property of [
      "api_version",
      "active_device",
      "device_serial",
      "valid_devices",
      "device_center_frequency",
      "device_sample_rate",
      "started",
      "can_control",
      "active_antenna",
      "signal_power",
      "signal_snr",
      "overload",
    ]) {
      send("get_property", property);
    }
    if (spectrumRequested) {
      send("selected_device", "", deviceIndex);
      send("device_stream_enable", "", "true");
      send("spectrum_enable", "", "true");
    }
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(data);
      if (frame.byteLength < 3) return;
      const type = frame.readUInt16LE(0);
      if (type !== 3 && type !== 6) return;
      summary.spectrumFrames += 1;
      summary.lastSpectrumType = type;
      summary.lastSpectrumBytes = frame.byteLength - 2;
      return;
    }
    try {
      const message = JSON.parse(data.toString());
      if (typeof message.property !== "string" || !message.property) return;
      summary.properties[message.property] = message.value;
      if (message.property === "api_version") summary.apiVersion = message.value;
      if (message.property === "active_device") summary.activeDevice = message.value;
      if (message.property === "device_serial") {
        const serial = String(message.value ?? "").trim();
        summary.deviceSerialPresent = Boolean(serial)
          && serial.length <= 128
          && !/^(?:unknown|none|null|n\/?a|not[- ]?reported)$/i.test(serial)
          && !/[\u0000-\u001f\u007f]/.test(serial);
      }
      if (message.property === "valid_devices") summary.validDevices = message.value;
    } catch {
      finish(new Error("SDRconnect returned invalid JSON."));
    }
  });

  socket.on("error", (error) => finish(error));
  socket.on("close", () => {
    if (!finished) finish(new Error("SDRconnect closed the WebSocket before verification completed."));
  });
}
