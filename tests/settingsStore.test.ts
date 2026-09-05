import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, RevisionConflictError } from "../src/server/settingsStore";
import { DEFAULT_THRESHOLDS } from "../src/shared/detection";
import { createDefaultOperationalSettings, validateOperationalSettings } from "../src/shared/settings";
import { TEST_CATALOG } from "./catalogFixture";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function settings() {
  return createDefaultOperationalSettings(TEST_CATALOG, {
    siteName: "Test site",
    displayTimeZone: "UTC",
    detection: DEFAULT_THRESHOLDS,
    retention: { sessionMaxBytes: 1_000_000, sessionMaxMs: 3_600_000, retentionMs: 86_400_000, storageMaxBytes: 10_000_000, minimumFreeBytes: 0, maintenanceIntervalMs: 60_000 },
  });
}

async function fixture(initial = settings(), injectAuditFault?: (phase: "after-write-before-sync" | "after-file-sync-before-directory-sync") => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-settings-"));
  temporaryRoots.push(root);
  const operationalPath = path.join(root, "operational.json");
  const auditPath = path.join(root, "config-audit.jsonl");
  const revisionsPath = path.join(root, "revisions");
  const store = await SettingsStore.create({ settings: initial, catalog: TEST_CATALOG, operationalPath, auditPath, revisionsPath, injectAuditFault });
  return { root, operationalPath, auditPath, revisionsPath, store };
}

