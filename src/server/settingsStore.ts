import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { changedFieldPaths, compileEffectiveBands, validateOperationalSettings } from "../shared/settings";
import type { BandCatalog, ConfigurationAuditEntry, OperationalSettings } from "../shared/types";
import { operationalConfigurationHash } from "./config";

export interface PreparedSettingsUpdate {
  previous: OperationalSettings;
  settings: OperationalSettings;
  previousConfigurationHash: string;
  configurationHash: string;
  changedFields: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  try {
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function entryHash(entry: Omit<ConfigurationAuditEntry, "entryHash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export class RevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`Settings changed since this page was opened. Reload revision ${currentRevision}.`);
    this.name = "RevisionConflictError";
  }
}

export class SettingsStore {
  private previousAuditHash = "0".repeat(64);
  private auditTail: Promise<void> = Promise.resolve();
  private auditFailure?: Error;

  private constructor(
    private current: OperationalSettings,
    private readonly catalog: BandCatalog,
    private readonly operationalPath: string,
    private readonly auditPath: string,
    private readonly revisionsPath: string,
    private readonly injectAuditFault?: (phase: "after-write-before-sync" | "after-file-sync-before-directory-sync") => void,
  ) {}

  static async create(options: {
    settings: OperationalSettings;
    catalog: BandCatalog;
    operationalPath: string;
    auditPath: string;
    revisionsPath: string;
    injectAuditFault?: (phase: "after-write-before-sync" | "after-file-sync-before-directory-sync") => void;
  }): Promise<SettingsStore> {
    const store = new SettingsStore(options.settings, options.catalog, options.operationalPath, options.auditPath, options.revisionsPath, options.injectAuditFault);
    await mkdir(path.dirname(options.operationalPath), { recursive: true });
    await mkdir(options.revisionsPath, { recursive: true });
    if (await exists(options.auditPath)) {
      const lines = (await readFile(options.auditPath, "utf8")).trim().split("\n").filter(Boolean);
      let previous = "0".repeat(64);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ConfigurationAuditEntry;
          const { entryHash: recordedHash, ...unsigned } = parsed;
          if (parsed.previousEntryHash !== previous || recordedHash !== entryHash(unsigned)) throw new Error("hash chain mismatch");
          previous = recordedHash;
        } catch {
          throw new Error(`Configuration audit log is invalid: ${options.auditPath}`);
        }
      }
      store.previousAuditHash = previous;
    }
    const operationalExists = await exists(options.operationalPath);
    let restored = false;
    let migratedFromV2 = false;
    if (operationalExists) {
      try {
        const rawOnDisk = JSON.parse(await readFile(options.operationalPath, "utf8")) as { schemaVersion?: unknown };
        const onDisk = validateOperationalSettings(rawOnDisk as OperationalSettings, options.catalog);
        const matchesSupplied = operationalConfigurationHash(onDisk, options.catalog.catalogVersion) === operationalConfigurationHash(options.settings, options.catalog.catalogVersion);
        migratedFromV2 = rawOnDisk.schemaVersion === 2 && matchesSupplied;
        restored = !matchesSupplied;
      } catch {
        restored = true;
      }
      const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
      if (migratedFromV2) {
        const revisionBackup = path.join(options.revisionsPath, `operational-r${String(options.settings.revision).padStart(6, "0")}-pre-v3-${timestamp}.json`);
        await copyFile(options.operationalPath, revisionBackup);
      } else if (restored) {
        await copyFile(options.operationalPath, `${options.operationalPath}.invalid-${timestamp}.bak`);
      }
    }
    if (!operationalExists || restored || migratedFromV2) await writeAtomic(options.operationalPath, options.settings);
    if (migratedFromV2) {
      const hash = operationalConfigurationHash(options.settings, options.catalog.catalogVersion);
      await store.appendAudit({
        timestamp: new Date().toISOString(),
        revision: options.settings.revision,
        actor: "service-migration",
        clientAddress: "local",
        changedFields: ["schemaVersion"],
        outcome: "applied",
        previousConfigurationHash: hash,
        configurationHash: hash,
        reason: "Structurally migrated the active operational profile from schema v2 to v3 while preserving monitoring selections",
      });
    } else if (restored) {
      const hash = operationalConfigurationHash(options.settings, options.catalog.catalogVersion);
      await store.appendAudit({
        timestamp: new Date().toISOString(),
        revision: options.settings.revision,
        actor: "service-recovery",
        clientAddress: "local",
        changedFields: [],
        outcome: "restored",
        previousConfigurationHash: hash,
        configurationHash: hash,
        reason: "Restored the newest valid operational revision after an invalid active profile",
      });
    }
    return store;
  }

  get settings(): OperationalSettings {
    return structuredClone(this.current);
  }

  async recentAudit(limit = 50): Promise<ConfigurationAuditEntry[]> {
    if (!(await exists(this.auditPath))) return [];
    const lines = (await readFile(this.auditPath, "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => JSON.parse(line) as ConfigurationAuditEntry);
  }

  prepare(input: OperationalSettings, expectedRevision: number): PreparedSettingsUpdate {
    if (expectedRevision !== this.current.revision) throw new RevisionConflictError(this.current.revision);
    const candidate = structuredClone(input);
    candidate.revision = this.current.revision + 1;
    candidate.updatedAt = new Date().toISOString();
    const settings = validateOperationalSettings(candidate, this.catalog);
    compileEffectiveBands(this.catalog, settings);
    const previousConfigurationHash = operationalConfigurationHash(this.current, this.catalog.catalogVersion);
    const configurationHash = operationalConfigurationHash(settings, this.catalog.catalogVersion);
    return {
      previous: structuredClone(this.current),
      settings,
      previousConfigurationHash,
      configurationHash,
      changedFields: changedFieldPaths(this.current, settings).filter((field) => !["revision", "updatedAt"].includes(field)),
    };
  }

  async commit(prepared: PreparedSettingsUpdate, actor: string, clientAddress: string): Promise<ConfigurationAuditEntry> {
    await mkdir(this.revisionsPath, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
    const revisionBackup = path.join(this.revisionsPath, `operational-r${String(prepared.previous.revision).padStart(6, "0")}-${timestamp}.json`);
    if (await exists(this.operationalPath)) await copyFile(this.operationalPath, revisionBackup);
    try {
      await writeAtomic(this.operationalPath, prepared.settings);
      this.current = structuredClone(prepared.settings);
      return await this.appendAudit({
        timestamp: new Date().toISOString(),
        revision: prepared.settings.revision,
        actor,
        clientAddress,
        changedFields: prepared.changedFields,
        outcome: "applied",
        previousConfigurationHash: prepared.previousConfigurationHash,
        configurationHash: prepared.configurationHash,
      });
    } catch (error) {
      this.current = structuredClone(prepared.previous);
      await writeAtomic(this.operationalPath, prepared.previous).catch(() => undefined);
      throw error;
    }
  }

  async recordRejected(reason: string, actor: string, clientAddress: string, attemptedHash?: string): Promise<void> {
    const currentHash = operationalConfigurationHash(this.current, this.catalog.catalogVersion);
    await this.appendAudit({
      timestamp: new Date().toISOString(),
      revision: this.current.revision,
      actor,
      clientAddress,
      changedFields: [],
      outcome: "rejected",
      previousConfigurationHash: currentHash,
      configurationHash: attemptedHash ?? currentHash,
      reason,
    });
  }

  /**
   * Adds a non-configuration protected action to the same tamper-evident audit
   * chain and fsyncs it before the privileged request is published.
   */
  async recordOperationalAction(action: string, actor: string, clientAddress: string, reason: string): Promise<ConfigurationAuditEntry> {
    if (!/^[a-z][a-z0-9.-]{2,63}$/.test(action)) throw new Error("Operational audit action is invalid");
    const currentHash = operationalConfigurationHash(this.current, this.catalog.catalogVersion);
    return this.appendAudit({
      timestamp: new Date().toISOString(),
      revision: this.current.revision,
      actor,
      clientAddress,
      changedFields: [`runtime.${action}`],
      outcome: "applied",
      previousConfigurationHash: currentHash,
      configurationHash: currentHash,
      reason,
    });
  }

  private appendAudit(base: Omit<ConfigurationAuditEntry, "previousEntryHash" | "entryHash">): Promise<ConfigurationAuditEntry> {
    const operation = this.auditTail.then(() => this.appendAuditSerialized(base));
    this.auditTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async appendAuditSerialized(base: Omit<ConfigurationAuditEntry, "previousEntryHash" | "entryHash">): Promise<ConfigurationAuditEntry> {
    if (this.auditFailure) throw new Error(`Configuration audit durability is uncertain: ${this.auditFailure.message}`);
    const unsigned = { ...base, previousEntryHash: this.previousAuditHash };
    const entry: ConfigurationAuditEntry = { ...unsigned, entryHash: entryHash(unsigned) };
    const directoryPath = path.dirname(this.auditPath);
    await mkdir(directoryPath, { recursive: true });
    const created = !(await exists(this.auditPath));
    let handle;
    try {
      handle = await open(this.auditPath, "a", 0o640);
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      this.injectAuditFault?.("after-write-before-sync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.injectAuditFault?.("after-file-sync-before-directory-sync");
      if (created) {
        const directory = await open(directoryPath, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      this.previousAuditHash = entry.entryHash;
      return entry;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      this.auditFailure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }
}
