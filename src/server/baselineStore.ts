import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DataDomain } from "../shared/types";

export type BaselineLifecycle = "learning" | "provisional" | "reviewable" | "protected" | "stale";

export const BASELINE_REJECTION_REASONS = [
  "anomaly-candidate",
  "receiver-overload",
  "target-event",
  "resource-pressure",
  "host-memory-pressure",
  "application-recovery",
  "receiver-startup-grace",
  "receiver-recovery",
  "evidence-unavailable",
  "receiver-health-incomplete",
  "detector-quarantine",
  "tune-timeout",
  "insufficient-frames",
  "receiver-unhealthy",
  "configuration-changed",
  "tune-mismatch",
  "bin-grid-changed",
  "legacy-unclassified",
] as const;
export type BaselineRejectionReason = typeof BASELINE_REJECTION_REASONS[number];

export const BASELINE_HOUR_DISQUALIFICATION_REASONS = [
  "clock-integrity-unsafe",
  "source-integrity-unsafe",
  "legacy-unclassified",
] as const;
export type BaselineHourDisqualificationReason = typeof BASELINE_HOUR_DISQUALIFICATION_REASONS[number];

export interface BaselineLearningExclusions {
  rejectedVisits: number;
  rejectedByReason: Partial<Record<BaselineRejectionReason, number>>;
  disqualifiedHours: number;
  disqualifiedByReason: Partial<Record<BaselineHourDisqualificationReason, number>>;
}

export type FingerprintJson =
  | null
  | boolean
  | number
  | string
  | FingerprintJson[]
  | { [key: string]: FingerprintJson };

/**
 * The store deliberately treats the fingerprint as an opaque, canonical JSON
 * value. The detector is responsible for supplying every RF/configuration field
 * which makes a baseline comparable. targetId is required so a non-matching
 * fingerprint can be reported as stale for the same physical target.
 */
export type BaselineFingerprint = Readonly<{ targetId: string; dataDomain: DataDomain } & Record<string, FingerprintJson>>;

export interface BaselineDescriptor {
  fingerprintId: string;
  fingerprint: BaselineFingerprint;
  targetId: string;
  generation: number;
  lifecycle: Exclude<BaselineLifecycle, "stale">;
  createdAt: string;
  firstObservationAt?: string;
  lastObservationAt?: string;
  protectedAt?: string;
  protectedBy?: string;
  totalValidObservations: number;
  totalExpectedVisits: number;
  coverageRatio: number;
  representativeUtcHours: number;
  reservoirCount: number;
  reservoirSeen: number;
  binCount: number;
  learningExclusions: BaselineLearningExclusions;
}

export interface BaselineSnapshot extends BaselineDescriptor {
  median: Uint8Array;
  mad: Uint8Array;
}

export type BaselineSelection =
  | { lifecycle: Exclude<BaselineLifecycle, "stale">; baseline: BaselineSnapshot }
  | {
      lifecycle: "stale";
      requestedFingerprintId: string;
      targetId: string;
      previous: BaselineDescriptor[];
    };

export interface BaselineStoreOptions {
  filePath: string;
  dataDomain?: DataDomain;
  now?: () => number;
  random?: () => number;
  reservoirCapacity?: number;
  provisionalMinimumMs?: number;
  provisionalMinimumObservations?: number;
  provisionalMinimumCoverage?: number;
  reviewableMinimumUtcHours?: number;
  representativeHourMinimumObservations?: number;
  /** Minimum wall-clock spread of valid visits within one UTC hour. */
  representativeHourMinimumSpanMs?: number;
  /** Minimum accumulated receiver exposure within one UTC hour. */
  representativeHourMinimumExposureMs?: number;
  maxHourBuckets?: number;
  maxTargets?: number;
  /** Deterministic filesystem-boundary seam used only by tests. */
  injectAtomicWriteFault?: (point: "after-rename-before-directory-sync") => void | Promise<void>;
}

export interface ObservationOptions {
  observedAt?: string | number | Date;
  /** Number of scheduled visits represented by this observation, including this valid visit. */
  expectedVisits?: number;
  /** Actual accepted-frame exposure represented by this valid observation. */
  exposureMs?: number;
}

export interface GapOptions {
  /** Explicit reason for excluding these visits from signal learning. */
  reason: BaselineRejectionReason;
  observedAt?: string | number | Date;
  missedVisits?: number;
  /** Reserved for evidence that makes the complete UTC hour unusable. */
  disqualifyHourReason?: BaselineHourDisqualificationReason;
}

interface HourBucket {
  hourStartMs: number;
  valid: number;
  expected: number;
  validExposureMs: number;
  firstValidAtMs?: number;
  lastValidAtMs?: number;
  rejectedByReason: Partial<Record<BaselineRejectionReason, number>>;
  disqualificationReasons: BaselineHourDisqualificationReason[];
}

interface BaselineRecord {
  fingerprintId: string;
  fingerprint: BaselineFingerprint;
  targetId: string;
  generation: number;
  lifecycle: Exclude<BaselineLifecycle, "stale">;
  createdAtMs: number;
  firstObservationAtMs?: number;
  lastObservationAtMs?: number;
  protectedAtMs?: number;
  protectedBy?: string;
  totalValidObservations: number;
  totalExpectedVisits: number;
  reservoirSeen: number;
  reservoirCount: number;
  binCount: number;
  reservoir: Uint8Array;
  median: Uint8Array;
  mad: Uint8Array;
  derivedDirty: boolean;
  hourBuckets: HourBucket[];
}

interface PersistedBaselineRecord {
  fingerprintId: string;
  fingerprint: BaselineFingerprint;
  targetId: string;
  generation: number;
  lifecycle: Exclude<BaselineLifecycle, "stale">;
  createdAt: string;
  firstObservationAt?: string;
  lastObservationAt?: string;
  protectedAt?: string;
  protectedBy?: string;
  totalValidObservations: number;
  totalExpectedVisits: number;
  reservoirSeen: number;
  reservoirCount: number;
  binCount: number;
  reservoirBase64: string;
  medianBase64: string;
  madBase64: string;
  hourBuckets: HourBucket[];
}

