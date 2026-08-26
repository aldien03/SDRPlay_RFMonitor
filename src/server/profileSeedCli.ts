import { open, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateBandCatalog, validateOperationalSettings } from "../shared/settings";
import type { BandCatalog, OperationalSettings } from "../shared/types";

const [catalogPath, templatePath, outputPath] = process.argv.slice(2);
if (!catalogPath || !templatePath || !outputPath) {
  console.error("Usage: profile-seed <catalog.json> <operational-template.json> <output.json>");
  process.exit(2);
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

function integer(name: string, fallback: number, minimum = 0): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be a whole number of at least ${minimum}`);
  return parsed;
}

function applyLegacyBandSelection(settings: OperationalSettings, catalog: BandCatalog, value: unknown): void {
  if (!value || typeof value !== "object" || !Array.isArray((value as { bands?: unknown[] }).bands)) return;
  const enabled = new Set((value as { bands: Array<{ id?: unknown; enabled?: unknown }> }).bands
    .filter((band) => typeof band?.id === "string" && band.enabled !== false)
    .map((band) => String(band.id)));
  settings.monitoring.startrack.enabled = catalog.bands.some((band) => band.service === "startrack" && enabled.has(band.id));
  settings.monitoring["4dx"].enabled = catalog.bands.some((band) => band.service === "4dx" && enabled.has(band.id));
  let anyGnss = false;
  for (const group of Object.values(settings.monitoring.gnss.constellations)) {
    group.enabled = false;
    for (const [bandId, signal] of Object.entries(group.signals)) {
      signal.enabled = enabled.has(bandId);
      group.enabled ||= signal.enabled;
      anyGnss ||= signal.enabled;
    }
  }
  settings.monitoring.gnss.enabledSignalIds = catalog.bands
    .filter((band) => band.service === "gnss" && enabled.has(band.id))
    .map((band) => band.id);
  settings.monitoring.gnss.enabledSystemIds = [...new Set(catalog.bands
    .filter((band) => settings.monitoring.gnss.enabledSignalIds.includes(band.id) && band.constellation)
    .map((band) => band.constellation!))];
  settings.monitoring.gnss.enabled = anyGnss;
  if (![settings.monitoring.startrack.enabled, settings.monitoring["4dx"].enabled, settings.monitoring.gnss.enabled].some(Boolean)) {
    settings.monitoring.startrack.enabled = true;
  }
}

async function optionalJson(filePath: string | undefined): Promise<unknown> {
  if (!filePath || !(await exists(filePath))) return undefined;
  return JSON.parse(await readFile(filePath, "utf8"));
}

if (await exists(outputPath)) {
  console.log(`Operational profile already exists; preserved ${outputPath}`);
  process.exit(0);
}

const catalog = validateBandCatalog(JSON.parse(await readFile(catalogPath, "utf8")) as BandCatalog);
const settings = JSON.parse(await readFile(templatePath, "utf8")) as OperationalSettings;
settings.revision = 1;
settings.updatedAt = new Date().toISOString();
settings.siteName = process.env.RFMON_INITIAL_SITE_NAME?.trim() || settings.siteName;
settings.deploymentId = process.env.RFMON_INITIAL_DEPLOYMENT_ID?.trim() || settings.deploymentId;
settings.displayTimeZone = process.env.RFMON_INITIAL_TIME_ZONE?.trim() || settings.displayTimeZone;
settings.retention.sessionMaxBytes = integer("RFMON_INITIAL_SESSION_MAX_BYTES", settings.retention.sessionMaxBytes, 1);
settings.retention.sessionMaxMs = integer("RFMON_INITIAL_SESSION_MAX_HOURS", Math.round(settings.retention.sessionMaxMs / 3_600_000), 1) * 3_600_000;
settings.retention.retentionMs = integer("RFMON_INITIAL_RETENTION_DAYS", Math.round(settings.retention.retentionMs / 86_400_000), 1) * 86_400_000;
settings.retention.storageMaxBytes = integer("RFMON_INITIAL_STORAGE_MAX_BYTES", settings.retention.storageMaxBytes, 1);
settings.retention.minimumFreeBytes = integer("RFMON_INITIAL_MIN_FREE_BYTES", settings.retention.minimumFreeBytes);

const legacyDetection = await optionalJson(process.env.RFMON_LEGACY_DETECTION_FILE) as Partial<OperationalSettings["detection"]> | undefined;
if (legacyDetection) settings.detection = { ...settings.detection, ...legacyDetection };
applyLegacyBandSelection(settings, catalog, await optionalJson(process.env.RFMON_LEGACY_BANDS_FILE));
const validated = validateOperationalSettings(settings, catalog);

await mkdir(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.tmp-${process.pid}`;
const handle = await open(temporary, "wx", 0o640);
try {
  await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await handle.sync();
} finally {
  await handle.close();
}
await import("node:fs/promises").then(({ rename }) => rename(temporary, outputPath));
console.log(`Created operational profile revision 1: ${outputPath}`);
