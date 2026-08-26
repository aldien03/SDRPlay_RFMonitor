import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StabilityIncidentStore } from "../src/server/stabilityIncidentStore";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("persisted stability incidents", () => {
  it("deduplicates an active condition and records its resolution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-stability-"));
    roots.push(root);
    const filePath = path.join(root, "stability.jsonl");
    const store = await StabilityIncidentStore.open(filePath);
    const started = store.note("host-memory-pressure", true, "attention", ["host-memory-available-low"], new Date("2026-08-26T08:18:00.000Z"));
    store.note("host-memory-pressure", true, "attention", ["host-memory-available-low"], new Date("2026-08-26T08:18:10.000Z"));
    store.note("host-memory-pressure", false, "attention", [], new Date("2026-08-26T08:30:00.000Z"));
    await store.flush();

    expect(store.list()).toEqual([expect.objectContaining({ id: started?.id, state: "resolved", count: 1 })]);
    expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(2);
    const reopened = await StabilityIncidentStore.open(filePath);
    expect(reopened.list()[0]).toMatchObject({ id: started?.id, state: "resolved", resolvedAt: "2026-08-26T08:30:00.000Z" });
  });
});
