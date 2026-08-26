import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  parseSdrconnectDeviceSerial,
  applySdrconnectTuneReadback,
  parseSdrconnectDeviceModel,
  parseBinaryPayload,
  parseSpectrumPayload,
  SdrconnectClient,
  validateSdrconnectFrameEpoch,
  type ExpectedSdrconnectFrameEpoch,
  type SdrconnectPropertyMessage,
} from "../src/server/sdrconnectClient";

describe("SDRconnect client", () => {
  const closers: Array<() => void> = [];
  afterEach(() => closers.splice(0).forEach((close) => close()));

  it("parses type 3 and type 6 spectrum frames after the two-byte header", () => {
    expect(Array.from(parseSpectrumPayload(Buffer.from([3, 0, 10, 20, 30]))!)).toEqual([10, 20, 30]);
    expect(Array.from(parseSpectrumPayload(Buffer.from([6, 0, 9, 8]))!)).toEqual([9, 8]);
    expect(parseSpectrumPayload(Buffer.from([2, 0, 1, 2]))).toBeUndefined();
    expect(parseBinaryPayload(Buffer.from([2, 0, 7, 6]))).toEqual({ type: 2, payload: Uint8Array.from([7, 6]) });
  });

  it.each([
    ["RSPdx", true],
    ["RSPdx R2", true],
    ["RSPdx-R2", true],
    ["RSPdx (2237073D48)", true],
    ["RSPdx R2 (ABCDEF123456)", true],
    ["Clone RSPdx", false],
    ["RSPdx Pro", false],
    ["RSPdx (TEST)", false],
    ["NotRSPdx", false],
  ])("uses the exact supported model contract for active_device %s", (value, accepted) => {
    expect(Boolean(parseSdrconnectDeviceModel(value))).toBe(accepted);
    const result = applySdrconnectTuneReadback(
      { centerConfirmed: true, sampleRateConfirmed: true, deviceConfirmed: false },
      { centerHz: 1_575_420_000, sampleRateHz: 10_000_000 },
      { event_type: "get_property_response", property: "active_device", value },
    );
    expect(result.state.deviceConfirmed).toBe(accepted);
  });

  it("derives only a bounded hexadecimal hardware serial from SDRconnect's active device label", () => {
    expect(parseSdrconnectDeviceSerial("RSPdx (2237073D48)")).toBe("2237073D48");
    expect(parseSdrconnectDeviceSerial("RSPdx R2 (ABCDEF123456)")).toBe("ABCDEF123456");
    expect(parseSdrconnectDeviceSerial("RSPdx (TEST)")).toBeUndefined();
    expect(parseSdrconnectDeviceSerial("Clone RSPdx (2237073D48)")).toBeUndefined();
  });

  it("handles JSON properties, keeps pre-tune spectrum gated, and disconnects cleanly", async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const messages: string[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (message) => messages.push(message.toString()));
      socket.send(JSON.stringify({ event_type: "property_changed", property: "api_version", value: "1.0.3" }));
      socket.send(JSON.stringify({ event_type: "property_changed", property: "valid_devices", value: "Refreshing..." }));
      setTimeout(() => socket.send(JSON.stringify({ event_type: "property_changed", property: "valid_devices", value: "RSPdx,IQ File" })), 5);
      socket.send(Buffer.from([3, 0, 11, 22, 33]));
    });
    const client = new SdrconnectClient({
      id: 0,
      url: `ws://127.0.0.1:${address.port}`,
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      deviceIndex: 0,
      tlsRejectUnauthorized: true,
    });
    closers.push(() => { client.close(); server.close(); httpServer.close(); });
    const propertyPromise = once(client, "property");
    await client.connect();
    const [property] = await propertyPromise;
    expect(property).toMatchObject({ property: "api_version", value: "1.0.3" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const commands = messages.map((message) => JSON.parse(message) as Record<string, unknown>);
    expect(commands.every((message) => (
      typeof message.event_type === "string" &&
      typeof message.property === "string" &&
      typeof message.value === "string"
    ))).toBe(true);
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "selected_device", property: "", value: "0" }));
    expect(commands.filter((message) => message.event_type === "selected_device")).toHaveLength(1);
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "device_stream_enable", property: "", value: "true" }));
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "spectrum_enable", property: "", value: "true" }));
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "get_property", property: "active_device", value: "" }));
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "get_property", property: "device_serial", value: "" }));
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "get_property", property: "active_antenna", value: "" }));
    expect(commands).toContainEqual(expect.objectContaining({ event_type: "get_property", property: "spectrum_ref_level", value: "" }));
    expect(commands).not.toContainEqual(expect.objectContaining({ event_type: "get_property", property: "gain_reduction" }));
    expect(commands).not.toContainEqual(expect.objectContaining({ event_type: "get_property", property: "if_gain" }));
    expect(client.connectionState).toBe("api-ready");
    expect(client.stats).toMatchObject({ spectrumFramesReceived: 1, spectrumFramesEmitted: 0 });
    client.close();
  });
  it("[trace:HW-003] waits for the API handshake and confirmed tuning before emitting settled spectrum", async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const tuneStates: string[] = [];
    const commands: Array<{ event_type: string; property: string; value: string }> = [];
    let centerConfirmed = false;
    let rateConfirmed = false;
    let framesSent = false;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { event_type: string; property: string; value: string };
        commands.push(message);
        if (message.event_type === "get_property" && message.property === "api_version") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "api_version", value: "1.0.3" }));
        }
        if (message.event_type === "get_property" && message.property === "valid_devices") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "valid_devices", value: "RSPdx,IQ File" }));
        }
        if (message.event_type === "get_property" && message.property === "active_device") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "active_device", value: "RSPdx" }));
        }
        if (message.event_type === "get_property" && message.property === "started") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "started", value: "true" }));
        }
        if (message.event_type === "get_property" && message.property === "can_control") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "can_control", value: "true" }));
        }
        if (message.event_type === "set_property" && message.property === "device_center_frequency") {
          centerConfirmed = true;
          socket.send(JSON.stringify({ event_type: "property_changed", property: message.property, value: message.value }));
        }
        if (message.event_type === "get_property" && message.property === "device_sample_rate") {
          rateConfirmed = true;
          socket.send(JSON.stringify({ event_type: "get_property_response", property: message.property, value: "10000000" }));
        }
        if (centerConfirmed && rateConfirmed && !framesSent) {
          framesSent = true;
          setTimeout(() => {
            socket.send(Buffer.from([3, 0, 1]));
            socket.send(Buffer.from([3, 0, 2]));
            socket.send(Buffer.from([3, 0, 99]));
          }, 5);
        }
      });
    });
    const client = new SdrconnectClient({
      id: 0,
      url: `ws://127.0.0.1:${address.port}`,
      timeoutMs: 500,
      sampleRateHz: 10_000_000,
      deviceIndex: 0,
      tlsRejectUnauthorized: true,
      settlingFrames: 2,
      deviceReadySettleMs: 1,
    });
    client.on("tune-state", (state) => tuneStates.push(String(state)));
    closers.push(() => { client.close(); server.close(); httpServer.close(); });
    await client.connect();
    expect(client.connectionState).toBe("api-ready");
    const confirmed = once(client, "tune-confirmed");
    const spectrum = once(client, "spectrum");
    client.tune({ id: "test", label: "Test", service: "gnss", startHz: 1, endHz: 2, centerHz: 1_575_420_000, priority: 1, dwellMs: 1_000, editable: true, settleMs: 1 });
    await confirmed;
    const [payload] = await spectrum;
    expect(Array.from((payload as { bins: Uint8Array }).bins)).toEqual([99]);
    expect(payload).toMatchObject({ tuneEpoch: 1, confirmedCenterHz: 1_575_420_000, confirmedSampleRateHz: 10_000_000, discardedFrames: 2 });
    expect(client.stats).toMatchObject({ tuneFramesDiscarded: 2, invalidSpectrumFramesDropped: 0 });
    expect(commands).not.toContainEqual({ event_type: "set_property", property: "device_sample_rate", value: "10000000" });
    expect(tuneStates).toContain("settling");
    expect(tuneStates.at(-1)).toBe("confirmed");
  });

  it("[trace:HW-006] requests the commissioned sample rate only while tuning and rejects or drops IQ", async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const messages: Array<{ event_type: string; property: string; value: string }> = [];
    let startupReady = false;
    let prematureRateRequest = false;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { event_type: string; property: string; value: string };
        messages.push(message);
        if (message.event_type === "set_property" && message.property === "device_sample_rate" && !startupReady) prematureRateRequest = true;
        if (message.event_type === "get_property" && message.property === "api_version") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "api_version", value: "1.0.3" }));
        }
        if (message.event_type === "get_property" && message.property === "valid_devices") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "valid_devices", value: "RSPdx" }));
        }
        if (message.event_type === "get_property" && message.property === "active_device") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "active_device", value: "RSPdx" }));
        }
        if (message.event_type === "get_property" && message.property === "started") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "started", value: "true" }));
        }
        if (message.event_type === "get_property" && message.property === "can_control") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "can_control", value: "true" }));
          startupReady = true;
        }
        if (message.event_type === "get_property" && message.property === "device_sample_rate") {
          socket.send(JSON.stringify({ event_type: "get_property_response", property: "device_sample_rate", value: "2000000" }));
        }
      });
      setTimeout(() => socket.send(Buffer.from([2, 0, 1, 2, 3])), 10);
    });
    const client = new SdrconnectClient({
      id: 0,
      url: `ws://127.0.0.1:${address.port}`,
      timeoutMs: 500,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
      deviceReadySettleMs: 1,
    });
    closers.push(() => { client.close(); server.close(); httpServer.close(); });
    await client.connect();
    expect(() => client.setIqStreaming(true)).toThrow(/disabled/);
    client.tune({ id: "test", label: "Test", service: "gnss", startHz: 1, endHz: 2, centerHz: 1_575_420_000, priority: 1, dwellMs: 1_000, editable: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toContainEqual(expect.objectContaining({
      event_type: "set_property",
      property: "device_sample_rate",
      value: "10000000",
    }));
    expect(messages.filter((message) => message.event_type === "set_property" && message.property === "device_sample_rate")).toHaveLength(1);
    expect(prematureRateRequest).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({ event_type: "iq_stream_enable", value: "false" }));
    expect(client.stats.unexpectedIqPayloadsDropped).toBe(1);
  });

  it.each([
    ["device_center_frequency", "1227600000"],
    ["device_sample_rate", "9000000"],
    ["active_device", "IQ File"],
    ["active_device", "RSP1A (substituted)"],
  ])("closes the confirmed frame gate when %s drifts", async (property, value) => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
    });
    const internal = client as unknown as {
      frameGateOpen: boolean;
      currentPhysicalDevice: string;
      currentTune: { tuneEpoch: number; confirmedCenterHz: number; confirmedSampleRateHz: number; tuneConfirmedAt: string };
      confirmTune(message: { event_type: string; property: string; value: string }): void;
      handleSpectrum(payload: Uint8Array): void;
    };
    internal.frameGateOpen = true;
    internal.currentPhysicalDevice = "RSPdx";
    internal.currentTune = {
      tuneEpoch: 7,
      confirmedCenterHz: 1_575_420_000,
      confirmedSampleRateHz: 10_000_000,
      tuneConfirmedAt: new Date(0).toISOString(),
    };
    const failures: unknown[] = [];
    const frames: unknown[] = [];
    client.on("tune-failed", (failure) => failures.push(failure));
    client.on("spectrum", (payload) => frames.push(payload));
    internal.confirmTune({ event_type: "property_changed", property, value });
    internal.handleSpectrum(Uint8Array.of(1, 2, 3));
    expect(internal.frameGateOpen).toBe(false);
    expect(failures).toEqual([{ tuneEpoch: 7, reason: "tune-mismatch" }]);
    expect(frames).toHaveLength(0);
  });

  it("does not leave a pending confirmation true after a stale sample-rate reply", () => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
    });
    const internal = client as unknown as {
      pendingTune: { centerHz: number; sampleRateHz: number; centerConfirmed: boolean; sampleRateConfirmed: boolean; deviceConfirmed: boolean };
      confirmTune(message: { event_type: string; property: string; value: string }): void;
    };
    internal.pendingTune = {
      centerHz: 1_575_420_000,
      sampleRateHz: 10_000_000,
      centerConfirmed: false,
      sampleRateConfirmed: false,
      deviceConfirmed: false,
    };
    internal.confirmTune({ event_type: "get_property_response", property: "device_sample_rate", value: "10000000" });
    expect(internal.pendingTune.sampleRateConfirmed).toBe(true);
    internal.confirmTune({ event_type: "get_property_response", property: "device_sample_rate", value: "2000000" });
    expect(internal.pendingTune.sampleRateConfirmed).toBe(false);
  });

  it("supersedes an unfinished tune with the newest scheduler epoch", () => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
      deviceReadySettleMs: 0,
    });
    const internal = client as unknown as {
      physicalDeviceAvailable: boolean;
      deviceReadySinceMonotonicMs: number;
      pendingTune?: { tuneEpoch: number; centerHz: number };
    };
    internal.physicalDeviceAvailable = true;
    internal.deviceReadySinceMonotonicMs = performance.now();
    client.tune({ id: "first", label: "First", service: "gnss", startHz: 1, endHz: 2, centerHz: 1_575_420_000, priority: 1, dwellMs: 1_000, editable: true });
    expect(internal.pendingTune).toMatchObject({ tuneEpoch: 1, centerHz: 1_575_420_000 });
    client.tune({ id: "second", label: "Second", service: "gnss", startHz: 1, endHz: 2, centerHz: 1_227_600_000, priority: 1, dwellMs: 1_000, editable: true });
    expect(internal.pendingTune).toMatchObject({ tuneEpoch: 2, centerHz: 1_227_600_000 });
    client.close();
  });

  it("does not restart a confirmed tune epoch on routine readiness properties", () => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
      deviceReadySettleMs: 0,
    });
    const internal = client as unknown as {
      physicalDeviceAvailable: boolean;
      reportedPhysicalDevice: boolean;
      deviceStarted: boolean;
      canControlDevice: boolean;
      confirmedSampleRateHz: number;
      deviceReadySinceMonotonicMs: number;
      pendingTune?: { tuneEpoch: number };
      currentTune?: { tuneEpoch: number; confirmedCenterHz: number; confirmedSampleRateHz: number; tuneConfirmedAt: string; discardedFrames: number };
      clearPendingTune(): void;
      confirmTune(message: { event_type: string; property: string; value: string }): void;
    };
    internal.physicalDeviceAvailable = true;
    internal.reportedPhysicalDevice = true;
    internal.deviceStarted = true;
    internal.canControlDevice = true;
    internal.confirmedSampleRateHz = 10_000_000;
    internal.deviceReadySinceMonotonicMs = performance.now();
    client.tune({ id: "test", label: "Test", service: "gnss", startHz: 1, endHz: 2, centerHz: 1_575_420_000, priority: 1, dwellMs: 1_000, editable: true });
    internal.clearPendingTune();
    internal.currentTune = {
      tuneEpoch: 1,
      confirmedCenterHz: 1_575_420_000,
      confirmedSampleRateHz: 10_000_000,
      tuneConfirmedAt: new Date(0).toISOString(),
      discardedFrames: 2,
    };

    internal.confirmTune({ event_type: "get_property_response", property: "started", value: "true" });

    expect(internal.pendingTune).toBeUndefined();
    expect(internal.currentTune).toMatchObject({ tuneEpoch: 1 });
    client.close();
  });

  it("rejects a socket that never answers the SDRconnect API handshake", async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const client = new SdrconnectClient({
      id: 0,
      url: `ws://127.0.0.1:${address.port}`,
      timeoutMs: 50,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
    });
    closers.push(() => { client.close(); server.close(); httpServer.close(); });
    await expect(client.connect()).rejects.toThrow("API handshake timed out");
  });

  it("drops obsolete FFT frames before monitor processing", () => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
      maxSpectrumRateHz: 2,
    });
    const internal = client as unknown as {
      frameGateOpen: boolean;
      currentTune: { tuneEpoch: number; confirmedCenterHz: number; confirmedSampleRateHz: number; tuneConfirmedAt: string };
      handleSpectrum(payload: Uint8Array): void;
    };
    internal.frameGateOpen = true;
    internal.currentTune = { tuneEpoch: 1, confirmedCenterHz: 1, confirmedSampleRateHz: 10_000_000, tuneConfirmedAt: new Date(0).toISOString() };
    const emitted: number[][] = [];
    client.on("spectrum", (payload: { bins: Uint8Array }) => emitted.push(Array.from(payload.bins)));
    const handleSpectrum = internal.handleSpectrum.bind(client);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValueOnce(1_600);
    handleSpectrum(Uint8Array.from([1]));
    handleSpectrum(Uint8Array.from([2]));
    handleSpectrum(Uint8Array.from([3]));
    now.mockRestore();
    expect(emitted).toEqual([[1], [3]]);
    expect(client.stats).toMatchObject({ spectrumFramesReceived: 3, spectrumFramesEmitted: 2, spectrumFramesDropped: 1, rateCoalescedFrames: 1, invalidSpectrumFramesDropped: 0 });
  });

  it("drops oversized native FFT payloads before detector allocation", () => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
    });
    const internal = client as unknown as {
      frameGateOpen: boolean;
      currentTune: { tuneEpoch: number; confirmedCenterHz: number; confirmedSampleRateHz: number; tuneConfirmedAt: string };
      handleSpectrum(payload: Uint8Array): void;
    };
    internal.frameGateOpen = true;
    internal.currentTune = { tuneEpoch: 1, confirmedCenterHz: 1, confirmedSampleRateHz: 10_000_000, tuneConfirmedAt: new Date(0).toISOString() };
    internal.handleSpectrum(new Uint8Array(8_193));
    expect(client.stats).toMatchObject({ spectrumFramesReceived: 1, spectrumFramesEmitted: 0, spectrumFramesDropped: 1, invalidSpectrumFramesDropped: 1, rateCoalescedFrames: 0 });
  });

  it("resets settle and discard progress when any required RF readback drifts", () => {
    const client = new SdrconnectClient({
      id: 0,
      url: "ws://127.0.0.1:5454/",
      timeoutMs: 1_000,
      sampleRateHz: 10_000_000,
      tlsRejectUnauthorized: true,
    });
    const internal = client as unknown as {
      pendingTune: {
        configurationEpoch: number;
        tuneEpoch: number;
        visitEpoch: number;
        visitId: string;
        targetId: string;
        centerHz: number;
        sampleRateHz: number;
        centerConfirmed: boolean;
        sampleRateConfirmed: boolean;
        deviceConfirmed: boolean;
        deviceValue?: string;
        discardRequired: number;
        discardRemaining: number;
        discardedFrames: number;
        settleMs: number;
        propertiesConfirmedAtMonotonicMs?: number;
        confirmedAt?: string;
      };
      confirmTune(message: SdrconnectPropertyMessage): void;
    };
    internal.pendingTune = {
      configurationEpoch: 4,
      tuneEpoch: 9,
      visitEpoch: 12,
      visitId: "visit-12",
      targetId: "gnss-l1-e1-b1c-sbas",
      centerHz: 1_575_420_000,
      sampleRateHz: 10_000_000,
      centerConfirmed: true,
      sampleRateConfirmed: true,
      deviceConfirmed: true,
      deviceValue: "RSPdx",
      discardRequired: 2,
      discardRemaining: 0,
      discardedFrames: 2,
      settleMs: 250,
      propertiesConfirmedAtMonotonicMs: 100,
      confirmedAt: "2026-08-23T12:00:00.000Z",
    };

    internal.confirmTune({ event_type: "property_changed", property: "device_center_frequency", value: "1227600000" });

    expect(internal.pendingTune).toMatchObject({
      centerConfirmed: false,
      sampleRateConfirmed: true,
      deviceConfirmed: true,
      discardRemaining: 2,
      discardedFrames: 0,
      propertiesConfirmedAtMonotonicMs: undefined,
      confirmedAt: undefined,
    });
  });

  it("[trace:RF-100] [trace:SLO-007] proves 100,000 deterministic adversarial readback/frame cases never accept an old RF epoch", () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const shuffle = <T,>(items: T[]): T[] => {
      for (let index = items.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [items[index], items[other]] = [items[other], items[index]];
      }
      return items;
    };
    let acceptedCurrent = 0;
    let acceptedOld = 0;
    let completeReadbacks = 0;
    let incompleteReadbacks = 0;
    const rejectionReasons = new Set<string>();

    for (let index = 0; index < 100_000; index += 1) {
      const centerHz = index % 4 === 0 ? 1_575_420_000 : index % 4 === 1 ? 1_227_600_000 : index % 4 === 2 ? 1_176_450_000 : 1_601_719_000;
      const expected: ExpectedSdrconnectFrameEpoch = {
        configurationEpoch: 20 + Math.floor(index / 10_000),
        tuneEpoch: index + 1,
        visitEpoch: index + 10_001,
        visitId: `visit-${index + 10_001}`,
        targetId: `target-${index % 4}`,
        requestedCenterHz: centerHz,
        sampleRateHz: 10_000_000,
      };
      const canonical: SdrconnectPropertyMessage[] = [
        { event_type: "get_property_response", property: "device_center_frequency", value: String(centerHz) },
        { event_type: "get_property_response", property: "device_sample_rate", value: "10000000" },
        { event_type: "get_property_response", property: "active_device", value: "RSPdx" },
      ];
      const stale: SdrconnectPropertyMessage[] = [
        { event_type: "property_changed", property: "device_center_frequency", value: String(centerHz + 25_000_000) },
        { event_type: "get_property_response", property: "device_sample_rate", value: "9000000" },
        { event_type: "get_property_response", property: "active_device", value: "IQ File" },
      ];
      const responses = shuffle([
        ...canonical,
        canonical[index % canonical.length], // duplicate response
        stale[index % stale.length], // delayed stale or mismatched response
      ]);
      let readback = { centerConfirmed: false, sampleRateConfirmed: false, deviceConfirmed: false };
      for (const response of responses) {
        readback = applySdrconnectTuneReadback(readback, { centerHz: expected.requestedCenterHz, sampleRateHz: expected.sampleRateHz }, response).state;
      }
      const readbackComplete = readback.centerConfirmed && readback.sampleRateConfirmed && readback.deviceConfirmed;
      if (readbackComplete) completeReadbacks += 1;
      else incompleteReadbacks += 1;

      const confirmedAtMonotonicMs = index + 1_000;
      const frame = {
        configurationEpoch: expected.configurationEpoch,
        tuneEpoch: expected.tuneEpoch,
        visitEpoch: expected.visitEpoch,
        visitId: expected.visitId,
        targetId: expected.targetId,
        requestedCenterHz: expected.requestedCenterHz,
        confirmedCenterHz: expected.requestedCenterHz,
        confirmedSampleRateHz: expected.sampleRateHz,
        tuneConfirmedAt: "2026-08-23T12:00:00.000Z",
        tuneConfirmedMonotonicMs: confirmedAtMonotonicMs,
        receivedMonotonicMs: confirmedAtMonotonicMs + 250,
      };
      const variant = index % 11;
      const candidate = { ...frame };
      if (variant === 1) candidate.configurationEpoch -= 1;
      if (variant === 2) candidate.tuneEpoch -= 1;
      if (variant === 3) candidate.visitEpoch -= 1;
      if (variant === 4) candidate.visitId = `stale-${candidate.visitId}`;
      if (variant === 5) candidate.targetId = `stale-${candidate.targetId}`;
      if (variant === 6) candidate.requestedCenterHz += 1;
      if (variant === 7) candidate.confirmedCenterHz += 1;
      if (variant === 8) candidate.confirmedSampleRateHz = 9_000_000;
      if (variant === 9) candidate.receivedMonotonicMs = candidate.tuneConfirmedMonotonicMs - 1;
      if (variant === 10) candidate.tuneConfirmedAt = "not-a-time";

      const validation = validateSdrconnectFrameEpoch(expected, candidate);
      if (!validation.accepted) rejectionReasons.add(validation.reason);
      // In production no payload exists until all readbacks are current and the
      // settle/discard gate completes. The exact duplicate-current case is safe;
      // every stale or mismatched epoch must remain rejected.
      const emitted = readbackComplete && validation.accepted;
      if (emitted && variant === 0) acceptedCurrent += 1;
      if (emitted && variant !== 0) acceptedOld += 1;
    }

    expect(completeReadbacks).toBeGreaterThan(0);
    expect(incompleteReadbacks).toBeGreaterThan(0);
    expect(acceptedCurrent).toBeGreaterThan(0);
    expect(acceptedOld).toBe(0);
    expect(rejectionReasons).toEqual(new Set([
      "configuration-epoch",
      "tune-epoch",
      "visit-epoch",
      "visit-id",
      "target-id",
      "requested-center",
      "confirmed-center",
      "sample-rate",
      "confirmation-time",
    ]));
  });
});
