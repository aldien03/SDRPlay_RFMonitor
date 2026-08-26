import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { parseReportedReceiverModel, parseSupportedReceiverModel } from "../shared/productContract";
import type { BandPreset, ConnectionState, TuneState } from "../shared/types";

export interface SdrconnectPropertyMessage {
  event_type: string;
  property?: string;
  value?: unknown;
  device?: string;
}

export interface SdrconnectClientOptions {
  id: number;
  url: string;
  timeoutMs: number;
  sampleRateHz: number;
  deviceIndex?: number;
  tlsRejectUnauthorized: boolean;
  settlingFrames?: number;
  settleMs?: number;
  maxSpectrumRateHz?: number;
  maxNativeSpectrumBins?: number;
  deviceReadySettleMs?: number;
}

export interface ParsedBinaryPayload {
  type: number;
  payload: Uint8Array;
}

export interface SdrconnectProcessingStats {
  spectrumFramesReceived: number;
  spectrumFramesEmitted: number;
  spectrumFramesDropped: number;
  tuneGateFramesIgnored: number;
  tuneFramesDiscarded: number;
  rateCoalescedFrames: number;
  invalidSpectrumFramesDropped: number;
  unexpectedIqPayloadsDropped: number;
}

export interface SdrconnectSpectrumPayload {
  bins: Uint8Array;
  configurationEpoch: number;
  tuneEpoch: number;
  visitEpoch: number;
  visitId: string;
  targetId: string;
  requestedCenterHz: number;
  confirmedCenterHz: number;
  confirmedSampleRateHz: number;
  tuneConfirmedAt: string;
  tuneConfirmedMonotonicMs: number;
  receivedMonotonicMs: number;
  discardedFrames: number;
}

/**
 * Immutable scheduler identity attached before a tune command is issued.
 * SDRconnect's binary FFT payload is not self-describing, so MonitorService
 * must accept it only while this exact configuration/visit remains active.
 */
export interface SdrconnectTuneContext {
  configurationEpoch: number;
  visitEpoch: number;
  visitId: string;
  targetId: string;
}

export interface ExpectedSdrconnectFrameEpoch extends SdrconnectTuneContext {
  tuneEpoch: number;
  requestedCenterHz: number;
  sampleRateHz: number;
}

export type SdrconnectFrameEpochRejection =
  | "invalid-epoch"
  | "configuration-epoch"
  | "tune-epoch"
  | "visit-epoch"
  | "visit-id"
  | "target-id"
  | "requested-center"
  | "confirmed-center"
  | "sample-rate"
  | "confirmation-time";

export type SdrconnectFrameEpochValidation =
  | { accepted: true }
  | { accepted: false; reason: SdrconnectFrameEpochRejection };

/** Pure, fail-closed frame gate shared by the transport and monitor tests. */
export function validateSdrconnectFrameEpoch(
  expected: ExpectedSdrconnectFrameEpoch,
  frame: Omit<SdrconnectSpectrumPayload, "bins" | "discardedFrames">,
): SdrconnectFrameEpochValidation {
  const positiveEpochs = [
    expected.configurationEpoch,
    expected.tuneEpoch,
    expected.visitEpoch,
    frame.configurationEpoch,
    frame.tuneEpoch,
    frame.visitEpoch,
  ];
  if (positiveEpochs.some((value) => !Number.isSafeInteger(value) || value <= 0)) return { accepted: false, reason: "invalid-epoch" };
  if (frame.configurationEpoch !== expected.configurationEpoch) return { accepted: false, reason: "configuration-epoch" };
  if (frame.tuneEpoch !== expected.tuneEpoch) return { accepted: false, reason: "tune-epoch" };
  if (frame.visitEpoch !== expected.visitEpoch) return { accepted: false, reason: "visit-epoch" };
  if (frame.visitId !== expected.visitId) return { accepted: false, reason: "visit-id" };
  if (frame.targetId !== expected.targetId) return { accepted: false, reason: "target-id" };
  if (frame.requestedCenterHz !== expected.requestedCenterHz) return { accepted: false, reason: "requested-center" };
  if (frame.confirmedCenterHz !== expected.requestedCenterHz) return { accepted: false, reason: "confirmed-center" };
  if (frame.confirmedSampleRateHz !== expected.sampleRateHz) return { accepted: false, reason: "sample-rate" };
  if (
    !Number.isFinite(Date.parse(frame.tuneConfirmedAt))
    || !Number.isFinite(frame.tuneConfirmedMonotonicMs)
    || !Number.isFinite(frame.receivedMonotonicMs)
    || frame.tuneConfirmedMonotonicMs < 0
    || frame.receivedMonotonicMs < frame.tuneConfirmedMonotonicMs
  ) return { accepted: false, reason: "confirmation-time" };
  return { accepted: true };
}