interface PersistedBaselineFile {
  schemaVersion: 3;
  dataDomain: DataDomain;
  updatedAt: string;
  records: PersistedBaselineRecord[];
}

const FILE_SCHEMA_VERSION = 3;
const LEGACY_FILE_SCHEMA_VERSION = 2;
const DEFAULT_RESERVOIR_CAPACITY = 256;
const DEFAULT_MINIMUM_LEARNING_MS = 30 * 60 * 1_000;
const DEFAULT_MINIMUM_OBSERVATIONS = 64;
const DEFAULT_MINIMUM_COVERAGE = 0.8;
const DEFAULT_REVIEWABLE_HOURS = 24;
const DEFAULT_REPRESENTATIVE_HOUR_MINIMUM_OBSERVATIONS = 2;
const DEFAULT_REPRESENTATIVE_HOUR_MINIMUM_SPAN_MS = 30 * 60_000;
const DEFAULT_REPRESENTATIVE_HOUR_MINIMUM_EXPOSURE_MS = 10_000;
const DEFAULT_MAX_HOUR_BUCKETS = 168;
const DEFAULT_MAX_TARGETS = 128;
const MAX_BIN_COUNT = 8_192;
const MAX_RECORDS_ON_DISK = 4_096;
const HOUR_MS = 60 * 60 * 1_000;
const REJECTION_REASON_SET = new Set<string>(BASELINE_REJECTION_REASONS);
const HOUR_DISQUALIFICATION_REASON_SET = new Set<string>(BASELINE_HOUR_DISQUALIFICATION_REASONS);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value: unknown, location = "fingerprint"): FingerprintJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${location}[${index}]`));
  if (isObject(value)) {
    const result: Record<string, FingerprintJson> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new Error(`${location}.${key} is not valid canonical JSON`);
      }
      result[key] = canonicalValue(child, `${location}.${key}`);
    }
    return result;
  }
  throw new Error(`${location} is not valid canonical JSON`);
}

export function canonicalFingerprintJson(fingerprint: BaselineFingerprint): string {
  const canonical = canonicalValue(fingerprint);
  if (!isObject(canonical) || typeof canonical.targetId !== "string" || canonical.targetId.trim().length === 0) {
    throw new Error("Baseline fingerprint requires a non-empty targetId");
  }
  if (canonical.dataDomain !== "field" && canonical.dataDomain !== "test") {
    throw new Error("Baseline fingerprint requires an explicit field or test dataDomain");
  }
  return JSON.stringify(canonical);
}

export function baselineFingerprintId(fingerprint: BaselineFingerprint): string {
  return createHash("sha256").update(canonicalFingerprintJson(fingerprint)).digest("hex");
}

function canonicalFingerprint(fingerprint: BaselineFingerprint): BaselineFingerprint {
  return JSON.parse(canonicalFingerprintJson(fingerprint)) as BaselineFingerprint;
}

function timestampMs(value: string | number | Date | undefined, fallback: number): number {
  const result = value === undefined ? fallback : value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(result) || result < 0) throw new Error("Observation timestamp is invalid");
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function parseReasonCounts<TReason extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Partial<Record<TReason, number>> {
  if (!isObject(value)) throw new Error(`${label} is invalid`);
  const result: Partial<Record<TReason, number>> = {};
  for (const [reason, count] of Object.entries(value)) {
    if (!allowed.has(reason)) throw new Error(`${label} contains unsupported reason ${reason}`);
    const parsed = nonNegativeInteger(count, `${label}.${reason}`);
    if (parsed > 0) result[reason as TReason] = parsed;
  }
  return result;
}

function incrementReason<TReason extends string>(counts: Partial<Record<TReason, number>>, reason: TReason, count: number): void {
  counts[reason] = (counts[reason] ?? 0) + count;
}

function exactBase64(value: string, label: string): Uint8Array {
  if (typeof value !== "string" || (value.length > 0 && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)))) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return new Uint8Array(decoded);
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
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

class AtomicWriteRenamedError extends Error {
  readonly renamed = true;

  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "AtomicWriteRenamedError";
  }
}

async function syncStorageDirectory(filePath: string): Promise<void> {
  const directory = await open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeAtomic(
  filePath: string,
  value: unknown,
  injectFault?: BaselineStoreOptions["injectAtomicWriteFault"],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await injectFault?.("after-rename-before-directory-sync");
    await syncStorageDirectory(filePath);
  } catch (error) {
    if (process.platform !== "win32" || injectFault) {
      throw new AtomicWriteRenamedError("Baseline file was replaced but directory durability was not confirmed", { cause: error });
    }
  }
}

export class BaselineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineConflictError";
  }
}

export class BaselineFingerprintConflictError extends BaselineConflictError {
  constructor(readonly currentFingerprintId: string) {
    super(`Baseline fingerprint changed; reload ${currentFingerprintId}.`);
    this.name = "BaselineFingerprintConflictError";
  }
}

export class BaselineGenerationConflictError extends BaselineConflictError {
  constructor(readonly currentGeneration: number) {
    super(`Baseline generation changed; reload generation ${currentGeneration}.`);
    this.name = "BaselineGenerationConflictError";
  }
}

export class BaselineNotReviewableError extends Error {
  constructor(readonly lifecycle: Exclude<BaselineLifecycle, "stale">) {
    super(`Only a reviewable baseline can be protected; current lifecycle is ${lifecycle}.`);
    this.name = "BaselineNotReviewableError";
  }
}

export class ProtectedBaselineImmutableError extends Error {
  constructor() {
    super("Protected baselines are immutable; restart learning to create a new generation.");
    this.name = "ProtectedBaselineImmutableError";
  }
}

/** The new generation is visible on disk, but its directory entry needs recovery confirmation. */
export class BaselineRestartCommitUncertainError extends Error {
  readonly committed = true;

  constructor(readonly descriptor: BaselineDescriptor, options: { cause: unknown }) {
    super("Baseline generation changed, but storage durability requires recovery before monitoring can resume.", options);
    this.name = "BaselineRestartCommitUncertainError";
  }
}

export class BaselineStore {
  private readonly filePath: string;
  private readonly dataDomain: DataDomain;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly reservoirCapacity: number;
  private readonly provisionalMinimumMs: number;
  private readonly provisionalMinimumObservations: number;
  private readonly provisionalMinimumCoverage: number;
  private readonly reviewableMinimumUtcHours: number;
  private readonly representativeHourMinimumObservations: number;
  private readonly representativeHourMinimumSpanMs: number;
  private readonly representativeHourMinimumExposureMs: number;
  private readonly maxHourBuckets: number;
  private readonly maxTargets: number;
  private readonly injectAtomicWriteFault?: BaselineStoreOptions["injectAtomicWriteFault"];
  private readonly records: BaselineRecord[];
  private scratch = new Uint8Array(0);
  private dirty = false;
  private checkpointPromise: Promise<void> | null = null;
  private checkpointError: Error | null = null;
  private checkpointWrites = 0;
  private coalescedCheckpoints = 0;

  private constructor(options: BaselineStoreOptions, records: BaselineRecord[]) {
    this.filePath = options.filePath;
    this.dataDomain = options.dataDomain ?? "field";
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.reservoirCapacity = positiveInteger(options.reservoirCapacity ?? DEFAULT_RESERVOIR_CAPACITY, "reservoirCapacity");
    if (this.reservoirCapacity > DEFAULT_RESERVOIR_CAPACITY) throw new Error("reservoirCapacity cannot exceed 256 observations");
    this.provisionalMinimumMs = positiveInteger(options.provisionalMinimumMs ?? DEFAULT_MINIMUM_LEARNING_MS, "provisionalMinimumMs");
    this.provisionalMinimumObservations = positiveInteger(options.provisionalMinimumObservations ?? DEFAULT_MINIMUM_OBSERVATIONS, "provisionalMinimumObservations");
    const coverage = options.provisionalMinimumCoverage ?? DEFAULT_MINIMUM_COVERAGE;
    if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) throw new Error("provisionalMinimumCoverage must be between zero and one");
    this.provisionalMinimumCoverage = coverage;
    this.reviewableMinimumUtcHours = positiveInteger(options.reviewableMinimumUtcHours ?? DEFAULT_REVIEWABLE_HOURS, "reviewableMinimumUtcHours");
    this.representativeHourMinimumObservations = positiveInteger(
      options.representativeHourMinimumObservations ?? DEFAULT_REPRESENTATIVE_HOUR_MINIMUM_OBSERVATIONS,
      "representativeHourMinimumObservations",
    );
    this.representativeHourMinimumSpanMs = nonNegativeInteger(
      options.representativeHourMinimumSpanMs ?? DEFAULT_REPRESENTATIVE_HOUR_MINIMUM_SPAN_MS,
      "representativeHourMinimumSpanMs",
    );
    if (this.representativeHourMinimumSpanMs >= HOUR_MS) throw new Error("representativeHourMinimumSpanMs must be less than one hour");
    this.representativeHourMinimumExposureMs = nonNegativeInteger(
      options.representativeHourMinimumExposureMs ?? DEFAULT_REPRESENTATIVE_HOUR_MINIMUM_EXPOSURE_MS,
      "representativeHourMinimumExposureMs",
    );
    if (this.representativeHourMinimumExposureMs > HOUR_MS) throw new Error("representativeHourMinimumExposureMs cannot exceed one hour");
    this.maxHourBuckets = positiveInteger(options.maxHourBuckets ?? DEFAULT_MAX_HOUR_BUCKETS, "maxHourBuckets");
    if (this.maxHourBuckets > DEFAULT_MAX_HOUR_BUCKETS) throw new Error("maxHourBuckets cannot exceed 168");
    this.maxTargets = positiveInteger(options.maxTargets ?? DEFAULT_MAX_TARGETS, "maxTargets");
    this.injectAtomicWriteFault = options.injectAtomicWriteFault;
    this.records = records;
  }

  static async open(options: BaselineStoreOptions): Promise<BaselineStore> {
    await mkdir(path.dirname(options.filePath), { recursive: true });
    let records: BaselineRecord[] = [];
    if (await exists(options.filePath)) {
      try {
        const parsed = JSON.parse(await readFile(options.filePath, "utf8")) as unknown;
        records = BaselineStore.parseFile(
          parsed,
          options.reservoirCapacity ?? DEFAULT_RESERVOIR_CAPACITY,
          options.maxHourBuckets ?? DEFAULT_MAX_HOUR_BUCKETS,
          options.dataDomain ?? "field",
        );
      } catch (error) {
        const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
        const backup = `${options.filePath}.invalid-${timestamp}.bak`;
        await copyFile(options.filePath, backup);
        throw new Error(`Baseline file is invalid; preserved as ${backup}. Service must remain in Checking.`, { cause: error });
      }
    }
    return new BaselineStore(options, records);
  }

  static async create(options: BaselineStoreOptions): Promise<BaselineStore> {
    return BaselineStore.open(options);
  }

  static parseFile(value: unknown, reservoirCapacity: number, maxHourBuckets: number, dataDomain: DataDomain = "field"): BaselineRecord[] {
    if (!isObject(value)
      || (value.schemaVersion !== FILE_SCHEMA_VERSION && value.schemaVersion !== LEGACY_FILE_SCHEMA_VERSION)
      || value.dataDomain !== dataDomain
      || !Array.isArray(value.records)
      || value.records.length > MAX_RECORDS_ON_DISK) {
      throw new Error("Unsupported or malformed baseline file");
    }
    const schemaVersion = value.schemaVersion;
    if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Baseline file updatedAt is invalid");
    const seen = new Set<string>();
    return value.records.map((raw, index) => {
      if (!isObject(raw)) throw new Error(`Baseline record ${index} is invalid`);
      const fingerprint = canonicalFingerprint(raw.fingerprint as BaselineFingerprint);
      if (fingerprint.dataDomain !== dataDomain) throw new Error(`Baseline record ${index} crosses the ${dataDomain} data-domain boundary`);
      const fingerprintId = baselineFingerprintId(fingerprint);
      if (raw.fingerprintId !== fingerprintId) throw new Error(`Baseline record ${index} fingerprint hash mismatch`);
      if (raw.targetId !== fingerprint.targetId) throw new Error(`Baseline record ${index} target mismatch`);
      const generation = positiveInteger(raw.generation as number, `Baseline record ${index} generation`);
      const recordKey = `${fingerprintId}:${generation}`;
      if (seen.has(recordKey)) throw new Error(`Duplicate baseline record ${recordKey}`);
      seen.add(recordKey);
      if (!(["learning", "provisional", "reviewable", "protected"] as unknown[]).includes(raw.lifecycle)) throw new Error(`Baseline record ${index} lifecycle is invalid`);
      const createdAtMs = Date.parse(raw.createdAt as string);
      if (!Number.isFinite(createdAtMs)) throw new Error(`Baseline record ${index} createdAt is invalid`);
      const firstObservationAtMs = raw.firstObservationAt === undefined ? undefined : Date.parse(raw.firstObservationAt as string);
      const lastObservationAtMs = raw.lastObservationAt === undefined ? undefined : Date.parse(raw.lastObservationAt as string);
      const protectedAtMs = raw.protectedAt === undefined ? undefined : Date.parse(raw.protectedAt as string);
      if (firstObservationAtMs !== undefined && !Number.isFinite(firstObservationAtMs)) throw new Error(`Baseline record ${index} firstObservationAt is invalid`);
      if (lastObservationAtMs !== undefined && !Number.isFinite(lastObservationAtMs)) throw new Error(`Baseline record ${index} lastObservationAt is invalid`);
      if (protectedAtMs !== undefined && !Number.isFinite(protectedAtMs)) throw new Error(`Baseline record ${index} protectedAt is invalid`);
      const totalValidObservations = nonNegativeInteger(raw.totalValidObservations, `Baseline record ${index} totalValidObservations`);
      const totalExpectedVisits = nonNegativeInteger(raw.totalExpectedVisits, `Baseline record ${index} totalExpectedVisits`);
      const reservoirSeen = nonNegativeInteger(raw.reservoirSeen, `Baseline record ${index} reservoirSeen`);
      const reservoirCount = nonNegativeInteger(raw.reservoirCount, `Baseline record ${index} reservoirCount`);
      const binCount = nonNegativeInteger(raw.binCount, `Baseline record ${index} binCount`);
      if (binCount > MAX_BIN_COUNT || reservoirCount > reservoirCapacity || reservoirCount > reservoirSeen || reservoirSeen > totalValidObservations) {
        throw new Error(`Baseline record ${index} counters exceed resource bounds`);
      }
      const persistedReservoir = exactBase64(raw.reservoirBase64 as string, `Baseline record ${index} reservoir`);
      const median = exactBase64(raw.medianBase64 as string, `Baseline record ${index} median`);
      const mad = exactBase64(raw.madBase64 as string, `Baseline record ${index} mad`);
      if (persistedReservoir.byteLength !== reservoirCount * binCount || median.byteLength !== binCount || mad.byteLength !== binCount) {
        throw new Error(`Baseline record ${index} packed array size mismatch`);
      }
      // Persistence stores only occupied rows. Restore the fixed-capacity packed
      // reservoir so a learning baseline can continue appending after restart.
      const reservoir = new Uint8Array(reservoirCapacity * binCount);
      reservoir.set(persistedReservoir);
      if (!Array.isArray(raw.hourBuckets) || raw.hourBuckets.length > maxHourBuckets) throw new Error(`Baseline record ${index} hour buckets exceed bounds`);
      let previousHour = -1;
      const hourBuckets = raw.hourBuckets.map((bucket, bucketIndex) => {
        if (!isObject(bucket)) throw new Error(`Baseline record ${index} hour bucket ${bucketIndex} is invalid`);
        const hourStartMs = nonNegativeInteger(bucket.hourStartMs, `Baseline record ${index} hourStartMs`);
        const valid = nonNegativeInteger(bucket.valid, `Baseline record ${index} hour valid count`);
        const expected = nonNegativeInteger(bucket.expected, `Baseline record ${index} hour expected count`);
        if (hourStartMs % HOUR_MS !== 0 || hourStartMs <= previousHour || valid > expected) throw new Error(`Baseline record ${index} hour bucket is inconsistent`);
        // Schema v2 stored only one irreversible eligibility bit. Preserve any
        // false or pre-exposure bucket as a fail-closed legacy disqualification;
        // there is not enough evidence to reconstruct its original reason.
        const hasExposureAccounting = bucket.validExposureMs !== undefined
          && (schemaVersion === FILE_SCHEMA_VERSION || bucket.eligible !== undefined);
        if (schemaVersion === LEGACY_FILE_SCHEMA_VERSION && hasExposureAccounting && typeof bucket.eligible !== "boolean") {
          throw new Error(`Baseline record ${index} hour eligibility is invalid`);
        }
        if (schemaVersion === FILE_SCHEMA_VERSION && !hasExposureAccounting) {
          throw new Error(`Baseline record ${index} hour exposure accounting is missing`);
        }
        const validExposureMs = hasExposureAccounting
          ? nonNegativeInteger(bucket.validExposureMs, `Baseline record ${index} hour valid exposure`)
          : 0;
        const firstValidAtMs = bucket.firstValidAtMs === undefined
          ? undefined
          : nonNegativeInteger(bucket.firstValidAtMs, `Baseline record ${index} hour first valid timestamp`);
        const lastValidAtMs = bucket.lastValidAtMs === undefined
          ? undefined
          : nonNegativeInteger(bucket.lastValidAtMs, `Baseline record ${index} hour last valid timestamp`);
        if ((firstValidAtMs === undefined) !== (lastValidAtMs === undefined)
          || (hasExposureAccounting && valid > 0 && firstValidAtMs === undefined)
          || (firstValidAtMs !== undefined && (
            firstValidAtMs < hourStartMs
            || lastValidAtMs! >= hourStartMs + HOUR_MS
            || lastValidAtMs! < firstValidAtMs
          ))) throw new Error(`Baseline record ${index} hour exposure timestamps are inconsistent`);
        let rejectedByReason: Partial<Record<BaselineRejectionReason, number>>;
        let disqualificationReasons: BaselineHourDisqualificationReason[];
        if (schemaVersion === FILE_SCHEMA_VERSION) {
          rejectedByReason = parseReasonCounts<BaselineRejectionReason>(
            bucket.rejectedByReason,
            REJECTION_REASON_SET,
            `Baseline record ${index} hour rejection reasons`,
          );
          if (!Array.isArray(bucket.disqualificationReasons)
            || bucket.disqualificationReasons.length > BASELINE_HOUR_DISQUALIFICATION_REASONS.length
            || bucket.disqualificationReasons.some((reason) => typeof reason !== "string" || !HOUR_DISQUALIFICATION_REASON_SET.has(reason))
            || new Set(bucket.disqualificationReasons).size !== bucket.disqualificationReasons.length) {
            throw new Error(`Baseline record ${index} hour disqualification reasons are invalid`);
          }
          disqualificationReasons = [...bucket.disqualificationReasons] as BaselineHourDisqualificationReason[];
        } else {
          const legacyRejected = Math.max(0, expected - valid);
          rejectedByReason = legacyRejected > 0 ? { "legacy-unclassified": legacyRejected } : {};
          disqualificationReasons = hasExposureAccounting && bucket.eligible === true
            ? []
            : ["legacy-unclassified"];
        }
        const rejectedVisits = Object.values(rejectedByReason).reduce((total, count) => total + (count ?? 0), 0);
        if (rejectedVisits > expected - valid) throw new Error(`Baseline record ${index} hour rejection counts exceed missing visits`);
        previousHour = hourStartMs;
        return {
          hourStartMs,
          valid,
          expected,
          validExposureMs,
          firstValidAtMs,
          lastValidAtMs,
          rejectedByReason,
          disqualificationReasons,
        };
      });
      if (raw.lifecycle === "protected" && (protectedAtMs === undefined || median.byteLength === 0)) throw new Error(`Protected baseline record ${index} is incomplete`);
      return {
        fingerprintId,
        fingerprint,
        targetId: fingerprint.targetId,
        generation,
        lifecycle: raw.lifecycle as Exclude<BaselineLifecycle, "stale">,
        createdAtMs,
        firstObservationAtMs,
        lastObservationAtMs,
        protectedAtMs,
        protectedBy: typeof raw.protectedBy === "string" ? raw.protectedBy : undefined,
        totalValidObservations,
        totalExpectedVisits,
        reservoirSeen,
        reservoirCount,
        binCount,
        reservoir,
        median,
        mad,
        derivedDirty: false,
        hourBuckets,
      };
    });
  }

  static fingerprintId(fingerprint: BaselineFingerprint): string {
    return baselineFingerprintId(fingerprint);
  }

  get checkpointStatus(): { inFlight: boolean; pendingLatest: boolean; writes: number; coalesced: number; error?: string } {
    return {
      inFlight: this.checkpointPromise !== null,
      pendingLatest: this.dirty,
      writes: this.checkpointWrites,
      coalesced: this.coalescedCheckpoints,
      error: this.checkpointError?.message,
    };
  }

  list(targetId?: string): BaselineDescriptor[] {
    return this.records
      .filter((record) => targetId === undefined || record.targetId === targetId)
      .sort((left, right) => left.targetId.localeCompare(right.targetId) || left.generation - right.generation)
      .map((record) => this.descriptor(record));
  }

  getAllocationBytes(): number {
    return this.records.reduce((total, record) => total
      + record.reservoir.byteLength
      + record.median.byteLength
      + record.mad.byteLength
      + Buffer.byteLength(JSON.stringify(record.fingerprint))
      + record.hourBuckets.reduce((bucketTotal, bucket) => bucketTotal
        + 96
        + Buffer.byteLength(JSON.stringify(bucket.rejectedByReason))
        + Buffer.byteLength(JSON.stringify(bucket.disqualificationReasons)), 0)
      + 256, 0);
  }

  evidenceReference(fingerprintId: string, generation?: number): object | undefined {
    const record = this.records
      .filter((candidate) => candidate.fingerprintId === fingerprintId && (generation === undefined || candidate.generation === generation))
      .sort((left, right) => right.generation - left.generation)[0];
    if (!record) return undefined;
    this.derive(record);
    return {
      schemaVersion: 1,
      descriptor: this.descriptor(record),
      fingerprint: record.fingerprint,
      arrays: {
        encoding: "uint8-base64",
        binCount: record.binCount,
        medianBase64: Buffer.from(record.median).toString("base64"),
        madBase64: Buffer.from(record.mad).toString("base64"),
      },
    };
  }

  resolve(fingerprint: BaselineFingerprint): BaselineSelection {
    const canonical = this.canonicalForStore(fingerprint);
    const fingerprintId = baselineFingerprintId(canonical);
    const exact = this.latestExact(fingerprintId);
    if (exact) return { lifecycle: exact.lifecycle, baseline: this.snapshot(exact) };
    const previous = this.records
      .filter((record) => record.targetId === canonical.targetId)
      .sort((left, right) => right.generation - left.generation)
      .map((record) => this.descriptor(record));
    return { lifecycle: "stale", requestedFingerprintId: fingerprintId, targetId: canonical.targetId, previous };
  }

  ensure(fingerprint: BaselineFingerprint): BaselineDescriptor {
    const canonical = this.canonicalForStore(fingerprint);
    const fingerprintId = baselineFingerprintId(canonical);
    const exact = this.latestExact(fingerprintId);
    if (exact) return this.descriptor(exact);
    const targetIds = new Set(this.records.map((record) => record.targetId));
    if (!targetIds.has(canonical.targetId) && targetIds.size >= this.maxTargets) throw new Error(`Baseline target limit ${this.maxTargets} reached`);
    this.removeMutableRecords(canonical.targetId);
    const record = this.newRecord(canonical, fingerprintId);
    this.records.push(record);
    this.markDirty();
    return this.descriptor(record);
  }

  observe(fingerprint: BaselineFingerprint, bins: Uint8Array, options: ObservationOptions = {}): BaselineDescriptor {
    if (!(bins instanceof Uint8Array) || bins.byteLength === 0 || bins.byteLength > MAX_BIN_COUNT) throw new Error(`Baseline observation must contain 1-${MAX_BIN_COUNT} uint8 bins`);
    const record = this.mutableExact(fingerprint);
    const atMs = timestampMs(options.observedAt, this.now());
    const expectedVisits = positiveInteger(options.expectedVisits ?? 1, "expectedVisits");
    const exposureMs = nonNegativeInteger(options.exposureMs ?? 0, "exposureMs");
    if (record.binCount === 0) {
      record.binCount = bins.byteLength;
      record.reservoir = new Uint8Array(this.reservoirCapacity * record.binCount);
      record.median = new Uint8Array(record.binCount);
      record.mad = new Uint8Array(record.binCount);
    } else if (bins.byteLength !== record.binCount) {
      throw new Error(`Observation bin count ${bins.byteLength} does not match baseline grid ${record.binCount}`);
    }
    record.totalValidObservations += 1;
    record.totalExpectedVisits += expectedVisits;
    record.reservoirSeen += 1;
    if (record.reservoirCount < this.reservoirCapacity) {
      record.reservoir.set(bins, record.reservoirCount * record.binCount);
      record.reservoirCount += 1;
    } else {
      const random = this.random();
      if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error("random() must return a finite value in [0, 1)");
      const replacement = Math.floor(random * record.reservoirSeen);
      if (replacement < this.reservoirCapacity) record.reservoir.set(bins, replacement * record.binCount);
    }
    record.firstObservationAtMs = record.firstObservationAtMs === undefined ? atMs : Math.min(record.firstObservationAtMs, atMs);
    record.lastObservationAtMs = record.lastObservationAtMs === undefined ? atMs : Math.max(record.lastObservationAtMs, atMs);
    this.updateHour(record, atMs, 1, expectedVisits, exposureMs);
    record.derivedDirty = true;
    this.updateLifecycle(record);
    this.markDirty();
    return this.descriptor(record);
  }

  recordGap(fingerprint: BaselineFingerprint, options: GapOptions): BaselineDescriptor {
    const record = this.mutableExact(fingerprint);
    const atMs = timestampMs(options.observedAt, this.now());
    const missedVisits = positiveInteger(options.missedVisits ?? 1, "missedVisits");
    record.totalExpectedVisits += missedVisits;
    this.updateHour(record, atMs, 0, missedVisits, 0, options.reason, options.disqualifyHourReason);
    this.updateLifecycle(record);
    this.markDirty();
    return this.descriptor(record);
  }

  restart(fingerprint: BaselineFingerprint, expectedGeneration: number): BaselineDescriptor {
    const canonical = this.canonicalForStore(fingerprint);
    const fingerprintId = baselineFingerprintId(canonical);
    const current = this.latestExact(fingerprintId);
    if (!current) throw new BaselineFingerprintConflictError(fingerprintId);
    if (current.generation !== expectedGeneration) throw new BaselineGenerationConflictError(current.generation);
    const nextGeneration = this.records.reduce(
      (maximum, record) => record.targetId === canonical.targetId ? Math.max(maximum, record.generation) : maximum,
      0,
    ) + 1;
    this.removeMutableRecords(canonical.targetId);
    const record = this.newRecord(canonical, fingerprintId);
    record.generation = nextGeneration;
    this.records.push(record);
    this.markDirty();
    return this.descriptor(record);
  }

  /**
   * Commits one new active learning generation to disk before returning. A
   * failure before rename restores memory. A post-rename durability failure is
   * surfaced separately so the transaction journal can recover it safely.
   */
  async restartAndFlush(fingerprint: BaselineFingerprint, expectedGeneration: number): Promise<BaselineDescriptor> {
    await this.flush();
    const before = this.serialize();
    let descriptor: BaselineDescriptor | undefined;
    try {
      descriptor = this.restart(fingerprint, expectedGeneration);
      await this.flush();
      return descriptor;
    } catch (error) {
      if (error instanceof AtomicWriteRenamedError && descriptor) {
        // The replacement is observable and may survive a crash. Preserve the
        // new in-memory selection and force the transaction journal to decide
        // it on restart instead of falsely rolling back only memory.
        this.dirty = false;
        this.checkpointError = null;
        throw new BaselineRestartCommitUncertainError(descriptor, { cause: error });
      }
      const restored = BaselineStore.parseFile(before, this.reservoirCapacity, this.maxHourBuckets, this.dataDomain);
      this.records.splice(0, this.records.length, ...restored);
      this.dirty = false;
      throw error;
    }
  }

  approve(options: {
    fingerprint: BaselineFingerprint;
    expectedFingerprintId: string;
    expectedGeneration: number;
    approvedBy?: string;
  }): BaselineDescriptor {
    const canonical = this.canonicalForStore(options.fingerprint);
    const fingerprintId = baselineFingerprintId(canonical);
    if (fingerprintId !== options.expectedFingerprintId) throw new BaselineFingerprintConflictError(fingerprintId);
    const record = this.latestExact(fingerprintId);
    if (!record) throw new BaselineFingerprintConflictError(fingerprintId);
    if (record.generation !== options.expectedGeneration) throw new BaselineGenerationConflictError(record.generation);
    this.updateLifecycle(record);
    if (record.lifecycle !== "reviewable") throw new BaselineNotReviewableError(record.lifecycle);
    this.derive(record);
    record.lifecycle = "protected";
    record.protectedAtMs = this.now();
    record.protectedBy = options.approvedBy;
    // A protected version only needs compact derived arrays and metadata. Dropping
    // learning rows makes immutability explicit and bounds retained history.
    record.reservoir = new Uint8Array(0);
    record.reservoirCount = 0;
    record.derivedDirty = false;
    this.markDirty();
    return this.descriptor(record);
  }

  async flush(): Promise<void> {
    if (this.dirty && this.checkpointPromise === null) this.startCheckpoint();
    while (this.checkpointPromise !== null) {
      const current = this.checkpointPromise;
      await current;
      if (this.checkpointError) throw this.checkpointError;
      if (this.dirty && this.checkpointPromise === null) this.startCheckpoint();
    }
    if (this.checkpointError) throw this.checkpointError;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  async confirmStorageDurability(): Promise<void> {
    await syncStorageDirectory(this.filePath);
  }

  private newRecord(fingerprint: BaselineFingerprint, fingerprintId: string): BaselineRecord {
    const generation = this.records.reduce((maximum, record) => record.targetId === fingerprint.targetId ? Math.max(maximum, record.generation) : maximum, 0) + 1;
    return {
      fingerprintId,
      fingerprint,
      targetId: fingerprint.targetId,
      generation,
      lifecycle: "learning",
      createdAtMs: this.now(),
      totalValidObservations: 0,
      totalExpectedVisits: 0,
      reservoirSeen: 0,
      reservoirCount: 0,
      binCount: 0,
      reservoir: new Uint8Array(0),
      median: new Uint8Array(0),
      mad: new Uint8Array(0),
      derivedDirty: false,
      hourBuckets: [],
    };
  }

  private canonicalForStore(fingerprint: BaselineFingerprint): BaselineFingerprint {
    const canonical = canonicalFingerprint(fingerprint);
    if (canonical.dataDomain !== this.dataDomain) {
      throw new Error(`Baseline fingerprint belongs to ${canonical.dataDomain ?? "an unscoped"} data, not ${this.dataDomain}`);
    }
    return canonical;
  }

  private removeMutableRecords(targetId: string): void {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index].targetId === targetId && this.records[index].lifecycle !== "protected") this.records.splice(index, 1);
    }
  }

  private latestExact(fingerprintId: string): BaselineRecord | undefined {
    return this.records
      .filter((record) => record.fingerprintId === fingerprintId)
      .sort((left, right) => right.generation - left.generation)[0];
  }

  private mutableExact(fingerprint: BaselineFingerprint): BaselineRecord {
    const fingerprintId = baselineFingerprintId(this.canonicalForStore(fingerprint));
    const record = this.latestExact(fingerprintId);
    if (!record) throw new BaselineFingerprintConflictError(fingerprintId);
    if (record.lifecycle === "protected") throw new ProtectedBaselineImmutableError();
    return record;
  }

  private updateHour(
    record: BaselineRecord,
    atMs: number,
    valid: number,
    expected: number,
    validExposureMs: number,
    rejectionReason?: BaselineRejectionReason,
    disqualifyHourReason?: BaselineHourDisqualificationReason,
  ): void {
    const hourStartMs = Math.floor(atMs / HOUR_MS) * HOUR_MS;
    const existing = record.hourBuckets.find((bucket) => bucket.hourStartMs === hourStartMs);
    if (existing) {
      existing.valid += valid;
      existing.expected += expected;
      existing.validExposureMs += validExposureMs;
      if (valid > 0) {
        existing.firstValidAtMs = existing.firstValidAtMs === undefined ? atMs : Math.min(existing.firstValidAtMs, atMs);
        existing.lastValidAtMs = existing.lastValidAtMs === undefined ? atMs : Math.max(existing.lastValidAtMs, atMs);
      }
      if (rejectionReason) incrementReason(existing.rejectedByReason, rejectionReason, expected);
      if (disqualifyHourReason && !existing.disqualificationReasons.includes(disqualifyHourReason)) {
        existing.disqualificationReasons.push(disqualifyHourReason);
        existing.disqualificationReasons.sort();
      }
    } else {
      record.hourBuckets.push({
        hourStartMs,
        valid,
        expected,
        validExposureMs,
        ...(valid > 0 ? { firstValidAtMs: atMs, lastValidAtMs: atMs } : {}),
        rejectedByReason: rejectionReason ? { [rejectionReason]: expected } : {},
        disqualificationReasons: disqualifyHourReason ? [disqualifyHourReason] : [],
      });
      record.hourBuckets.sort((left, right) => left.hourStartMs - right.hourStartMs);
      if (record.hourBuckets.length > this.maxHourBuckets) record.hourBuckets.splice(0, record.hourBuckets.length - this.maxHourBuckets);
    }
  }

  private representativeHours(record: BaselineRecord): number {
    return record.hourBuckets.filter((bucket) =>
      bucket.disqualificationReasons.length === 0
      && bucket.valid >= this.representativeHourMinimumObservations
      && bucket.expected > 0
      && bucket.valid / bucket.expected >= this.provisionalMinimumCoverage
      && bucket.validExposureMs >= this.representativeHourMinimumExposureMs
      && bucket.firstValidAtMs !== undefined
      && bucket.lastValidAtMs !== undefined
      && bucket.lastValidAtMs - bucket.firstValidAtMs >= this.representativeHourMinimumSpanMs
    ).length;
  }

  private updateLifecycle(record: BaselineRecord): void {
    if (record.lifecycle === "protected") return;
    const duration = record.firstObservationAtMs === undefined || record.lastObservationAtMs === undefined
      ? 0
      : record.lastObservationAtMs - record.firstObservationAtMs;
    const coverage = record.totalExpectedVisits === 0 ? 0 : record.totalValidObservations / record.totalExpectedVisits;
    const provisional = duration >= this.provisionalMinimumMs
      && record.totalValidObservations >= this.provisionalMinimumObservations
      && coverage >= this.provisionalMinimumCoverage;
    if (!provisional) record.lifecycle = "learning";
    else if (this.representativeHours(record) >= this.reviewableMinimumUtcHours) record.lifecycle = "reviewable";
    else record.lifecycle = "provisional";
  }

  private descriptor(record: BaselineRecord): BaselineDescriptor {
    const rejectedByReason: Partial<Record<BaselineRejectionReason, number>> = {};
    const disqualifiedByReason: Partial<Record<BaselineHourDisqualificationReason, number>> = {};
    for (const bucket of record.hourBuckets) {
      for (const [reason, count] of Object.entries(bucket.rejectedByReason) as Array<[BaselineRejectionReason, number]>) {
        incrementReason(rejectedByReason, reason, count);
      }
      for (const reason of bucket.disqualificationReasons) incrementReason(disqualifiedByReason, reason, 1);
    }
    return {
      fingerprintId: record.fingerprintId,
      fingerprint: structuredClone(record.fingerprint),
      targetId: record.targetId,
      generation: record.generation,
      lifecycle: record.lifecycle,
      createdAt: new Date(record.createdAtMs).toISOString(),
      firstObservationAt: iso(record.firstObservationAtMs),
      lastObservationAt: iso(record.lastObservationAtMs),
      protectedAt: iso(record.protectedAtMs),
      protectedBy: record.protectedBy,
      totalValidObservations: record.totalValidObservations,
      totalExpectedVisits: record.totalExpectedVisits,
      coverageRatio: record.totalExpectedVisits === 0 ? 0 : record.totalValidObservations / record.totalExpectedVisits,
      representativeUtcHours: this.representativeHours(record),
      reservoirCount: record.reservoirCount,
      reservoirSeen: record.reservoirSeen,
      binCount: record.binCount,
      learningExclusions: {
        rejectedVisits: Object.values(rejectedByReason).reduce((total, count) => total + (count ?? 0), 0),
        rejectedByReason,
        disqualifiedHours: record.hourBuckets.filter((bucket) => bucket.disqualificationReasons.length > 0).length,
        disqualifiedByReason,
      },
    };
  }

  private snapshot(record: BaselineRecord): BaselineSnapshot {
    this.derive(record);
    return { ...this.descriptor(record), median: record.median.slice(), mad: record.mad.slice() };
  }

  private derive(record: BaselineRecord): void {
    if (!record.derivedDirty || record.reservoirCount === 0) return;
    if (this.scratch.byteLength < record.reservoirCount) this.scratch = new Uint8Array(record.reservoirCount);
    const scratch = this.scratch.subarray(0, record.reservoirCount);
    for (let bin = 0; bin < record.binCount; bin += 1) {
      for (let row = 0; row < record.reservoirCount; row += 1) scratch[row] = record.reservoir[row * record.binCount + bin];
      scratch.sort();
      const median = scratch[Math.floor((record.reservoirCount - 1) / 2)];
      record.median[bin] = median;
      for (let row = 0; row < record.reservoirCount; row += 1) {
        scratch[row] = Math.abs(record.reservoir[row * record.binCount + bin] - median);
      }
      scratch.sort();
      record.mad[bin] = scratch[Math.floor((record.reservoirCount - 1) / 2)];
    }
    record.derivedDirty = false;
  }

  private serialize(): PersistedBaselineFile {
    const records: PersistedBaselineRecord[] = this.records.map((record) => {
      this.derive(record);
      const usedReservoir = record.reservoir.subarray(0, record.reservoirCount * record.binCount);
      return {
        fingerprintId: record.fingerprintId,
        fingerprint: structuredClone(record.fingerprint),
        targetId: record.targetId,
        generation: record.generation,
        lifecycle: record.lifecycle,
        createdAt: new Date(record.createdAtMs).toISOString(),
        firstObservationAt: iso(record.firstObservationAtMs),
        lastObservationAt: iso(record.lastObservationAtMs),
        protectedAt: iso(record.protectedAtMs),
        protectedBy: record.protectedBy,
        totalValidObservations: record.totalValidObservations,
        totalExpectedVisits: record.totalExpectedVisits,
        reservoirSeen: record.reservoirSeen,
        reservoirCount: record.reservoirCount,
        binCount: record.binCount,
        reservoirBase64: encodeBase64(usedReservoir),
        medianBase64: encodeBase64(record.median),
        madBase64: encodeBase64(record.mad),
        hourBuckets: record.hourBuckets.map((bucket) => ({ ...bucket })),
      };
    });
    return { schemaVersion: FILE_SCHEMA_VERSION, dataDomain: this.dataDomain, updatedAt: new Date(this.now()).toISOString(), records };
  }

  private markDirty(): void {
    if (this.checkpointPromise !== null && this.dirty) this.coalescedCheckpoints += 1;
    this.dirty = true;
    if (this.checkpointPromise === null) this.startCheckpoint();
  }

  private startCheckpoint(): void {
    if (this.checkpointPromise !== null || !this.dirty) return;
    this.checkpointPromise = this.checkpointLoop()
      .catch((error: unknown) => {
        this.dirty = true;
        this.checkpointError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        this.checkpointPromise = null;
      });
  }

  private async checkpointLoop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const snapshot = this.serialize();
      await writeAtomic(this.filePath, snapshot, this.injectAtomicWriteFault);
      this.checkpointWrites += 1;
      this.checkpointError = null;
    }
  }
}
