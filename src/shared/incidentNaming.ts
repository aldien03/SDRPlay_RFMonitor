import type { DetectionEvent } from "./types";

function compactUtc(iso: string): string {
  const parsed = Date.parse(iso);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date(0);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function shortTarget(event: Pick<DetectionEvent, "targetId" | "bandId">): string {
  const source = (event.targetId ?? event.bandId ?? "target").toLowerCase();
  return source.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "target";
}

/** Human-readable incident reference, stable for one incident: INC-20261023-044134Z-gnss-l1-e1-b1c-sbas. */
export function incidentReference(event: Pick<DetectionEvent, "startedAt" | "targetId" | "bandId">): string {
  return `INC-${compactUtc(event.startedAt)}-${shortTarget(event)}`;
}

/** Readable, portable package name: RF-Incident_20261023-044134Z_gnss-l1-e1-b1c-sbas_c0eded38.zip */
export function incidentPackageBaseName(event: Pick<DetectionEvent, "id" | "startedAt" | "targetId" | "bandId">): string {
  const id = event.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "incident";
  return `RF-Incident_${compactUtc(event.startedAt)}_${shortTarget(event)}_${id}`;
}