export interface SdrconnectTuneReadbackState {
  centerConfirmed: boolean;
  sampleRateConfirmed: boolean;
  deviceConfirmed: boolean;
  deviceValue?: string;
}

/**
 * SDRconnect reports a selected receiver either as the canonical model or as
 * `MODEL (SERIAL)`. Keep the product model parser strict, but accept the
 * vendor's bounded hexadecimal serial suffix at this transport boundary.
 */
export function parseSdrconnectDeviceModel(value: unknown): ReturnType<typeof parseSupportedReceiverModel> {
  return parseReportedReceiverModel(value);
}

export function parseSdrconnectDeviceSerial(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:rspdx(?: |-)r2|rspdx) \(([a-f0-9]{8,32})\)$/iu.exec(value.trim())?.[1];
}

export function applySdrconnectTuneReadback(
  current: SdrconnectTuneReadbackState,
  expected: { centerHz: number; sampleRateHz: number },
  message: SdrconnectPropertyMessage,
): { state: SdrconnectTuneReadbackState; requiredPropertyObserved: boolean } {
  const state = { ...current };
  const numericValue = Number(message.value);
  if (message.property === "device_center_frequency") {
    state.centerConfirmed = Number.isFinite(numericValue) && numericValue === expected.centerHz;
    return { state, requiredPropertyObserved: true };
  }
  if (message.property === "device_sample_rate") {
    state.sampleRateConfirmed = Number.isFinite(numericValue) && numericValue === expected.sampleRateHz;
    return { state, requiredPropertyObserved: true };
  }
  if (message.property === "active_device") {
    const deviceValue = parseSdrconnectDeviceModel(message.value);
    state.deviceConfirmed = Boolean(deviceValue);
    state.deviceValue = deviceValue;
    return { state, requiredPropertyObserved: true };
  }
  return { state, requiredPropertyObserved: false };
}

interface PendingTune {
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
  timer?: NodeJS.Timeout;
}

export const MAX_NATIVE_SPECTRUM_BINS = 8_192;
const DEFAULT_DEVICE_READY_SETTLE_MS = 500;

function isExpectedPhysicalDevice(value: unknown): boolean {
  return Boolean(parseSdrconnectDeviceModel(value));
}

export function parseBinaryPayload(data: RawData | ArrayBuffer): ParsedBinaryPayload | undefined {
  const buffer = data instanceof ArrayBuffer
    ? Buffer.from(data)
    : Array.isArray(data)
      ? data.length === 1 ? data[0] : Buffer.concat(data)
      : data;
  if (buffer.byteLength < 3) return undefined;
  const payloadType = buffer.readUInt16LE(0);
  if (![1, 2, 3, 4, 5, 6].includes(payloadType)) return undefined;
  return {
    type: payloadType,
    payload: new Uint8Array(buffer.buffer, buffer.byteOffset + 2, buffer.byteLength - 2),
  };
}

export function parseSpectrumPayload(data: RawData | ArrayBuffer): Uint8Array | undefined {
  const parsed = parseBinaryPayload(data);
  return parsed && (parsed.type === 3 || parsed.type === 6) ? parsed.payload : undefined;
}

