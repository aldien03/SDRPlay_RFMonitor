import type { SdrconnectPropertyMessage } from "./sdrconnectClient";

interface RecordedMetadataValue {
  signature: string;
  recordedAt: number;
}

const REFRESH_INTERVAL_MS = 30_000;
const VOLATILE_INTERVAL_MS = 2_000;
const MAX_KEYS = 128;

// Tune state is already captured by every visit/frame record. Keeping the
// center/VFO property chatter as metadata duplicates that evidence and can
// crowd receiver-health state out of the bounded writer queue. This allowlist
// is deliberately limited to fields used by the receiver-health and exact
// baseline fingerprint models.
const STABLE_PROPERTIES = new Set([
  "api_version",
  "active_device",
  "device_serial",
  "device_sample_rate",
  "started",
  "can_control",
  "valid_devices",
  "valid_antennas",
  "active_antenna",
  "lna_state",
  "gain_reduction",
  "if_gain",
  "spectrum_ref_level",
  "spectrum_reference",
  "spectrum_reference_level",
  "spectrum_base",
  "spectrum_base_level",
  "overload",
]);
const VOLATILE_PROPERTIES = new Set(["signal_power", "signal_snr"]);
const ALLOWED_PROPERTIES = new Set([...STABLE_PROPERTIES, ...VOLATILE_PROPERTIES]);
const SESSION_CONTEXT_PROPERTIES = new Set([
  "api_version",
  "active_device",
  "device_serial",
  "device_sample_rate",
  "started",
  "can_control",
  "active_antenna",
  "lna_state",
  "gain_reduction",
  "if_gain",
  "spectrum_ref_level",
  "spectrum_reference",
  "spectrum_reference_level",
  "spectrum_base",
  "spectrum_base_level",
]);

function boundedSignature(value: unknown): string {
  let output: string;
  try {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    output = encoded === undefined ? String(value) : encoded;
  } catch {
    output = String(value);
  }
  return output.slice(0, 512);
}

/**
 * Keep SDR state evidence useful without allowing repeated get-property
 * responses or noisy display metrics to occupy the bounded writer queue.
 */
export class SdrMetadataGate {
  private readonly recorded = new Map<string, RecordedMetadataValue>();

  shouldRecord(receiverId: number, message: SdrconnectPropertyMessage, now = Date.now()): boolean {
    const property = message.property?.trim().toLowerCase();
    if (!property || !ALLOWED_PROPERTIES.has(property)) return false;
    const key = `${receiverId}:${property}`;
    const signature = boundedSignature(message.value);
    const previous = this.recorded.get(key);
    const minimumIntervalMs = VOLATILE_PROPERTIES.has(property) ? VOLATILE_INTERVAL_MS : 0;
    const elapsedMs = previous ? Math.max(0, now - previous.recordedAt) : Number.POSITIVE_INFINITY;
    const changed = !previous || previous.signature !== signature;
    const record = !previous || (changed && elapsedMs >= minimumIntervalMs) || elapsedMs >= REFRESH_INTERVAL_MS;
    if (!record) return false;
    if (!previous && this.recorded.size >= MAX_KEYS) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of this.recorded) {
        if (candidate.recordedAt < oldestAt) {
          oldestAt = candidate.recordedAt;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) this.recorded.delete(oldestKey);
    }
    this.recorded.set(key, { signature, recordedAt: now });
    return true;
  }

  /** Volatile display readings belong in their bounded JSONL stream, not in
   * the atomic session context file. */
  shouldCheckpointContext(message: SdrconnectPropertyMessage): boolean {
    const property = message.property?.trim().toLowerCase();
    return Boolean(property && SESSION_CONTEXT_PROPERTIES.has(property));
  }

  clear(): void {
    this.recorded.clear();
  }

  get size(): number {
    return this.recorded.size;
  }
}
