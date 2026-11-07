import { afterEach, describe, expect, it, vi } from "vitest";
import { IncidentFigureScheduler } from "../src/server/incidentFigureScheduler";
import type { DetectionEvent } from "../src/shared/types";

const incident = (overrides: Partial<DetectionEvent> = {}) => ({ id: "incident-1", lifecycle: "active", ...overrides }) as DetectionEvent;

afterEach(() => vi.useRealTimers());

describe("incident figure scheduler", () => {
  it("draws shortly after the start, periodically while open, at the end, and once more after post-clear", () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const scheduler = new IncidentFigureScheduler({ request: (event, reason) => requests.push(`${event.id}:${reason}`), firstDelayMs: 60_000, progressEveryMs: 600_000, finalDelayMs: 300_000 });
    const event = incident();
    scheduler.eventStarted(event);
    scheduler.eventStarted(event); // the same incident is reported on every frame
    vi.advanceTimersByTime(59_000);
    expect(requests).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(requests).toEqual(["incident-1:start"]);
    vi.advanceTimersByTime(1_200_000);
    expect(requests).toEqual(["incident-1:start", "incident-1:progress", "incident-1:progress"]);
    event.lifecycle = "cleared";
    scheduler.eventEnded(event);
    expect(requests.at(-1)).toBe("incident-1:end");
    vi.advanceTimersByTime(299_000);
    expect(requests.at(-1)).toBe("incident-1:end");
    vi.advanceTimersByTime(2_000);
    expect(requests.at(-1)).toBe("incident-1:final");
    vi.advanceTimersByTime(10_000_000);
    expect(requests.filter((entry) => entry.endsWith("progress"))).toHaveLength(2);
  });

  it("does not draw a start picture for an incident that already ended, and never for a simulation", () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const scheduler = new IncidentFigureScheduler({ request: (event, reason) => requests.push(`${event.id}:${reason}`), firstDelayMs: 60_000 });
    const quick = incident({ id: "quick" });
    scheduler.eventStarted(quick);
    scheduler.eventEnded(quick);
    vi.advanceTimersByTime(30_000);
    expect(requests).toEqual(["quick:end"]);
    scheduler.eventStarted(incident({ id: "synthetic", syntheticExercise: { runId: "r" } } as Partial<DetectionEvent>));
    scheduler.eventEnded(incident({ id: "synthetic", syntheticExercise: { runId: "r" } } as Partial<DetectionEvent>));
    vi.advanceTimersByTime(10_000_000);
    expect(requests.some((entry) => entry.startsWith("synthetic"))).toBe(false);
  });

  it("caps in-progress pictures and stops cleanly", () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const scheduler = new IncidentFigureScheduler({ request: (_event, reason) => requests.push(reason), firstDelayMs: 1000, progressEveryMs: 1000, maxProgress: 3 });
    scheduler.eventStarted(incident());
    vi.advanceTimersByTime(60_000);
    expect(requests).toEqual(["start", "progress", "progress", "progress"]);
    const stopping = new IncidentFigureScheduler({ request: () => requests.push("late"), firstDelayMs: 1000 });
    stopping.eventStarted(incident({ id: "other" }));
    stopping.stop();
    vi.advanceTimersByTime(60_000);
    expect(requests).not.toContain("late");
    stopping.eventEnded(incident({ id: "other" }));
    expect(requests).not.toContain("late");
  });
});
