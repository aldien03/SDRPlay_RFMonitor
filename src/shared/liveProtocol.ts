import type { ChannelMonitorState, DetectionEvent, SignalMetricSample, SpectrumFrame } from "./types";

const MAGIC = "RFM1";
const HEADER_BYTES = 6;
export const LIVE_HEARTBEAT_INTERVAL_MS = 2_000;
export const CLIENT_DATA_LATE_AFTER_MS = 5_000;

export interface SpectrumEnvelopeMetadata {
  frame: Omit<SpectrumFrame, "bins">;
  metrics: SignalMetricSample;
  event?: DetectionEvent;
  targetState?: ChannelMonitorState;
  /** Present for a completed logical stitched-survey frame. */
  feedId?: string;
}

export interface SpectrumEnvelope extends SpectrumEnvelopeMetadata {
  bins: Uint8Array;
}

/**
 * Bounded copy of an incident for live messages. The full record, including
 * the complete timeline, is served by GET /api/events/:id.
 */
export function compactLiveEvent(event: DetectionEvent, includeTrigger = true): DetectionEvent {
  return {
    ...event,
    notes: event.notes.slice(-8).map((note) => ({ ...note, text: note.text.slice(0, 512) })),
    ...(event.timeline ? { timeline: event.timeline.slice(-4) } : {}),
    ...(event.disturbedRangesHz ? { disturbedRangesHz: event.disturbedRangesHz.slice(0, 16) } : {}),
    trigger: includeTrigger ? event.trigger : undefined,
  };
}

export function encodeSpectrumEnvelope(
  frame: SpectrumFrame,
  metrics: SignalMetricSample,
  event?: DetectionEvent,
  targetState?: ChannelMonitorState,
  feedId?: string,
): Uint8Array {
  const { bins, ...frameMetadata } = frame;
  const compactEvent = event ? compactLiveEvent(event) : undefined;
  const metadata = new TextEncoder().encode(JSON.stringify({
    frame: frameMetadata,
    metrics,
    event: compactEvent,
    targetState,
    feedId,
  } satisfies SpectrumEnvelopeMetadata));
  if (metadata.byteLength > 65_535) throw new Error("Spectrum metadata is too large");
  const output = new Uint8Array(HEADER_BYTES + metadata.byteLength + bins.length);
  output.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(output.buffer).setUint16(4, metadata.byteLength, false);
  output.set(metadata, HEADER_BYTES);
  output.set(bins, HEADER_BYTES + metadata.byteLength);
  return output;
}

export function decodeSpectrumEnvelope(input: ArrayBuffer | Uint8Array): SpectrumEnvelope {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("Unsupported RF Monitor live frame");
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, false);
  const binsOffset = HEADER_BYTES + metadataLength;
  if (binsOffset > bytes.byteLength) throw new Error("Incomplete RF Monitor live frame");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, binsOffset))) as SpectrumEnvelopeMetadata;
  return { ...metadata, bins: bytes.slice(binsOffset) };
}
