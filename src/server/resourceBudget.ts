export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private rateBytesPerSecond: number,
    private burstBytes: number,
    now = Date.now(),
  ) {
    this.tokens = burstBytes;
    this.updatedAt = now;
  }

  configure(rateBytesPerSecond: number, burstBytes: number, now = Date.now()): void {
    this.refill(now);
    this.rateBytesPerSecond = rateBytesPerSecond;
    this.burstBytes = burstBytes;
    this.tokens = Math.min(this.tokens, burstBytes);
  }

  take(bytes: number, now = Date.now()): boolean {
    this.refill(now);
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }

  private refill(now: number): void {
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1_000;
    this.updatedAt = now;
    this.tokens = Math.min(this.burstBytes, this.tokens + elapsedSeconds * this.rateBytesPerSecond);
  }
}

export class RollingByteRate {
  private readonly buckets = new Map<number, number>();

  add(bytes: number, now = Date.now()): void {
    const second = Math.floor(now / 1_000);
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + bytes);
    this.prune(second);
  }

  bytesPerSecond(windowSeconds: number, now = Date.now()): number {
    const second = Math.floor(now / 1_000);
    this.prune(second);
    let total = 0;
    const first = second - windowSeconds + 1;
    for (const [bucket, bytes] of this.buckets) if (bucket >= first && bucket <= second) total += bytes;
    return Math.round(total / Math.max(1, windowSeconds));
  }

  private prune(currentSecond: number): void {
    for (const second of this.buckets.keys()) if (second < currentSecond - 59) this.buckets.delete(second);
  }
}

export interface OutboundTrafficSnapshot {
  liveBytes: number;
  httpBytes: number;
  applicationBytes: number;
  liveBytesPerSecond10s: number;
  liveBytesPerSecond60s: number;
  httpBytesPerSecond10s: number;
  httpBytesPerSecond60s: number;
  applicationBytesPerSecond10s: number;
  applicationBytesPerSecond60s: number;
}

/**
 * Counts bytes at the two application egress points without maintaining an
 * unbounded request/client history. HTTP includes response headers when the
 * caller measures the socket delta; live traffic is the WebSocket payload.
 */
export class OutboundTrafficMeter {
  private readonly liveRate = new RollingByteRate();
  private readonly httpRate = new RollingByteRate();
  private readonly applicationRate = new RollingByteRate();
  private liveBytes = 0;
  private httpBytes = 0;

  addLive(bytes: number, now = Date.now()): void {
    const safeBytes = Math.max(0, Math.floor(bytes));
    if (!safeBytes) return;
    this.liveBytes += safeBytes;
    this.liveRate.add(safeBytes, now);
    this.applicationRate.add(safeBytes, now);
  }

  addHttp(bytes: number, now = Date.now()): void {
    const safeBytes = Math.max(0, Math.floor(bytes));
    if (!safeBytes) return;
    this.httpBytes += safeBytes;
    this.httpRate.add(safeBytes, now);
    this.applicationRate.add(safeBytes, now);
  }

  snapshot(now = Date.now()): OutboundTrafficSnapshot {
    return {
      liveBytes: this.liveBytes,
      httpBytes: this.httpBytes,
      applicationBytes: this.liveBytes + this.httpBytes,
      liveBytesPerSecond10s: this.liveRate.bytesPerSecond(10, now),
      liveBytesPerSecond60s: this.liveRate.bytesPerSecond(60, now),
      httpBytesPerSecond10s: this.httpRate.bytesPerSecond(10, now),
      httpBytesPerSecond60s: this.httpRate.bytesPerSecond(60, now),
      applicationBytesPerSecond10s: this.applicationRate.bytesPerSecond(10, now),
      applicationBytesPerSecond60s: this.applicationRate.bytesPerSecond(60, now),
    };
  }
}

/** A small acquisition/release primitive for request-level concurrency caps. */
export class ConcurrentRequestGate {
  private activeRequests = 0;
  private rejectedRequests = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrent request limit must be a positive integer");
  }

  get active(): number {
    return this.activeRequests;
  }

  get rejected(): number {
    return this.rejectedRequests;
  }

  tryAcquire(): (() => void) | undefined {
    if (this.activeRequests >= this.limit) {
      this.rejectedRequests += 1;
      return undefined;
    }
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
  }
}

export const RESOURCE_LIMITS = Object.freeze({
  pressureRssBytes: 448 * 1024 * 1024,
  criticalRssBytes: 576 * 1024 * 1024,
  pressureHeapUtilization: 0.8,
  pressureExternalBytes: 128 * 1024 * 1024,
  pressureWriterQueueItems: 64,
  pressureWriterQueueBytes: 2 * 1024 * 1024,
  pressureEventLoopP99Ms: 100,
  criticalWriterOldestAgeMs: 2_000,
  pressureSustainMs: 10_000,
  healthyRecoveryDwellMs: 30_000,
} as const);

export type ResourcePressureState = "normal" | "pressure" | "critical";

export type ResourcePressureReason =
  | "rss-pressure"
  | "rss-critical"
  | "heap-pressure"
  | "external-buffer-pressure"
  | "writer-queue-pressure"
  | "writer-latency-critical"
  | "event-loop-pressure"
  | "disk-reserve-critical";

export interface ResourceBudgetSample {
  rssBytes: number;
  heapUtilization: number;
  externalBytes: number;
  writerQueueItems: number;
  writerQueueBytes: number;
  writerOldestAgeMs: number;
  eventLoopDelayP99Ms: number;
  diskBelowReserve: boolean;
}

