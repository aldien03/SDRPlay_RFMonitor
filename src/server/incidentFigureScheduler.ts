import type { DetectionEvent } from "../shared/types";
import type { IncidentFigureReason } from "./evidenceStore";

export interface IncidentFigureSchedulerOptions {
  /** Asks for one picture. The caller decides whether it is enabled and whether resources allow it. */
  request: (event: DetectionEvent, reason: IncidentFigureReason) => void;
  /** First picture after an incident starts, so there is something to see even if it never clears. */
  firstDelayMs?: number;
  /** While an incident stays open: one picture this often. */
  progressEveryMs?: number;
  /** Upper bound on in-progress pictures per incident. */
  maxProgress?: number;
  /** After the end: one last picture once the post-clear recording has finished. */
  finalDelayMs?: number;
}

/**
 * When to draw an incident's picture: shortly after it starts, periodically while it lasts, when it
 * ends, and once more after the post-clear evidence is complete. Timers never keep the process alive.
 */
export class IncidentFigureScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly progress = new Map<string, number>();
  private stopped = false;
  private readonly firstDelayMs: number;
  private readonly progressEveryMs: number;
  private readonly maxProgress: number;
  private readonly finalDelayMs: number;

  constructor(private readonly options: IncidentFigureSchedulerOptions) {
    this.firstDelayMs = options.firstDelayMs ?? 60_000;
    this.progressEveryMs = options.progressEveryMs ?? 30 * 60_000;
    this.maxProgress = options.maxProgress ?? 12;
    this.finalDelayMs = options.finalDelayMs ?? 10 * 60_000;
  }

  /** The incident is open and may still be reported again for the same event: only the first call counts. */
  eventStarted(event: DetectionEvent): void {
    if (this.stopped || event.syntheticExercise || this.timers.has(`${event.id}:start`) || this.progress.has(event.id)) return;
    this.progress.set(event.id, 0);
    this.arm(`${event.id}:start`, this.firstDelayMs, () => {
      this.options.request(event, "start");
      this.armProgress(event);
    });
  }

  eventEnded(event: DetectionEvent): void {
    if (this.stopped || event.syntheticExercise) return;
    this.clear(`${event.id}:start`);
    this.clear(`${event.id}:progress`);
    this.progress.delete(event.id);
    this.options.request(event, "end");
    this.arm(`${event.id}:final`, this.finalDelayMs, () => this.options.request(event, "final"));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.progress.clear();
  }

  private armProgress(event: DetectionEvent): void {
    if ((this.progress.get(event.id) ?? this.maxProgress) >= this.maxProgress) return;
    this.arm(`${event.id}:progress`, this.progressEveryMs, () => {
      if (event.lifecycle === "cleared" || event.lifecycle === "ended-unknown" || event.clearedAt || event.endedAt) return;
      this.progress.set(event.id, (this.progress.get(event.id) ?? 0) + 1);
      this.options.request(event, "progress");
      this.armProgress(event);
    });
  }

  private arm(key: string, delayMs: number, action: () => void): void {
    this.clear(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (!this.stopped) action();
    }, delayMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }
}
