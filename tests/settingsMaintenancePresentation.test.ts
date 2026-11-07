import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_CONFIRMATION,
  maintenancePresentation,
  type MaintenanceAction,
} from "../src/client/SettingsPage";

describe("protected Settings actions", () => {
  it("keeps each action separate with an exact confirmation", () => {
    expect(Object.keys(MAINTENANCE_CONFIRMATION)).toEqual([
      "clear-test-data",
      "restart-learning",
      "delete-recordings",
      "restart-software",
    ]);
    expect(new Set(Object.values(MAINTENANCE_CONFIRMATION)).size).toBe(4);
  });

  it.each<[MaintenanceAction, RegExp, RegExp]>([
    ["clear-test-data", /test recordings.*test incidents.*test signal learning/i, /Field data and settings are kept/i],
    ["restart-learning", /new learning period for every active Field frequency.*Low evidence until learning is approved/i, /Recordings, saved learning records and settings are kept/i],
    ["delete-recordings", /finalized Field recordings/i, /Active, finalizing and in-use recordings, exports, signal learning and settings are kept/i],
    ["restart-software", /Monitoring and this dashboard will disconnect briefly/i, /Recordings, signal learning and settings are kept/i],
  ])("states what %s changes and retains", (action, changes, retained) => {
    const copy = maintenancePresentation(action, "field");
    expect(copy.changes).toMatch(changes);
    expect(copy.retained).toMatch(retained);
  });

  it("names the active trust domain before deleting recordings", () => {
    expect(maintenancePresentation("delete-recordings", "field").changes).toContain("Field recordings");
    expect(maintenancePresentation("delete-recordings", "test").changes).toContain("Test recordings");
  });

  it("names the active trust domain before restarting signal learning", () => {
    expect(maintenancePresentation("restart-learning", "field").changes).toContain("active Field frequency");
    expect(maintenancePresentation("restart-learning", "test").changes).toContain("active Test frequency");
  });

  it("names the frequencies whose active alerts a learning restart will end", () => {
    const quiet = maintenancePresentation("restart-learning", "field", []);
    expect(quiet.changes).not.toMatch(/will be ended/);
    expect(quiet.retained).toContain("Incidents are kept.");
    const active = maintenancePresentation("restart-learning", "field", ["GPS L1", "GPS L2"]);
    expect(active.changes).toContain("Active alerts on GPS L1, GPS L2 will be ended.");
    expect(active.retained).toContain("Ended incidents stay in Evidence History.");
  });
});