export interface ResourceBudgetPolicy {
  state: ResourcePressureState;
  reasons: ResourcePressureReason[];
  /** Existing dashboards continue receiving bounded canonical control state. */
  admitLiveClients: boolean;
  /** Applies to both new export builds and new download leases. */
  admitExports: boolean;
  maxDashboardRateHz: 2 | 4;
  dashboardsStatusOnly: boolean;
  /** Acquisition, detection, scheduling, and evidence always retain priority. */
  preserveMonitoringPipeline: true;
  enteredAt: number;
  healthySince?: number;
}

export interface ResourceBudgetControllerOptions {
  pressureSustainMs?: number;
  healthyRecoveryDwellMs?: number;
}

function severity(state: ResourcePressureState): number {
  return state === "critical" ? 2 : state === "pressure" ? 1 : 0;
}

/**
 * One authoritative pressure state machine. Escalation is immediate for
 * memory, disk, and writer-latency limits. Queue/event-loop pressure must be
 * sustained so a single sampling spike cannot degrade the operator display.
 * Any recovery is delayed until one continuous healthy dwell has completed.
 */
export class ResourceBudgetController {
  private state: ResourcePressureState = "normal";
  private reasons: ResourcePressureReason[] = [];
  private enteredAt: number;
  private lowerSeveritySince?: number;
  private writerPressureSince?: number;
  private eventLoopPressureSince?: number;
  private readonly pressureSustainMs: number;
  private readonly healthyRecoveryDwellMs: number;

  constructor(options: ResourceBudgetControllerOptions = {}, now = Date.now()) {
    this.pressureSustainMs = options.pressureSustainMs ?? RESOURCE_LIMITS.pressureSustainMs;
    this.healthyRecoveryDwellMs = options.healthyRecoveryDwellMs ?? RESOURCE_LIMITS.healthyRecoveryDwellMs;
    this.enteredAt = now;
  }

  update(sample: ResourceBudgetSample, now = Date.now()): ResourceBudgetPolicy {
    const reasons = new Set<ResourcePressureReason>();
    if (sample.rssBytes >= RESOURCE_LIMITS.criticalRssBytes) reasons.add("rss-critical");
    else if (sample.rssBytes >= RESOURCE_LIMITS.pressureRssBytes) reasons.add("rss-pressure");
    if (sample.heapUtilization >= RESOURCE_LIMITS.pressureHeapUtilization) reasons.add("heap-pressure");
    if (sample.externalBytes >= RESOURCE_LIMITS.pressureExternalBytes) reasons.add("external-buffer-pressure");
    if (sample.writerOldestAgeMs >= RESOURCE_LIMITS.criticalWriterOldestAgeMs) reasons.add("writer-latency-critical");
    if (sample.diskBelowReserve) reasons.add("disk-reserve-critical");

    const writerPressure = sample.writerQueueItems >= RESOURCE_LIMITS.pressureWriterQueueItems
      || sample.writerQueueBytes >= RESOURCE_LIMITS.pressureWriterQueueBytes;
    this.writerPressureSince = this.sustainedSince(writerPressure, this.writerPressureSince, now);
    if (this.writerPressureSince !== undefined && now - this.writerPressureSince >= this.pressureSustainMs) {
      reasons.add("writer-queue-pressure");
    }
    const eventLoopPressure = sample.eventLoopDelayP99Ms >= RESOURCE_LIMITS.pressureEventLoopP99Ms;
    this.eventLoopPressureSince = this.sustainedSince(eventLoopPressure, this.eventLoopPressureSince, now);
    if (this.eventLoopPressureSince !== undefined && now - this.eventLoopPressureSince >= this.pressureSustainMs) {
      reasons.add("event-loop-pressure");
    }

    const rawState: ResourcePressureState = reasons.has("rss-critical")
      || reasons.has("writer-latency-critical")
      || reasons.has("disk-reserve-critical")
      ? "critical"
      : reasons.size
        ? "pressure"
        : "normal";

    if (severity(rawState) > severity(this.state)) {
      this.transition(rawState, [...reasons], now);
    } else if (severity(rawState) === severity(this.state)) {
      this.reasons = [...reasons];
      this.lowerSeveritySince = undefined;
    } else {
      // A lower-but-still-pressured sample is not recovery. Requiring a fully
      // healthy dwell avoids oscillation between critical and pressure.
      if (rawState !== "normal") {
        this.lowerSeveritySince = undefined;
      } else {
        this.lowerSeveritySince ??= now;
        if (now - this.lowerSeveritySince >= this.healthyRecoveryDwellMs) {
          this.transition("normal", [], now);
        }
      }
    }
    return this.snapshot(now);
  }

  snapshot(now = Date.now()): ResourceBudgetPolicy {
    const healthySince = this.lowerSeveritySince !== undefined && this.state !== "normal"
      ? this.lowerSeveritySince
      : undefined;
    return {
      state: this.state,
      reasons: [...this.reasons],
      admitLiveClients: this.state === "normal",
      admitExports: this.state === "normal",
      maxDashboardRateHz: this.state === "normal" ? 4 : 2,
      dashboardsStatusOnly: this.state === "critical",
      preserveMonitoringPipeline: true,
      enteredAt: this.enteredAt,
      healthySince,
    };
  }

  private sustainedSince(active: boolean, previous: number | undefined, now: number): number | undefined {
    if (!active) return undefined;
    return previous ?? now;
  }

  private transition(state: ResourcePressureState, reasons: ResourcePressureReason[], now: number): void {
    this.state = state;
    this.reasons = reasons;
    this.enteredAt = now;
    this.lowerSeveritySince = undefined;
  }
}
