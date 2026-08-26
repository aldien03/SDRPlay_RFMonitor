import { describe, expect, it } from "vitest";
import { evidenceLifecycleCopy, evidenceSessionLifecycle } from "../src/client/BottomPanels";
import type { EvidenceArchiveSession, EvidenceLifecycle } from "../src/shared/types";

function session(lifecycle: EvidenceLifecycle | undefined, status: EvidenceArchiveSession["status"]): Pick<EvidenceArchiveSession, "lifecycle" | "status"> {
  return { lifecycle, status };
}

describe("Evidence History lifecycle presentation", () => {
  it.each<EvidenceLifecycle>(["Active", "Finalizing", "Complete", "Incomplete", "Corrupt"])(
    "uses authoritative %s rather than the compatibility status alias",
    (lifecycle) => {
      expect(evidenceSessionLifecycle(session(lifecycle, "closed"))).toBe(lifecycle);
      expect(evidenceLifecycleCopy(lifecycle).label).toBe(lifecycle);
    },
  );

  it("never infers Complete from a legacy closed alias", () => {
    expect(evidenceSessionLifecycle(session(undefined, "recording"))).toBe("Active");
    expect(evidenceSessionLifecycle(session(undefined, "storage-error"))).toBe("Corrupt");
    expect(evidenceSessionLifecycle(session(undefined, "closed"))).toBe("Incomplete");
  });

  it("downloads Complete sessions and explicitly labelled Incomplete sessions with gaps", () => {
    for (const lifecycle of ["Active", "Finalizing", "Corrupt"] as const) {
      expect(evidenceLifecycleCopy(lifecycle).exportable).toBe(false);
    }
    expect(evidenceLifecycleCopy("Complete")).toMatchObject({ exportable: true, detail: "Ready to download" });
    expect(evidenceLifecycleCopy("Incomplete")).toMatchObject({ exportable: true, detail: "Contains gaps" });
  });
});
