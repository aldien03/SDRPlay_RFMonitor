import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyIncidentReviews, IncidentReviewLog, INCIDENT_REVIEW_LOG, type IncidentReviewEntry } from "../src/server/incidentReviews";
import type { DetectionEvent } from "../src/shared/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    id: "event-1", dataDomain: "field", sessionId: "session-a", startedAt: "2026-11-10T07:00:00.000Z", lastSeenAt: "2026-11-10T07:01:00.000Z",
    notes: [{ id: "n0", timestamp: "2026-11-10T07:00:30.000Z", text: "Live note" }],
    timeline: [{ at: "2026-11-10T07:00:05.000Z", code: "alert" }],
    ...overrides,
  } as DetectionEvent;
}

const entry = (overrides: Partial<IncidentReviewEntry>): IncidentReviewEntry => ({
  schemaVersion: 1, id: "r1", eventId: "event-1", sessionId: "session-a", dataDomain: "field", type: "note", at: "2026-11-10T09:00:00.000Z", text: "Later note", ...overrides,
});

describe("incident review log", () => {
  it("folds later notes and the first review into the stored record", () => {
    const merged = applyIncidentReviews(event(), [
      entry({}),
      entry({ id: "r2", type: "reviewed", at: "2026-11-10T09:05:00.000Z", text: undefined }),
      entry({ id: "r3", type: "reviewed", at: "2026-11-10T09:10:00.000Z", text: undefined }),
      entry({}),
    ]);
    expect(merged.notes.map((note) => note.text)).toEqual(["Live note", "Later note"]);
    expect(merged.acknowledgedAt).toBe("2026-11-10T09:05:00.000Z");
    expect(merged.timeline?.map((item) => item.code)).toEqual(["alert", "note", "acknowledged"]);
    expect(applyIncidentReviews(event({ acknowledgedAt: "2026-11-10T08:00:00.000Z" }), [entry({ id: "r2", type: "reviewed", text: undefined })]).acknowledgedAt).toBe("2026-11-10T08:00:00.000Z");
  });

  it("appends durably, skips damaged lines and keeps domains apart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-reviews-"));
    roots.push(root);
    await writeFile(path.join(root, INCIDENT_REVIEW_LOG), `{"torn":\n${JSON.stringify(entry({ id: "other", dataDomain: "test" }))}\n`);
    const log = new IncidentReviewLog(root, "field");
    const live = async () => new Set(["session-a"]);
    await log.append({ eventId: "event-1", sessionId: "session-a", type: "note", text: "Checked the antenna" }, live);
    await log.append({ eventId: "event-1", sessionId: "session-a", type: "reviewed" }, live);
    const entries = await log.entriesFor("event-1");
    expect(entries.map((item) => item.type)).toEqual(["note", "reviewed"]);
    const applied = await log.apply(event());
    expect(applied.notes.at(-1)?.text).toBe("Checked the antenna");
    expect(applied.acknowledgedAt).toBe(entries[1].at);
    expect((await log.apply(event({ syntheticExercise: { scenarioId: "s" } as DetectionEvent["syntheticExercise"] }))).acknowledgedAt).toBeUndefined();
    await expect(log.append({ eventId: "event-1", sessionId: "session-a", type: "note", text: "" }, live)).rejects.toThrow(/empty or too long/);
    expect((await readFile(path.join(root, INCIDENT_REVIEW_LOG), "utf8")).trim().split("\n")).toHaveLength(4);
  });
});
