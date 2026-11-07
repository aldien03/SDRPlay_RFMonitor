import { describe, expect, it } from "vitest";
import { sharePathProblem } from "../src/server/sharePath";

describe("evidence share folder rules", () => {
  it.each(["/srv/rf-monitor-evidence", "/data/rf-evidence", "/mnt/disk1/rf.evidence"])("accepts %s", (candidate) => {
    expect(sharePathProblem(candidate, ["/var/lib/rf-monitor/evidence/field/evidence"])).toBeUndefined();
  });

  it.each([
    ["relative/folder", "absolute"],
    ["/srv/rf evidence", "letters, digits"],
    ["/srv/rf;evidence", "letters, digits"],
    ["/srv/../etc", ".."],
    ["/srv//evidence", "clean"],
    ["/", "root"],
    ["/home/sanco/Documents", "/home"],
    ["/root/x", "/root"],
    ["/run/user/1000/x", "/run/user"],
    ["/tmp/x", "/tmp"],
    ["/etc/rf", "/etc"],
    ["/opt/rf-monitor/x", "/opt"],
  ])("rejects %s", (candidate, reason) => {
    expect(sharePathProblem(candidate)).toContain(reason);
  });

  it("keeps the share apart from the evidence store, in both directions", () => {
    const roots = ["/var/lib/rf-monitor/evidence/field/evidence"];
    expect(sharePathProblem("/var/lib/rf-monitor/evidence/field/evidence/share", roots)).toContain("separate");
    expect(sharePathProblem("/var/lib/rf-monitor/evidence", roots)).toContain("separate");
    expect(sharePathProblem("/var/lib/rf-monitor/evidence-share", roots)).toBeUndefined();
  });
});
