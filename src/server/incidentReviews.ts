/**
 * Notes and "reviewed" marks added to an incident after the session that holds
 * it was finalized. Finished sessions are immutable (their manifests and
 * SHA-256 records must not change), so these go into one append-only log at
 * the evidence root, per data domain. Reads overlay the log onto the stored
 * record; packages and reports include it. Entries for sessions that no
 * longer exist are dropped when the log is compacted.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DataDomain, DetectionEvent, IncidentTimelineEntry } from "../shared/types";

export const INCIDENT_REVIEW_LOG = "incident-reviews.jsonl";
/** Far more than years of notes; past this the log is compacted, then refused. */
export const MAX_INCIDENT_REVIEW_LOG_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_TEXT_BYTES = 8 * 1024;
const MAX_TIMELINE_ENTRIES = 64;

export interface IncidentReviewEntry {
  schemaVersion: 1;
  id: string;
  eventId: string;
  /** The incident's first evidence session; used to drop entries whose evidence was deleted. */
  sessionId: string;
  dataDomain: DataDomain;
  type: "note" | "reviewed";
  at: string;
  text?: string;
}

function validEntry(value: unknown, dataDomain: DataDomain): value is IncidentReviewEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.schemaVersion === 1
    && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 64
    && typeof entry.eventId === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(entry.eventId)
    && typeof entry.sessionId === "string" && entry.sessionId.length <= 200
    && entry.dataDomain === dataDomain
    && (entry.type === "note" || entry.type === "reviewed")
    && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
    && (entry.type !== "note" || (typeof entry.text === "string" && entry.text.length > 0 && Buffer.byteLength(entry.text) <= MAX_ENTRY_TEXT_BYTES));
}

function shortDetail(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** The stored record with its later notes and review folded in. Never mutates the input. */
export function applyIncidentReviews(event: DetectionEvent, entries: readonly IncidentReviewEntry[]): DetectionEvent {
  if (!entries.length) return event;
  const noteIds = new Set(event.notes.map((note) => note.id));
  const notes = [...event.notes];
  const timeline: IncidentTimelineEntry[] = [...(event.timeline ?? [])];
  let acknowledgedAt = event.acknowledgedAt;
  for (const entry of entries) {
    if (entry.type === "note" && entry.text && !noteIds.has(entry.id)) {
      noteIds.add(entry.id);
      notes.push({ id: entry.id, timestamp: entry.at, text: entry.text });
      timeline.push({ at: entry.at, code: "note", detail: shortDetail(entry.text) });
    } else if (entry.type === "reviewed" && !acknowledgedAt) {
      acknowledgedAt = entry.at;
      timeline.push({ at: entry.at, code: "acknowledged", detail: "Marked reviewed after the alert ended." });
    }
  }
  notes.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  timeline.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return {
    ...event,
    notes,
    // Same bound style as live incidents: the opening entries and the newest ones.
    timeline: timeline.length > MAX_TIMELINE_ENTRIES ? [...timeline.slice(0, 8), ...timeline.slice(-(MAX_TIMELINE_ENTRIES - 8))] : timeline,
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
  };
}

export class IncidentReviewLog {
  private readonly file: string;
  private cache?: { size: number; mtimeMs: number; byEvent: Map<string, IncidentReviewEntry[]> };
  private writes: Promise<unknown> = Promise.resolve();

  constructor(root: string, private readonly dataDomain: DataDomain) {
    this.file = path.join(root, INCIDENT_REVIEW_LOG);
  }

  private async load(): Promise<Map<string, IncidentReviewEntry[]>> {
    let details;
    try {
      details = await stat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { size: 0, mtimeMs: 0, byEvent: new Map() };
        return this.cache.byEvent;
      }
      throw error;
    }
    if (this.cache && this.cache.size === details.size && this.cache.mtimeMs === details.mtimeMs) return this.cache.byEvent;
    // Appends keep the log under its bound; only the newest part of a log grown by other means is used.
    const whole = await readFile(this.file, "utf8");
    const text = whole.length > MAX_INCIDENT_REVIEW_LOG_BYTES * 2 ? whole.slice(-MAX_INCIDENT_REVIEW_LOG_BYTES * 2) : whole;
    const byEvent = new Map<string, IncidentReviewEntry[]>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // A torn last line from a power cut is skipped, not fatal.
      }
      if (!validEntry(parsed, this.dataDomain)) continue;
      const list = byEvent.get(parsed.eventId) ?? [];
      list.push(parsed);
      byEvent.set(parsed.eventId, list);
    }
    this.cache = { size: details.size, mtimeMs: details.mtimeMs, byEvent };
    return byEvent;
  }

  async entriesFor(eventId: string): Promise<IncidentReviewEntry[]> {
    return [...((await this.load().catch(() => new Map<string, IncidentReviewEntry[]>())).get(eventId) ?? [])];
  }

  async apply(event: DetectionEvent): Promise<DetectionEvent> {
    if (event.syntheticExercise) return event;
    return applyIncidentReviews(event, await this.entriesFor(event.id));
  }

  async applyAll(events: readonly DetectionEvent[]): Promise<DetectionEvent[]> {
    const byEvent = await this.load().catch(() => new Map<string, IncidentReviewEntry[]>());
    return events.map((event) => event.syntheticExercise ? event : applyIncidentReviews(event, byEvent.get(event.id) ?? []));
  }

  /**
   * Append one entry, durably. `liveSessionIds` lets a full log drop entries
   * for incidents whose evidence has been deleted before refusing.
   */
  append(
    input: Pick<IncidentReviewEntry, "eventId" | "sessionId" | "type"> & { text?: string },
    liveSessionIds: () => Promise<ReadonlySet<string>>,
  ): Promise<IncidentReviewEntry> {
    const run = async () => {
      const entry: IncidentReviewEntry = {
        schemaVersion: 1,
        id: randomUUID(),
        eventId: input.eventId,
        sessionId: input.sessionId,
        dataDomain: this.dataDomain,
        type: input.type,
        at: new Date().toISOString(),
        ...(input.type === "note" ? { text: input.text } : {}),
      };
      if (!validEntry(entry, this.dataDomain)) throw new Error("The note could not be saved: it is empty or too long.");
      const line = `${JSON.stringify(entry)}\n`;
      let size = 0;
      try {
        size = (await stat(this.file)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (size + Buffer.byteLength(line) > MAX_INCIDENT_REVIEW_LOG_BYTES) {
        size = await this.compact(await liveSessionIds());
        if (size + Buffer.byteLength(line) > MAX_INCIDENT_REVIEW_LOG_BYTES) throw new Error("The incident review log is full. Delete older recordings, then try again.");
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      const handle = await open(this.file, "a", 0o640);
      try {
        await handle.write(line);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      this.cache = undefined;
      return entry;
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Keep only entries whose incident evidence still exists. Returns the new size. */
  private async compact(liveSessionIds: ReadonlySet<string>): Promise<number> {
    const byEvent = await this.load();
    const kept = [...byEvent.values()].flat()
      .filter((entry) => liveSessionIds.has(entry.sessionId))
      .sort((left, right) => left.at.localeCompare(right.at));
    const contents = kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : "");
    const temporary = `${this.file}.partial-${process.pid}`;
    const handle = await open(temporary, "w", 0o640);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await rename(temporary, this.file);
    this.cache = undefined;
    return Buffer.byteLength(contents);
  }
}
