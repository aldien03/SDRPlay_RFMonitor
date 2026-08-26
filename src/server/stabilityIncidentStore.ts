import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StabilityIncident } from "../shared/types";

const MAX_PERSISTED_BYTES = 1024 * 1024;
const MAX_INCIDENTS_IN_MEMORY = 64;

function validIncident(value: unknown): value is StabilityIncident {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StabilityIncident>;
  return candidate.schemaVersion === 1
    && typeof candidate.id === "string"
    && typeof candidate.kind === "string"
    && (candidate.state === "active" || candidate.state === "resolved")
    && (candidate.severity === "attention" || candidate.severity === "critical")
    && typeof candidate.startedAt === "string"
    && typeof candidate.updatedAt === "string"
    && Array.isArray(candidate.reasonCodes)
    && Number.isSafeInteger(candidate.count);
}

export class StabilityIncidentStore {
  private readonly incidents = new Map<string, StabilityIncident>();
  private writeChain = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<StabilityIncidentStore> {
    const store = new StabilityIncidentStore(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const text = await readFile(filePath, "utf8");
      if (Buffer.byteLength(text) > MAX_PERSISTED_BYTES) return store;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const incident = JSON.parse(line) as unknown;
          if (validIncident(incident)) store.incidents.set(incident.id, incident);
        } catch {
          // A malformed historical line is ignored; new records remain append-only.
        }
      }
      store.pruneMemory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  note(
    kind: StabilityIncident["kind"],
    active: boolean,
    severity: StabilityIncident["severity"],
    reasonCodes: readonly string[],
    now = new Date(),
  ): StabilityIncident | undefined {
    const current = [...this.incidents.values()]
      .filter((incident) => incident.kind === kind && incident.state === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!active && !current) return undefined;
    const timestamp = now.toISOString();
    const normalizedReasons = [...new Set(reasonCodes.filter(Boolean))].slice(0, 16).sort();
    if (active && current && current.severity === severity
      && JSON.stringify(current.reasonCodes) === JSON.stringify(normalizedReasons)) return current;
    const incident: StabilityIncident = active
      ? current
        ? { ...current, severity, reasonCodes: normalizedReasons, updatedAt: timestamp }
        : {
            schemaVersion: 1,
            id: randomUUID(),
            kind,
            state: "active",
            severity,
            startedAt: timestamp,
            updatedAt: timestamp,
            reasonCodes: normalizedReasons,
            count: ([...this.incidents.values()].filter((item) => item.kind === kind).at(-1)?.count ?? 0) + 1,
          }
      : { ...current!, state: "resolved", updatedAt: timestamp, resolvedAt: timestamp };
    this.incidents.set(incident.id, incident);
    this.pruneMemory();
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => appendFile(this.filePath, `${JSON.stringify(incident)}\n`, { mode: 0o640 }))
      .catch(() => undefined);
    return incident;
  }

  list(limit = 10): StabilityIncident[] {
    return [...this.incidents.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(0, Math.min(10, limit)))
      .map((incident) => structuredClone(incident));
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private pruneMemory(): void {
    if (this.incidents.size <= MAX_INCIDENTS_IN_MEMORY) return;
    const oldest = [...this.incidents.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const incident of oldest.slice(0, this.incidents.size - MAX_INCIDENTS_IN_MEMORY)) this.incidents.delete(incident.id);
  }
}
