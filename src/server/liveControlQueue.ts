import type { OperatorMonitoringState } from "../shared/operatorSummary";

const FAIL_CLOSED_STATES = new Set<OperatorMonitoringState>(["offline", "data-late", "alert"]);

export interface PendingLiveControl {
  payload: string;
  bytes: number;
  monitoringState: OperatorMonitoringState;
  mustDeliver: boolean;
  queuedAt: number;
}

export type LiveControlQueueResult =
  | { state: "idle" | "queued" | "delivered" | "retry" }
  | { state: "close"; reason: string };

/**
 * One-slot state-control queue. Routine deltas coalesce to the newest value.
 * A safety transition may never be overwritten before delivery: the socket is
 * closed instead, which makes the browser fail closed on its stale-data timer.
 */
export class LatestLiveControlQueue {
  private pending?: PendingLiveControl;
  private lastDeliveredMonitoringState?: OperatorMonitoringState;

  constructor(
    private readonly maxBytes: number,
    private readonly safetyDeadlineMs = 2_000,
    private readonly ordinaryDeadlineMs = 10_000,
  ) {}

  get pendingBytes(): number {
    return this.pending?.bytes ?? 0;
  }

  get hasPending(): boolean {
    return Boolean(this.pending);
  }

  markDeliveredState(state: OperatorMonitoringState): void {
    this.lastDeliveredMonitoringState = state;
  }

  enqueue(payload: string, monitoringState: OperatorMonitoringState, now: number): LiveControlQueueResult {
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.maxBytes) return { state: "close", reason: "Control state exceeded its resource bound" };
    const mustDeliver = FAIL_CLOSED_STATES.has(monitoringState)
      && monitoringState !== this.lastDeliveredMonitoringState;
    if (this.pending?.mustDeliver && this.pending.monitoringState !== monitoringState) {
      return { state: "close", reason: "Safety state changed before delivery" };
    }
    const queuedAt = this.pending?.monitoringState === monitoringState
      ? this.pending.queuedAt
      : now;
    this.pending = { payload, bytes, monitoringState, mustDeliver: this.pending?.mustDeliver || mustDeliver, queuedAt };
    return { state: "queued" };
  }

  drain(now: number, send: (payload: string) => boolean): LiveControlQueueResult {
    if (!this.pending) return { state: "idle" };
    if (send(this.pending.payload)) {
      this.lastDeliveredMonitoringState = this.pending.monitoringState;
      this.pending = undefined;
      return { state: "delivered" };
    }
    const deadlineMs = this.pending.mustDeliver ? this.safetyDeadlineMs : this.ordinaryDeadlineMs;
    if (now - this.pending.queuedAt >= deadlineMs) {
      return {
        state: "close",
        reason: this.pending.mustDeliver
          ? "Safety state could not be delivered"
          : "Live control state could not be delivered",
      };
    }
    return { state: "retry" };
  }

  clear(): void {
    this.pending = undefined;
  }
}