export class SdrconnectClient extends EventEmitter {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pendingTune?: PendingTune;
  private shouldReconnect = true;
  private state: ConnectionState = "offline";
  private apiReady = false;
  private physicalDeviceAvailable = false;
  private healthTimer?: NodeJS.Timeout;
  private openedAt = 0;
  private lastMessageAt = 0;
  private lastSpectrumAt = 0;
  private lastSpectrumEmittedAt = 0;
  private lastProbeAt = 0;
  private stallNotified = false;
  private reconnectAttempts = 0;
  private confirmedCenterHz?: number;
  private confirmedSampleRateHz?: number;
  private requestedTune?: { band: BandPreset; centerHz: number; tuneEpoch: number; context: Readonly<SdrconnectTuneContext> };
  private tuneEpoch = 0;
  private frameGateOpen = false;
  private currentTune?: Omit<SdrconnectSpectrumPayload, "bins" | "receivedMonotonicMs">;
  private currentPhysicalDevice?: string;
  private reportedPhysicalDevice = false;
  private deviceStarted = false;
  private canControlDevice = false;
  private deviceReadySinceMonotonicMs?: number;
  private deviceReadyTimer?: NodeJS.Timeout;
  private readonly processingStats: SdrconnectProcessingStats = {
    spectrumFramesReceived: 0,
    spectrumFramesEmitted: 0,
    spectrumFramesDropped: 0,
    tuneGateFramesIgnored: 0,
    tuneFramesDiscarded: 0,
    rateCoalescedFrames: 0,
    invalidSpectrumFramesDropped: 0,
    unexpectedIqPayloadsDropped: 0,
  };