describe("settings persistence", () => {
  it("writes a new revision atomically, retains a timestamped backup, and hashes the audit chain", async () => {
    const files = await fixture();
    const draft = files.store.settings;
    draft.siteName = "Updated site";
    const prepared = files.store.prepare(draft, 1);
    const entry = await files.store.commit(prepared, "settings-admin", "127.0.0.1");

    expect(JSON.parse(await readFile(files.operationalPath, "utf8"))).toMatchObject({ revision: 2, siteName: "Updated site" });
    expect((await readdir(files.revisionsPath)).some((name) => /^operational-r000001-.*\.json$/.test(name))).toBe(true);
    expect(entry.previousEntryHash).toBe("0".repeat(64));
    expect(entry.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await files.store.recentAudit())[0]).toEqual(entry);
  });

  it("rejects stale revisions and invalid profiles without changing the active settings", async () => {
    const files = await fixture();
    expect(() => files.store.prepare(files.store.settings, 0)).toThrow(RevisionConflictError);
    const invalid = files.store.settings;
    invalid.monitoring.startrack.enabled = false;
    invalid.monitoring["4dx"].enabled = false;
    invalid.monitoring.gnss.enabled = false;
    expect(() => files.store.prepare(invalid, 1)).toThrow(/use Pause/);
    expect(files.store.settings.revision).toBe(1);
  });

  it("restores a supplied valid revision over a corrupted active file and records recovery", async () => {
    const initial = settings();
    const files = await fixture(initial);
    await writeFile(files.operationalPath, "{broken");
    const restored = await SettingsStore.create({ settings: initial, catalog: TEST_CATALOG, operationalPath: files.operationalPath, auditPath: files.auditPath, revisionsPath: files.revisionsPath });
    expect(JSON.parse(await readFile(files.operationalPath, "utf8"))).toMatchObject({ revision: 1, siteName: "Test site" });
    expect((await restored.recentAudit()).at(-1)?.outcome).toBe("restored");
    expect((await readdir(files.root)).some((name) => name.includes(".invalid-") && name.endsWith(".bak"))).toBe(true);
  });

  it("backs up and structurally migrates a matching schema-v2 profile without treating it as invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-settings-"));
    temporaryRoots.push(root);
    const operationalPath = path.join(root, "operational.json");
    const auditPath = path.join(root, "config-audit.jsonl");
    const revisionsPath = path.join(root, "revisions");
    const legacy = structuredClone(settings()) as any;
    legacy.schemaVersion = 2;
    legacy.scan.profile = "balanced";
    legacy.monitoring.gnss.constellations.SBAS.enabled = false;
    legacy.monitoring.gnss.constellations.SBAS.signals["sbas-l1"].enabled = false;
    for (const bandId of ["glonass-g3", "galileo-e6", "beidou-b3i"]) {
      const constellation = TEST_CATALOG.bands.find((band) => band.id === bandId)!.constellation!;
      legacy.monitoring.gnss.constellations[constellation].enabled = true;
      legacy.monitoring.gnss.constellations[constellation].signals[bandId].enabled = true;
    }
    delete legacy.monitoring.gnss.enabledSystemIds;
    delete legacy.monitoring.gnss.enabledSignalIds;
    const rawLegacy = `${JSON.stringify(legacy)}\n`;
    await writeFile(operationalPath, rawLegacy);
    const migrated = validateOperationalSettings(legacy, TEST_CATALOG);

    const store = await SettingsStore.create({ settings: migrated, catalog: TEST_CATALOG, operationalPath, auditPath, revisionsPath });

    const revisionFiles = await readdir(revisionsPath);
    const migrationBackup = revisionFiles.find((name) => /^operational-r000001-pre-v3-.*\.json$/.test(name));
    expect(migrationBackup).toBeDefined();
    expect(await readFile(path.join(revisionsPath, migrationBackup!), "utf8")).toBe(rawLegacy);
    expect(JSON.parse(await readFile(operationalPath, "utf8"))).toEqual(migrated);
    expect(store.settings.revision).toBe(1);
    expect(() => store.prepare(store.settings, 0)).toThrow(RevisionConflictError);
    expect(store.settings.monitoring.gnss.enabledSignalIds).toEqual(expect.arrayContaining(["glonass-g3", "galileo-e6", "beidou-b3i"]));
    expect(store.settings.monitoring.gnss.enabledSignalIds).not.toContain("sbas-l1");
    expect((await readdir(root)).some((name) => name.includes(".invalid-") && name.endsWith(".bak"))).toBe(false);
    const migrationAudit = (await store.recentAudit()).at(-1)!;
    expect(migrationAudit).toMatchObject({
      revision: 1,
      actor: "service-migration",
      clientAddress: "local",
      changedFields: ["schemaVersion"],
      outcome: "applied",
      reason: expect.stringMatching(/structurally migrated.*v2 to v3.*preserving monitoring selections/i),
    });
    expect(migrationAudit.previousConfigurationHash).toBe(migrationAudit.configurationHash);
  });

  it("fails closed when an audit record is modified", async () => {
    const files = await fixture();
    const draft = files.store.settings;
    draft.siteName = "Updated site";
    await files.store.commit(files.store.prepare(draft, 1), "settings-admin", "127.0.0.1");
    const audit = JSON.parse(await readFile(files.auditPath, "utf8"));
    audit.clientAddress = "203.0.113.99";
    await writeFile(files.auditPath, `${JSON.stringify(audit)}\n`);
    await expect(SettingsStore.create({ settings: files.store.settings, catalog: TEST_CATALOG, operationalPath: files.operationalPath, auditPath: files.auditPath, revisionsPath: files.revisionsPath })).rejects.toThrow(/audit log is invalid/);
  });

  it("durably chains a protected runtime action without changing configuration", async () => {
    const files = await fixture();
    const entry = await files.store.recordOperationalAction(
      "software-restart",
      "settings-admin",
      "127.0.0.1",
      "Authorized application restart request prepared",
    );

    expect(files.store.settings.revision).toBe(1);
    expect(entry).toMatchObject({
      revision: 1,
      changedFields: ["runtime.software-restart"],
      outcome: "applied",
      reason: "Authorized application restart request prepared",
    });
    const reopened = await SettingsStore.create({
      settings: files.store.settings,
      catalog: TEST_CATALOG,
      operationalPath: files.operationalPath,
      auditPath: files.auditPath,
      revisionsPath: files.revisionsPath,
    });
    expect((await reopened.recentAudit()).at(-1)).toEqual(entry);
  });

  it("serializes concurrent protected actions into one valid audit chain", async () => {
    const files = await fixture();
    const entries = await Promise.all(Array.from({ length: 32 }, (_, index) => files.store.recordOperationalAction(
      `recovery-${index}`,
      "settings-admin",
      "127.0.0.1",
      `Concurrent protected action ${index}`,
    )));
    expect(new Set(entries.map((entry) => entry.entryHash)).size).toBe(32);
    const reopened = await SettingsStore.create({
      settings: files.store.settings,
      catalog: TEST_CATALOG,
      operationalPath: files.operationalPath,
      auditPath: files.auditPath,
      revisionsPath: files.revisionsPath,
    });
    expect(await reopened.recentAudit(64)).toHaveLength(32);
  });

  it("enters a fail-closed audit state when durability is uncertain", async () => {
    let injected = false;
    const files = await fixture(settings(), (phase) => {
      if (!injected && phase === "after-write-before-sync") {
        injected = true;
        throw new Error("injected fsync boundary failure");
      }
    });
    await expect(files.store.recordOperationalAction(
      "software-restart",
      "settings-admin",
      "127.0.0.1",
      "Prepared restart",
    )).rejects.toThrow(/injected fsync boundary failure/);
    await expect(files.store.recordOperationalAction(
      "software-restart",
      "settings-admin",
      "127.0.0.1",
      "Retry restart",
    )).rejects.toThrow(/audit durability is uncertain/i);
  });
});

describe("quarantined profile retention", () => {
  it("keeps only the newest invalid profiles so the config directory stays bounded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-quarantine-"));
    temporaryRoots.push(root);
    const operationalPath = path.join(root, "operational.json");
    const auditPath = path.join(root, "config-audit.jsonl");
    const revisionsPath = path.join(root, "revisions");

    // Twelve successive starts, each finding an unusable profile on disk.
    for (let index = 0; index < 12; index += 1) {
      await writeFile(operationalPath, "{ not valid json");
      await SettingsStore.create({ settings: settings(), catalog: TEST_CATALOG, operationalPath, auditPath, revisionsPath });
    }

    const quarantined = (await readdir(root)).filter((name) => name.includes(".invalid-"));
    expect(quarantined.length).toBe(10);
  });
});