  constructor(readonly options: SdrconnectClientOptions) {
    super();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get stats(): SdrconnectProcessingStats {
    return { ...this.processingStats };
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    if (this.apiReady && this.socket?.readyState === WebSocket.OPEN) return;
    this.setState("connecting");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error(`SDRconnect WebSocket opened but the API handshake timed out: ${this.options.url}`));
      }, this.options.timeoutMs);
      const socket = new WebSocket(this.options.url, {
        rejectUnauthorized: this.options.tlsRejectUnauthorized,
        perMessageDeflate: false,
        maxPayload: 64 * 1024,
      });
      this.socket = socket;

      socket.on("open", () => {
        this.openedAt = Date.now();
        this.lastMessageAt = this.openedAt;
        this.setState("socket-open");
        this.startHealthWatch();
        this.requestInitialProperties();
      });
      socket.on("message", (data, isBinary) => {
        this.lastMessageAt = Date.now();
        if (isBinary) {
          if (!this.apiReady) return;
          const parsed = parseBinaryPayload(data);
          if (!parsed) return;
          if (parsed.type === 3 || parsed.type === 6) this.handleSpectrum(parsed.payload);
          if (parsed.type === 2 || parsed.type === 5) this.processingStats.unexpectedIqPayloadsDropped += 1;
          return;
        }
        const message = this.parseText(data.toString());
        if (message?.property === "api_version" && String(message.value ?? "").trim()) {
          this.apiReady = true;
          this.setState("api-ready");
          if (!settled) {
            clearTimeout(timeout);
            settled = true;
            resolve();
          }
        }
        if (message) {
          this.retrySelectionAfterDiscovery(message);
          this.confirmTune(message);
        }
      });
      socket.on("error", (error) => {
        this.emit("client-error", error);
        if (!settled) {
          clearTimeout(timeout);
          settled = true;
          reject(error);
        }
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        if (this.socket !== socket) return;
        this.apiReady = false;
        this.physicalDeviceAvailable = false;
        this.confirmedCenterHz = undefined;
        this.confirmedSampleRateHz = undefined;
        this.frameGateOpen = false;
        this.currentTune = undefined;
        this.currentPhysicalDevice = undefined;
        this.resetDeviceReadiness();
        this.clearPendingTune();
        this.setState("offline");
        if (this.shouldReconnect) {
          this.reconnectAttempts += 1;
          this.emit("reconnect-attempt", this.reconnectAttempts);
          this.scheduleReconnect();
        }
      });
    });
  }

  tune(band: BandPreset, centerHz = band.centerHz, context?: SdrconnectTuneContext): number {
    const tuneEpoch = ++this.tuneEpoch;
    const immutableContext = Object.freeze(context ? { ...context } : {
      // Legacy callers are deliberately given an invalid configuration epoch.
      // MonitorService always supplies an explicit positive context and rejects
      // these compatibility identities at its frame boundary.
      configurationEpoch: 0,
      visitEpoch: tuneEpoch,
      visitId: `legacy-tune-${tuneEpoch}`,
      targetId: band.captureTargetId ?? band.id,
    });
    this.requestedTune = Object.freeze({ band, centerHz, tuneEpoch, context: immutableContext });
    this.frameGateOpen = false;
    this.currentTune = undefined;
    // A scheduler visit can expire before SDRconnect finishes the previous
    // command. Supersede that pending epoch immediately so late confirmations
    // can never keep emitting frames for a visit the scheduler has replaced.
    this.clearPendingTune();
    if (!this.physicalDeviceAvailable) {
      this.emit("tune-state", "commanded" satisfies TuneState);
      return tuneEpoch;
    }
    this.maybeStartRequestedTune();
    return tuneEpoch;
  }

  private startPendingTune(requested: { band: BandPreset; centerHz: number; tuneEpoch: number; context: Readonly<SdrconnectTuneContext> }): void {
    const { band, centerHz, tuneEpoch, context } = requested;
    this.clearPendingTune();
    const discardRequired = band.discardFrames ?? this.options.settlingFrames ?? 2;
    const pending: PendingTune = {
      ...context,
      tuneEpoch,
      centerHz,
      sampleRateHz: this.options.sampleRateHz,
      centerConfirmed: false,
      sampleRateConfirmed: false,
      deviceConfirmed: false,
      discardRequired,
      discardRemaining: discardRequired,
      discardedFrames: 0,
      settleMs: band.settleMs ?? this.options.settleMs ?? 250,
      timer: setTimeout(() => {
        if (this.pendingTune !== pending) return;
        this.pendingTune = undefined;
        this.frameGateOpen = false;
        this.emit("tune-state", "timed-out" satisfies TuneState);
        this.emit("tune-failed", { tuneEpoch: pending.tuneEpoch, reason: "tune-timeout" as const });
        this.setState("stale");
        this.emit("client-error", new Error(`SDRconnect did not confirm tuning to ${centerHz} Hz`));
      }, band.tuneAckTimeoutMs ?? this.options.timeoutMs),
    };
    pending.timer?.unref();
    this.pendingTune = pending;
    this.lastSpectrumEmittedAt = 0;
    this.emit("tune-state", "commanded" satisfies TuneState);
    this.send({ event_type: "set_property", property: "device_center_frequency", value: String(centerHz) });
    this.send({ event_type: "set_property", property: "device_vfo_frequency", value: String(centerHz) });
    // SDRconnect WebSocket API 1.0.3 exposes device_sample_rate as writable.
    // Fresh headless instances start at 2 MS/s, so request the commissioned
    // rate when needed and keep the frame gate closed until it is read back.
    if (this.confirmedSampleRateHz !== pending.sampleRateHz) {
      this.send({ event_type: "set_property", property: "device_sample_rate", value: String(pending.sampleRateHz) });
    }
    this.send({ event_type: "get_property", property: "active_device" });
    this.send({ event_type: "get_property", property: "device_center_frequency" });
    this.send({ event_type: "get_property", property: "device_sample_rate" });
    this.send({ event_type: "spectrum_enable", value: "true" });
  }

  setIqStreaming(enabled: boolean): void {
    if (enabled) throw new Error("IQ streaming is disabled in spectrum-only RF Monitor v1");
    this.send({ event_type: "iq_stream_enable", value: "false" });
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearPendingTune();
    this.requestedTune = undefined;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.resetDeviceReadiness();
    this.socket?.close();
  }

  forceReconnect(): void {
    this.socket?.terminate();
  }

  probe(): void {
    this.requestInitialProperties();
    this.send({ event_type: "spectrum_enable", value: "true" });
  }

  private parseText(text: string): SdrconnectPropertyMessage | undefined {
    try {
      const message = JSON.parse(text) as SdrconnectPropertyMessage;
      this.emit("property", message);
      return message;
    } catch {
      this.emit("client-error", new Error("SDRconnect sent invalid JSON"));
      return undefined;
    }
  }

  private retrySelectionAfterDiscovery(message: SdrconnectPropertyMessage): void {
    if (message.property !== "valid_devices") return;
    const devices = String(message.value ?? "")
      .split(",")
      .map((device) => device.trim())
      .filter(Boolean);
    const physicalAvailable = devices.some(isExpectedPhysicalDevice);
    if (!physicalAvailable) {
      if (!String(message.value ?? "").toLowerCase().includes("refreshing")) {
        this.physicalDeviceAvailable = false;
        this.resetDeviceReadiness();
        this.invalidateConfirmedTune("SDRconnect no longer reports a physical receiver");
        this.emit("hardware", "absent");
      }
      return;
    }
    this.emit("hardware", "present");
    if (this.physicalDeviceAvailable) return;
    this.physicalDeviceAvailable = true;
    this.resetDeviceReadiness();
    this.confirmedSampleRateHz = undefined;
    this.selectDeviceAndEnableStream();
    // Device-scoped properties queried before selection may describe IQ File or
    // an old receiver. Refresh the complete immutable-baseline fingerprint only
    // after SDRconnect confirms that a physical device is available.
    for (const property of [
      "api_version",
      "active_device",
      "device_serial",
      "device_center_frequency",
      "device_sample_rate",
      "started",
      "can_control",
      "active_antenna",
      "lna_state",
      "spectrum_ref_level",
      "spectrum_base",
      "signal_power",
      "signal_snr",
      "overload",
    ]) {
      this.send({ event_type: "get_property", property });
    }
  }

  private selectDeviceAndEnableStream(): void {
    if (this.options.deviceIndex !== undefined) {
      this.send({ event_type: "selected_device", value: String(this.options.deviceIndex) });
    }
    this.send({ event_type: "device_stream_enable", value: "true" });
    this.send({ event_type: "spectrum_enable", value: "true" });
    this.send({ event_type: "iq_stream_enable", value: "false" });
  }

  private confirmTune(message: SdrconnectPropertyMessage): void {
    if (!message.property) return;
    const numericValue = Number(message.value);
    const deviceValue = message.property === "active_device"
      ? parseSdrconnectDeviceModel(message.value)
      : undefined;
    const physicalDevice = deviceValue !== undefined;
    if (message.property === "active_device") this.reportedPhysicalDevice = physicalDevice;
    if (message.property === "started") this.deviceStarted = /^(true|1)$/i.test(String(message.value ?? "").trim());
    if (message.property === "can_control") this.canControlDevice = /^(true|1)$/i.test(String(message.value ?? "").trim());
    if (!this.pendingTune && this.currentTune) {
      const centerChanged = message.property === "device_center_frequency"
        && Number.isFinite(numericValue)
        && numericValue !== this.currentTune.confirmedCenterHz;
      const sampleRateChanged = message.property === "device_sample_rate"
        && Number.isFinite(numericValue)
        && numericValue !== this.currentTune.confirmedSampleRateHz;
      const deviceChanged = message.property === "active_device"
        && (!physicalDevice || deviceValue !== this.currentPhysicalDevice);
      if (centerChanged || sampleRateChanged || deviceChanged) {
        this.invalidateConfirmedTune(`Confirmed RF state changed (${message.property})`);
      }
    }
    if (message.property === "device_center_frequency" && Number.isFinite(numericValue)) this.confirmedCenterHz = numericValue;
    if (message.property === "device_sample_rate" && Number.isFinite(numericValue)) this.confirmedSampleRateHz = numericValue;
    this.updateDeviceReadiness();
    const pending = this.pendingTune;
    if (!pending) return;
    const readback = applySdrconnectTuneReadback(pending, pending, message);
    Object.assign(pending, readback.state);
    const requiredReadback = readback.requiredPropertyObserved;
    if (pending.centerConfirmed && pending.sampleRateConfirmed && pending.deviceConfirmed) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = undefined;
      pending.propertiesConfirmedAtMonotonicMs ??= performance.now();
      pending.confirmedAt ??= new Date().toISOString();
      this.emit("tune-state", "settling" satisfies TuneState);
    } else {
      // A conflicting readback invalidates the whole confirmation transition.
      // If the property later returns to the requested value, settle time and
      // frame discards start again instead of inheriting an older timestamp.
      if (requiredReadback) {
        pending.propertiesConfirmedAtMonotonicMs = undefined;
        pending.confirmedAt = undefined;
        pending.discardRemaining = pending.discardRequired;
        pending.discardedFrames = 0;
      }
      this.emit("tune-state", "confirming" satisfies TuneState);
    }
  }

  private handleSpectrum(payload: Uint8Array): void {
    const now = Date.now();
    const monotonicNow = performance.now();
    this.lastSpectrumAt = now;
    this.stallNotified = false;
    this.reconnectAttempts = 0;
    this.processingStats.spectrumFramesReceived += 1;
    const maximumBins = Math.min(MAX_NATIVE_SPECTRUM_BINS, Math.max(1, this.options.maxNativeSpectrumBins ?? MAX_NATIVE_SPECTRUM_BINS));
    if (payload.byteLength > maximumBins) {
      this.processingStats.spectrumFramesDropped += 1;
      this.processingStats.invalidSpectrumFramesDropped += 1;
      return;
    }
    const pending = this.pendingTune;
    if (pending) {
      if (!pending.centerConfirmed || !pending.sampleRateConfirmed || !pending.deviceConfirmed) {
        this.processingStats.tuneGateFramesIgnored += 1;
        return;
      }
      if (pending.propertiesConfirmedAtMonotonicMs === undefined || monotonicNow - pending.propertiesConfirmedAtMonotonicMs < pending.settleMs) {
        this.processingStats.tuneGateFramesIgnored += 1;
        return;
      }
      if (pending.discardRemaining > 0) {
        pending.discardRemaining -= 1;
        pending.discardedFrames += 1;
        this.processingStats.tuneFramesDiscarded += 1;
        return;
      }
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingTune = undefined;
      this.currentTune = Object.freeze({
        configurationEpoch: pending.configurationEpoch,
        tuneEpoch: pending.tuneEpoch,
        visitEpoch: pending.visitEpoch,
        visitId: pending.visitId,
        targetId: pending.targetId,
        requestedCenterHz: pending.centerHz,
        confirmedCenterHz: pending.centerHz,
        confirmedSampleRateHz: pending.sampleRateHz,
        tuneConfirmedAt: pending.confirmedAt ?? new Date().toISOString(),
        tuneConfirmedMonotonicMs: pending.propertiesConfirmedAtMonotonicMs ?? monotonicNow,
        discardedFrames: pending.discardedFrames,
      });
      this.currentPhysicalDevice = pending.deviceValue;
      this.frameGateOpen = true;
      this.emit("tune-confirmed", {
        configurationEpoch: pending.configurationEpoch,
        tuneEpoch: pending.tuneEpoch,
        visitEpoch: pending.visitEpoch,
        visitId: pending.visitId,
        targetId: pending.targetId,
        centerHz: pending.centerHz,
        sampleRateHz: pending.sampleRateHz,
        confirmedAt: this.currentTune.tuneConfirmedAt,
      });
      this.emit("tune-state", "confirmed" satisfies TuneState);
    }
    if (!this.frameGateOpen || !this.currentTune) {
      this.processingStats.spectrumFramesDropped += 1;
      this.processingStats.invalidSpectrumFramesDropped += 1;
      return;
    }
    this.setState("live");
    const minimumIntervalMs = 1_000 / Math.max(0.1, this.options.maxSpectrumRateHz ?? 4);
    if (this.lastSpectrumEmittedAt && now - this.lastSpectrumEmittedAt < minimumIntervalMs) {
      this.processingStats.spectrumFramesDropped += 1;
      this.processingStats.rateCoalescedFrames += 1;
      return;
    }
    this.lastSpectrumEmittedAt = now;
    this.processingStats.spectrumFramesEmitted += 1;
    this.emit("spectrum", { ...this.currentTune, bins: payload, receivedMonotonicMs: monotonicNow } satisfies SdrconnectSpectrumPayload);
  }

  private clearPendingTune(): void {
    if (this.pendingTune?.timer) clearTimeout(this.pendingTune.timer);
    this.pendingTune = undefined;
  }

  private updateDeviceReadiness(): void {
    const ready = this.physicalDeviceAvailable
      && this.reportedPhysicalDevice
      && this.deviceStarted
      && this.canControlDevice
      && Number.isFinite(this.confirmedSampleRateHz);
    if (!ready) {
      this.deviceReadySinceMonotonicMs = undefined;
      if (this.deviceReadyTimer) clearTimeout(this.deviceReadyTimer);
      this.deviceReadyTimer = undefined;
      return;
    }
    this.deviceReadySinceMonotonicMs ??= performance.now();
    this.maybeStartRequestedTune();
  }

  private maybeStartRequestedTune(): void {
    if (this.pendingTune || !this.requestedTune || this.deviceReadySinceMonotonicMs === undefined) return;
    // Keep the requested tune available for reconnect recovery, but do not
    // restart its settle/discard gate whenever a routine health property is
    // received after the same epoch has already been confirmed.
    if (this.currentTune?.tuneEpoch === this.requestedTune.tuneEpoch) return;
    const settleMs = Math.max(0, this.options.deviceReadySettleMs ?? DEFAULT_DEVICE_READY_SETTLE_MS);
    const remainingMs = settleMs - (performance.now() - this.deviceReadySinceMonotonicMs);
    if (remainingMs > 0) {
      if (this.deviceReadyTimer) return;
      this.deviceReadyTimer = setTimeout(() => {
        this.deviceReadyTimer = undefined;
        this.maybeStartRequestedTune();
      }, remainingMs);
      this.deviceReadyTimer.unref();
      return;
    }
    this.startPendingTune(this.requestedTune);
  }

  private resetDeviceReadiness(): void {
    if (this.deviceReadyTimer) clearTimeout(this.deviceReadyTimer);
    this.deviceReadyTimer = undefined;
    this.deviceReadySinceMonotonicMs = undefined;
    this.reportedPhysicalDevice = false;
    this.deviceStarted = false;
    this.canControlDevice = false;
  }

  private invalidateConfirmedTune(message: string): void {
    const current = this.currentTune;
    if (!current) return;
    this.frameGateOpen = false;
    this.currentTune = undefined;
    this.currentPhysicalDevice = undefined;
    this.emit("tune-state", "timed-out" satisfies TuneState);
    this.emit("tune-failed", { tuneEpoch: current.tuneEpoch, reason: "tune-mismatch" as const });
    this.setState("stale");
    this.emit("client-error", new Error(message));
  }

  private requestInitialProperties(): void {
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
      "lna_state",
      "spectrum_ref_level",
      "spectrum_base",
      "signal_power",
      "signal_snr",
      "overload",
    ]) {
      this.send({ event_type: "get_property", property });
    }
  }

  private startHealthWatch(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      if (!this.apiReady || this.socket?.readyState !== WebSocket.OPEN) return;
      const reference = this.lastSpectrumAt || this.openedAt;
      const ageMs = Date.now() - reference;
      if (ageMs <= 5_000) return;
      this.setState("stale");
      if (!this.stallNotified) {
        this.stallNotified = true;
        this.emit("stream-stalled", ageMs);
      }
      if (Date.now() - this.lastProbeAt >= 10_000) {
        this.lastProbeAt = Date.now();
        this.probe();
      }
    }, 2_000);
    this.healthTimer.unref();
  }

  private send(message: SdrconnectPropertyMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const envelope: SdrconnectPropertyMessage = {
      event_type: message.event_type,
      property: message.property ?? "",
      value: message.value === undefined ? "" : String(message.value),
      ...(message.device ? { device: message.device } : {}),
    };
    try {
      this.socket.send(JSON.stringify(envelope));
    } catch (error) {
      this.emit("client-error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, Math.min(30_000, 2_500 * (2 ** Math.min(4, Math.max(0, this.reconnectAttempts - 1)))));
    this.reconnectTimer.unref();
  }
}
