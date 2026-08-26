import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { normalizeReceiverSerial, parseReportedReceiverModel, type SupportedReceiverModel } from "../shared/productContract";
import type { CommissioningHealth, CurrentMonitoringHealth, ProductionQualification, ProductionQualificationHistoryEntry, RuntimeIdentity } from "../shared/types";

const MAX_QUALIFICATION_EPOCHS = 16;
const MAX_QUALIFICATION_FAULTS = 128;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const DEVELOPMENT_QUALIFICATION_WINDOW_MS = 24 * 60 * 60_000;

export interface QualificationApprovalRecordV1 {
  schemaVersion: 1;
  kind: "rf-monitor-production-qualification-approval";
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  qualificationBundleSha256: string;
  release: {
    buildId: string;
    serverBuildId: string;
    clientBuildId: string;
    sourceDigest: string;
    packageDigest: string;
    dependencyLockDigest: string;
  };
  configuration: {
    configurationHash: string;
    catalogVersion: string;
  };
  site: {
    deploymentId: string;
    bindingHash: string;
  };
  receiver: {
    model: SupportedReceiverModel;
    serialSha256: string;
  };
  commissioning: {
    epochId: string;
    soakStartedAt: string;
  };
  gates: {
    installedChainQualified: boolean;
    timingAndBaselineQualified: boolean;
    hardwareRecoveryQualified: boolean;
    faultInjectionQualified: boolean;
    evidenceContinuityQualified: boolean;
    /** Optional V8 site-assurance result retained for approval-record compatibility. */
    clean72HourSoakQualified?: boolean;
    /** Optional V9 site-assurance result retained for approval-record compatibility. */
    controlledPilotQualified?: boolean;
  };
  recordDigest: string;
}

export type UnsignedQualificationApprovalRecordV1 = Omit<QualificationApprovalRecordV1, "recordDigest">;

export interface QualificationSiteIdentity {
  siteName: string;
  deploymentId?: string;
}

export interface QualificationReceiverIdentity {
  model?: string;
  serial?: string;
}

interface PersistedQualification extends ProductionQualification {
  activeFaultCodes: string[];
}

interface QualificationLedgerFile {
  schemaVersion: 1;
  epochs: PersistedQualification[];
}

export interface ProductionQualificationStoreOptions {
  /**
   * Test seam for the durable ledger boundary. A successful implementation must
   * return only after the supplied contents are durably committed at filePath.
   */
  writeLedger?: (filePath: string, contents: string) => Promise<void>;
  /** Root/site-owner managed input. RF Monitor never creates or mutates it. */
  approvalRecordPath?: string;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function qualificationSiteBindingHash(site: QualificationSiteIdentity): string | undefined {
  const siteName = typeof site.siteName === "string" ? site.siteName.trim() : "";
  const deploymentId = typeof site.deploymentId === "string" ? site.deploymentId.trim() : "";
  if (!siteName || !deploymentId || siteName.length > 80 || deploymentId.length > 160) return undefined;
  return canonicalHash({ deploymentId, siteName });
}

export function qualificationReceiverIdentityHash(receiver: QualificationReceiverIdentity): string | undefined {
  const model = parseReportedReceiverModel(receiver.model);
  const serial = normalizeReceiverSerial(receiver.serial);
  return model && serial ? canonicalHash({ model, serial }) : undefined;
}

export function qualificationReceiverSerialHash(value: unknown): string | undefined {
  const serial = normalizeReceiverSerial(value);
  return serial ? createHash("sha256").update(serial).digest("hex") : undefined;
}

function approvalPayload(record: UnsignedQualificationApprovalRecordV1): UnsignedQualificationApprovalRecordV1 {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    approvalId: record.approvalId,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    qualificationBundleSha256: record.qualificationBundleSha256,
    release: {
      buildId: record.release.buildId,
      serverBuildId: record.release.serverBuildId,
      clientBuildId: record.release.clientBuildId,
      sourceDigest: record.release.sourceDigest,
      packageDigest: record.release.packageDigest,
      dependencyLockDigest: record.release.dependencyLockDigest,
    },
    configuration: {
      configurationHash: record.configuration.configurationHash,
      catalogVersion: record.configuration.catalogVersion,
    },
    site: {
      deploymentId: record.site.deploymentId,
      bindingHash: record.site.bindingHash,
    },
    receiver: {
      model: record.receiver.model,
      serialSha256: record.receiver.serialSha256,
    },
    commissioning: {
      epochId: record.commissioning.epochId,
      soakStartedAt: record.commissioning.soakStartedAt,
    },
    gates: {
      installedChainQualified: record.gates.installedChainQualified,
      timingAndBaselineQualified: record.gates.timingAndBaselineQualified,
      hardwareRecoveryQualified: record.gates.hardwareRecoveryQualified,
      faultInjectionQualified: record.gates.faultInjectionQualified,
      ...(record.gates.clean72HourSoakQualified !== undefined
        ? { clean72HourSoakQualified: record.gates.clean72HourSoakQualified }
        : {}),
      evidenceContinuityQualified: record.gates.evidenceContinuityQualified,
      ...(record.gates.controlledPilotQualified !== undefined
        ? { controlledPilotQualified: record.gates.controlledPilotQualified }
        : {}),
    },
  };
}

export function qualificationApprovalRecordDigest(record: UnsignedQualificationApprovalRecordV1): string {
  return canonicalHash(approvalPayload(record));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeIdentifier(value: unknown, maximum = 160): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && /^[A-Za-z0-9][A-Za-z0-9:+._@/-]*$/.test(value);
}

function parseApprovalRecord(value: unknown): QualificationApprovalRecordV1 {
  if (!isPlainRecord(value) || !exactKeys(value, [
    "schemaVersion", "kind", "approvalId", "approvedBy", "approvedAt", "qualificationBundleSha256",
    "release", "configuration", "site", "receiver", "commissioning", "gates", "recordDigest",
  ])) throw new Error("Qualification approval record has an invalid top-level schema");
  const release = value.release;
  const configuration = value.configuration;
  const site = value.site;
  const receiver = value.receiver;
  const commissioning = value.commissioning;
  const gates = value.gates;
  if (!isPlainRecord(release) || !exactKeys(release, ["buildId", "serverBuildId", "clientBuildId", "sourceDigest", "packageDigest", "dependencyLockDigest"])) throw new Error("Qualification approval release binding is invalid");
  if (!isPlainRecord(configuration) || !exactKeys(configuration, ["configurationHash", "catalogVersion"])) throw new Error("Qualification approval configuration binding is invalid");
  if (!isPlainRecord(site) || !exactKeys(site, ["deploymentId", "bindingHash"])) throw new Error("Qualification approval site binding is invalid");
  if (!isPlainRecord(receiver) || !exactKeys(receiver, ["model", "serialSha256"])) throw new Error("Qualification approval receiver binding is invalid");
  if (!isPlainRecord(commissioning) || !exactKeys(commissioning, ["epochId", "soakStartedAt"])) throw new Error("Qualification approval commissioning binding is invalid");
  const requiredGateKeys = [
    "installedChainQualified", "timingAndBaselineQualified", "hardwareRecoveryQualified",
    "faultInjectionQualified", "evidenceContinuityQualified",
  ] as const;
  const optionalGateKeys = ["clean72HourSoakQualified", "controlledPilotQualified"] as const;
  const allowedGateKeys = new Set<string>([...requiredGateKeys, ...optionalGateKeys]);
  if (!isPlainRecord(gates)
    || requiredGateKeys.some((key) => !(key in gates))
    || Object.keys(gates).some((key) => !allowedGateKeys.has(key))) {
    throw new Error("Qualification approval gates are invalid");
  }
  const model = parseReportedReceiverModel(receiver.model);
  const record = value as unknown as QualificationApprovalRecordV1;
  if (
    record.schemaVersion !== 1
    || record.kind !== "rf-monitor-production-qualification-approval"
    || !safeIdentifier(record.approvalId)
    || typeof record.approvedBy !== "string" || !record.approvedBy.trim() || record.approvedBy.length > 160 || /[\u0000-\u001f\u007f]/.test(record.approvedBy)
    || !validTimestamp(record.approvedAt)
    || !HASH_PATTERN.test(record.qualificationBundleSha256)
    || !safeIdentifier(record.release.buildId) || !safeIdentifier(record.release.serverBuildId) || !safeIdentifier(record.release.clientBuildId)
    || !HASH_PATTERN.test(record.release.sourceDigest) || !HASH_PATTERN.test(record.release.packageDigest) || !HASH_PATTERN.test(record.release.dependencyLockDigest)
    || !HASH_PATTERN.test(record.configuration.configurationHash) || !safeIdentifier(record.configuration.catalogVersion)
    || !safeIdentifier(record.site.deploymentId) || !HASH_PATTERN.test(record.site.bindingHash)
    || !model || receiver.model !== model || !HASH_PATTERN.test(record.receiver.serialSha256)
    || !safeIdentifier(record.commissioning.epochId) || !validTimestamp(record.commissioning.soakStartedAt)
    || requiredGateKeys.some((key) => typeof record.gates[key] !== "boolean")
    || optionalGateKeys.some((key) => record.gates[key] !== undefined && typeof record.gates[key] !== "boolean")
    || !HASH_PATTERN.test(record.recordDigest)
  ) throw new Error("Qualification approval record contains an invalid value");
  const { recordDigest, ...unsigned } = record;
  if (qualificationApprovalRecordDigest(unsigned) !== recordDigest) throw new Error("Qualification approval record digest does not match");
  return structuredClone(record);
}

function boundedCodes(values: readonly string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().slice(0, 160))
    .filter((value) => /^[A-Za-z0-9:._-]+$/.test(value)))]
    .sort()
    .slice(0, MAX_QUALIFICATION_FAULTS);
}

function cloneQualification(value: PersistedQualification): ProductionQualification {
  const { activeFaultCodes: _activeFaultCodes, ...result } = value;
  const faults = result.faults.slice(-32);
  return structuredClone({
    ...result,
    blockers: result.blockers.slice(-32),
    faults,
    faultCount: result.faults.length,
    faultsTruncated: faults.length !== result.faults.length,
  });
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseLedger(value: unknown): PersistedQualification[] {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error("Qualification ledger has an unsupported schema version");
  }
  const epochs = (value as { epochs?: unknown }).epochs;
  if (!Array.isArray(epochs) || epochs.length > MAX_QUALIFICATION_EPOCHS) throw new Error("Qualification ledger exceeds its epoch bound");
  return epochs.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Qualification ledger contains an invalid epoch");
    const entry = raw as PersistedQualification;
    if (
      entry.schemaVersion !== 1
      || typeof entry.epochId !== "string"
      || typeof entry.fingerprint !== "string"
      || !["simulation", "pending", "failed", "qualified"].includes(entry.state)
      || typeof entry.ready !== "boolean"
      || !validTimestamp(entry.startedAt)
      || !validTimestamp(entry.updatedAt)
      || !Array.isArray(entry.faults)
      || entry.faults.length > MAX_QUALIFICATION_FAULTS
      || !Array.isArray(entry.activeFaultCodes)
    ) throw new Error("Qualification ledger contains an invalid epoch");
    const parsed = structuredClone(entry);
    const requirements = parsed.requirements as Partial<ProductionQualification["requirements"]> | undefined;
    const requiredRequirementKeys: Array<keyof ProductionQualification["requirements"]> = [
      "immutableRelease", "clientServerBuildMatch", "productionSampleRate", "sampleRateConfirmed",
      "physicalReceiver", "supportedReceiverModel", "stableReceiverIdentity", "protectedBaselines",
      "scanObjectives", "cleanResourceSoak", "soakComplete", "externalApproval",
      "installedChainQualified", "timingAndBaselineQualified", "hardwareRecoveryQualified",
      "faultQualification", "evidenceContinuityQualified",
    ];
    const currentContract = Boolean(requirements)
      && requiredRequirementKeys.every((key) => typeof requirements?.[key] === "boolean");
    parsed.requirements = {
      immutableRelease: false,
      clientServerBuildMatch: false,
      productionSampleRate: false,
      sampleRateConfirmed: false,
      physicalReceiver: false,
      supportedReceiverModel: false,
      stableReceiverIdentity: false,
      protectedBaselines: false,
      scanObjectives: false,
      cleanResourceSoak: false,
      soakComplete: false,
      externalApproval: false,
      installedChainQualified: false,
      timingAndBaselineQualified: false,
      hardwareRecoveryQualified: false,
      faultQualification: false,
      evidenceContinuityQualified: false,
      ...requirements,
      clean72HourSoakQualified: typeof requirements?.clean72HourSoakQualified === "boolean"
        ? requirements.clean72HourSoakQualified
        : false,
      controlledPilotQualified: typeof requirements?.controlledPilotQualified === "boolean"
        ? requirements.controlledPilotQualified
        : false,
    };
    if (!currentContract) {
      parsed.ready = false;
      if (parsed.state === "qualified") parsed.state = "pending";
      parsed.blockers = boundedCodes([...(Array.isArray(parsed.blockers) ? parsed.blockers : []), "qualification-contract-upgrade-pending"]);
    }
    return parsed;
  });
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
    // The file fsync makes its contents durable; syncing the parent directory
    // makes the rename itself durable across a host crash or power loss.
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface QualificationObservation {
  identity: RuntimeIdentity;
  commissioning: CommissioningHealth;
  protectedBaselinesReady: boolean;
  site: QualificationSiteIdentity;
  receiver: QualificationReceiverIdentity;
  evaluatedAt?: string;
}

/** Authoritative API/compatibility readiness rule. Current health alone never qualifies a site. */
export function qualificationRecordReady(
  qualification: Pick<ProductionQualification, "state" | "ready" | "requirements">,
): boolean {
  return qualification.state === "qualified"
    && qualification.ready
    && qualification.requirements.externalApproval
    && qualification.requirements.installedChainQualified
    && qualification.requirements.timingAndBaselineQualified
    && qualification.requirements.hardwareRecoveryQualified
    && qualification.requirements.faultQualification
    && qualification.requirements.evidenceContinuityQualified;
}

export function productionReadyForHealth(
  currentHealth: Pick<CurrentMonitoringHealth, "ready">,
  qualification: Pick<ProductionQualification, "state" | "ready" | "requirements">,
): boolean {
  return currentHealth.ready && qualificationRecordReady(qualification);
}

/**
 * Bounded, latest-only persistence for qualification epochs. Current health is
 * intentionally not stored here: a previously healthy process cannot make a
 * failed current receiver path appear ready.
 */
export class ProductionQualificationStore {
  private epochs: PersistedQualification[] = [];
  private persistenceError?: string;
  private approvalRecord?: QualificationApprovalRecordV1;
  private approvalRecordError = "external-qualification-approval-missing";
  private readonly observedFingerprints = new Set<string>();
  private ledgerRevision = 0;
  private durableRevision = 0;
  private writePending = false;
  private writeInFlight?: Promise<void>;

  private constructor(
    private readonly filePath: string,
    private readonly writeLedger: (filePath: string, contents: string) => Promise<void>,
  ) {}

  static async open(
    filePath: string,
    options: ProductionQualificationStoreOptions = {},
  ): Promise<ProductionQualificationStore> {
    const store = new ProductionQualificationStore(path.resolve(filePath), options.writeLedger ?? writeAtomic);
    try {
      store.epochs = parseLedger(JSON.parse(await readFile(store.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") store.persistenceError = "qualification-ledger-unavailable";
    }
    if (options.approvalRecordPath) {
      try {
        store.approvalRecord = parseApprovalRecord(JSON.parse(await readFile(path.resolve(options.approvalRecordPath), "utf8")));
        store.approvalRecordError = "";
      } catch (error) {
        store.approvalRecordError = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "external-qualification-approval-missing"
          : "external-qualification-approval-invalid";
      }
    }
    return store;
  }

  observe(input: QualificationObservation): ProductionQualification {
    const at = input.evaluatedAt ?? new Date().toISOString();
    const { identity, commissioning } = input;
    const receiverModel = parseReportedReceiverModel(input.receiver.model);
    const receiverModelReported = typeof input.receiver.model === "string" && input.receiver.model.trim().length > 0;
    const receiverSerial = normalizeReceiverSerial(input.receiver.serial);
    const receiverSerialSha256 = qualificationReceiverSerialHash(receiverSerial);
    const receiverIdentityHash = qualificationReceiverIdentityHash(input.receiver);
    const siteBindingHash = qualificationSiteBindingHash(input.site);
    const deploymentId = input.site.deploymentId?.trim();
    const fingerprint = canonicalHash({
      releaseBuildId: identity.release.buildId,
      serverBuildId: identity.release.serverBuildId,
      clientBuildId: identity.release.clientBuildId,
      packageDigest: identity.release.packageDigest,
      configuration: identity.configuration,
      commissioningEpochId: commissioning.epochId,
      dataDomain: commissioning.dataDomain,
      siteBindingHash: siteBindingHash ?? null,
      receiverModel: receiverModel ?? null,
      receiverIdentityHash: receiverIdentityHash ?? null,
    });
    let epoch = this.epochs.find((entry) => entry.fingerprint === fingerprint);
    let created = false;
    if (!epoch) {
      created = true;
      epoch = {
        schemaVersion: 1,
        epochId: `qualification-${fingerprint.slice(0, 20)}`,
        fingerprint,
        state: commissioning.simulation ? "simulation" : "pending",
        ready: false,
        startedAt: commissioning.soakStartedAt,
        updatedAt: at,
        releaseBuildId: identity.release.buildId,
        configurationHash: identity.configuration.configurationHash,
        commissioningEpochId: commissioning.epochId,
        ...(siteBindingHash ? { siteBindingHash } : {}),
        ...(receiverModel ? { receiverModel } : {}),
        ...(receiverIdentityHash ? { receiverIdentityHash } : {}),
        blockers: [],
        faults: [],
        activeFaultCodes: [],
        requirements: {
          immutableRelease: false,
          clientServerBuildMatch: false,
          productionSampleRate: false,
          sampleRateConfirmed: false,
          physicalReceiver: false,
          supportedReceiverModel: false,
          stableReceiverIdentity: false,
          protectedBaselines: false,
          scanObjectives: false,
          cleanResourceSoak: false,
          soakComplete: false,
          externalApproval: false,
          installedChainQualified: false,
          timingAndBaselineQualified: false,
          hardwareRecoveryQualified: false,
          faultQualification: false,
          evidenceContinuityQualified: false,
          clean72HourSoakQualified: false,
          controlledPilotQualified: false,
        },
      };
      this.epochs.push(epoch);
      this.epochs = this.epochs
        .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
        .slice(-MAX_QUALIFICATION_EPOCHS);
    }
    const before = JSON.stringify({ ...epoch, updatedAt: "" });

    const qualificationActive = commissioning.state === "qualifying"
      || commissioning.state === "invalidated"
      || commissioning.state === "qualified"
      || commissioning.soakElapsedMs > 0;
    // Defend the durable ledger against startup observations from an older or
    // concurrent runtime. SDRconnect fingerprint properties are asynchronous;
    // their absence before the qualification clock starts is Pending, not a
    // sticky failure. The same loss after start is recorded normally.
    const currentFaults = boundedCodes(commissioning.faults.filter((code) => (
      qualificationActive || code !== "rf-fingerprint-metadata-unavailable"
    )));
    const previouslyActive = new Set(epoch.activeFaultCodes);
    const byCode = new Map(epoch.faults.map((fault) => [fault.code, fault]));
    for (const code of currentFaults) {
      const existing = byCode.get(code);
      if (existing) {
        if (!previouslyActive.has(code)) {
          existing.count += 1;
          existing.lastOccurredAt = at;
        }
      } else {
        byCode.set(code, { code, count: 1, firstOccurredAt: at, lastOccurredAt: at });
      }
    }
    epoch.faults = [...byCode.values()]
      .sort((left, right) => Date.parse(left.lastOccurredAt) - Date.parse(right.lastOccurredAt))
      .slice(-MAX_QUALIFICATION_FAULTS);
    epoch.activeFaultCodes = currentFaults;
    if (siteBindingHash) epoch.siteBindingHash = siteBindingHash;
    else delete epoch.siteBindingHash;
    if (receiverModel) epoch.receiverModel = receiverModel;
    else delete epoch.receiverModel;
    if (receiverIdentityHash) epoch.receiverIdentityHash = receiverIdentityHash;
    else delete epoch.receiverIdentityHash;

    const approval = this.approvalRecord;
    const approvalBindingChecks = approval ? {
      release: approval.release.buildId === identity.release.buildId
        && approval.release.serverBuildId === identity.release.serverBuildId
        && approval.release.clientBuildId === identity.release.clientBuildId
        && approval.release.sourceDigest === identity.release.sourceDigest
        && approval.release.packageDigest === identity.release.packageDigest
        && approval.release.dependencyLockDigest === identity.release.dependencyLockDigest,
      configuration: approval.configuration.configurationHash === identity.configuration.configurationHash
        && approval.configuration.catalogVersion === identity.configuration.catalogVersion,
      site: Boolean(deploymentId && siteBindingHash)
        && approval.site.deploymentId === deploymentId
        && approval.site.bindingHash === siteBindingHash,
      receiver: Boolean(receiverModel && receiverSerialSha256)
        && approval.receiver.model === receiverModel
        && approval.receiver.serialSha256 === receiverSerialSha256,
      commissioning: approval.commissioning.epochId === commissioning.epochId
        && approval.commissioning.soakStartedAt === commissioning.soakStartedAt,
    } : undefined;
    const approvalBindingsMatch = Boolean(approvalBindingChecks && Object.values(approvalBindingChecks).every(Boolean));
    const localWindowIsExact = commissioning.soakRequiredMs === DEVELOPMENT_QUALIFICATION_WINDOW_MS;
    const approvalAfterLocalSoak = Boolean(approval
      && localWindowIsExact
      && Number.isFinite(Date.parse(commissioning.soakStartedAt))
      && Date.parse(approval.approvedAt) >= Date.parse(commissioning.soakStartedAt) + DEVELOPMENT_QUALIFICATION_WINDOW_MS);
    const developmentGates = approval ? {
      installedChain: approval.gates.installedChainQualified,
      timingAndBaseline: approval.gates.timingAndBaselineQualified,
      hardwareRecovery: approval.gates.hardwareRecoveryQualified,
      faultQualification: approval.gates.faultInjectionQualified,
      evidenceContinuity: approval.gates.evidenceContinuityQualified,
    } : undefined;
    const allDevelopmentGates = Boolean(developmentGates && Object.values(developmentGates).every(Boolean));
    const externalApproval = approvalBindingsMatch && approvalAfterLocalSoak && allDevelopmentGates;
    if (externalApproval && approval) {
      epoch.approvalRecordId = approval.approvalId;
      epoch.approvalRecordDigest = approval.recordDigest;
    } else {
      delete epoch.approvalRecordId;
      delete epoch.approvalRecordDigest;
    }
    epoch.requirements = {
      immutableRelease: identity.release.integrity === "release-metadata",
      clientServerBuildMatch: identity.release.buildId === identity.release.serverBuildId
        && identity.release.buildId === identity.release.clientBuildId,
      productionSampleRate: identity.configuration.expectedSampleRateHz === 10_000_000,
      sampleRateConfirmed: commissioning.sampleRateReady,
      physicalReceiver: !commissioning.simulation && commissioning.dataDomain === "field" && commissioning.receiverReady,
      supportedReceiverModel: Boolean(receiverModel),
      stableReceiverIdentity: Boolean(receiverIdentityHash),
      protectedBaselines: input.protectedBaselinesReady,
      scanObjectives: commissioning.scanObjectiveReady,
      cleanResourceSoak: commissioning.resourceSoakClean && epoch.faults.length === 0,
      soakComplete: localWindowIsExact && commissioning.soakElapsedMs >= DEVELOPMENT_QUALIFICATION_WINDOW_MS,
      externalApproval,
      installedChainQualified: Boolean(approvalBindingsMatch && approval?.gates.installedChainQualified),
      timingAndBaselineQualified: Boolean(approvalBindingsMatch && approval?.gates.timingAndBaselineQualified),
      hardwareRecoveryQualified: Boolean(approvalBindingsMatch && approval?.gates.hardwareRecoveryQualified),
      faultQualification: Boolean(approvalBindingsMatch && approval?.gates.faultInjectionQualified),
      evidenceContinuityQualified: Boolean(approvalBindingsMatch && approval?.gates.evidenceContinuityQualified),
      clean72HourSoakQualified: Boolean(approvalBindingsMatch && approval?.gates.clean72HourSoakQualified),
      controlledPilotQualified: Boolean(approvalBindingsMatch && approval?.gates.controlledPilotQualified),
    };
    const approvalBlocker = !approval
      ? this.approvalRecordError
      : !approvalBindingChecks?.release
        ? "external-qualification-release-mismatch"
        : !approvalBindingChecks.configuration
          ? "external-qualification-configuration-mismatch"
          : !approvalBindingChecks.site
            ? "external-qualification-site-mismatch"
            : !approvalBindingChecks.receiver
              ? "external-qualification-receiver-mismatch"
              : !approvalBindingChecks.commissioning
                ? "external-qualification-commissioning-mismatch"
                : !localWindowIsExact
                  ? "qualification-window-invalid"
                : !approvalAfterLocalSoak
                  ? "external-qualification-approved-before-soak"
                  : !allDevelopmentGates
                    ? "external-qualification-gates-incomplete"
                    : undefined;
    const blockers = [
      ...(!epoch.requirements.immutableRelease ? ["release-identity-unverified"] : []),
      ...(!epoch.requirements.clientServerBuildMatch ? ["release-build-mismatch"] : []),
      ...(!epoch.requirements.productionSampleRate ? ["experimental-sample-rate"] : []),
      ...(!epoch.requirements.sampleRateConfirmed ? ["sample-rate-unconfirmed"] : []),
      ...(!epoch.requirements.physicalReceiver ? [commissioning.simulation ? "simulation-active" : "physical-receiver-pending"] : []),
      ...(!epoch.requirements.supportedReceiverModel ? [
        commissioning.simulation
          ? "simulation-receiver-not-tested"
          : receiverModelReported
            ? "unsupported-receiver-model"
            : "receiver-model-pending",
      ] : []),
      ...(!epoch.requirements.stableReceiverIdentity ? [commissioning.simulation ? "simulation-receiver-identity-not-tested" : "receiver-identity-pending"] : []),
      ...(!epoch.requirements.protectedBaselines ? ["protected-baselines-pending"] : []),
      ...(!epoch.requirements.scanObjectives ? ["scan-objectives-pending"] : []),
      ...(!epoch.requirements.cleanResourceSoak ? ["resource-soak-not-clean"] : []),
      ...(!epoch.requirements.soakComplete ? ["qualification-soak-incomplete"] : []),
      ...(approvalBlocker ? [approvalBlocker] : []),
      ...(!epoch.requirements.installedChainQualified ? ["installed-chain-qualification-pending"] : []),
      ...(!epoch.requirements.timingAndBaselineQualified ? ["timing-baseline-qualification-pending"] : []),
      ...(!epoch.requirements.hardwareRecoveryQualified ? ["hardware-recovery-qualification-pending"] : []),
      ...(!epoch.requirements.faultQualification ? ["fault-qualification-pending"] : []),
      ...(!epoch.requirements.evidenceContinuityQualified ? ["evidence-continuity-qualification-pending"] : []),
      ...epoch.faults.map((fault) => `fault:${fault.code}`),
    ];
    epoch.blockers = boundedCodes(blockers);
    const requirementsMet = epoch.requirements.immutableRelease
      && epoch.requirements.clientServerBuildMatch
      && epoch.requirements.productionSampleRate
      && epoch.requirements.sampleRateConfirmed
      && epoch.requirements.physicalReceiver
      && epoch.requirements.supportedReceiverModel
      && epoch.requirements.stableReceiverIdentity
      && epoch.requirements.protectedBaselines
      && epoch.requirements.scanObjectives
      && epoch.requirements.cleanResourceSoak
      && epoch.requirements.soakComplete
      && epoch.requirements.externalApproval
      && epoch.requirements.installedChainQualified
      && epoch.requirements.timingAndBaselineQualified
      && epoch.requirements.hardwareRecoveryQualified
      && epoch.requirements.faultQualification
      && epoch.requirements.evidenceContinuityQualified;
    epoch.ready = !commissioning.simulation && requirementsMet && epoch.blockers.length === 0 && commissioning.ready;
    epoch.state = commissioning.simulation
      ? "simulation"
      : epoch.ready
        ? "qualified"
        : epoch.faults.length
            || !epoch.requirements.immutableRelease
            || !epoch.requirements.clientServerBuildMatch
            || !epoch.requirements.productionSampleRate
            || (!epoch.requirements.supportedReceiverModel
              && !commissioning.simulation
              && (receiverModelReported || qualificationActive))
            || this.approvalRecordError === "external-qualification-approval-invalid"
            || Boolean(approval && approvalBlocker)
          ? "failed"
          : "pending";
    const changed = created || before !== JSON.stringify({ ...epoch, updatedAt: "" });
    if (changed) {
      epoch.updatedAt = at;
      this.ledgerRevision += 1;
      this.scheduleWrite();
    } else if (!this.ledgerIsDurable() && !this.writeInFlight) {
      // A later observation is the bounded retry trigger after a failed write.
      // Only one latest snapshot is retained; there is no retry queue.
      this.scheduleWrite();
    }
    this.observedFingerprints.add(fingerprint);
    return this.publicQualification(epoch);
  }

  list(): ProductionQualification[] {
    return this.epochs.map((epoch) => this.publicQualification(epoch));
  }

  history(activeEpochId: string, limit = 8): ProductionQualificationHistoryEntry[] {
    const boundedLimit = Math.max(0, Math.min(8, Math.floor(limit)));
    return this.epochs
      .filter((epoch) => epoch.epochId !== activeEpochId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, boundedLimit)
      .map((epoch) => {
        const visible = cloneQualification(epoch);
        return {
          epochId: visible.epochId,
          state: visible.state,
          ready: visible.ready,
          startedAt: epoch.startedAt,
          updatedAt: epoch.updatedAt,
          releaseBuildId: epoch.releaseBuildId,
          configurationHash: epoch.configurationHash,
          faultCount: epoch.faults.reduce((total, fault) => total + fault.count, 0),
          recentFaultCodes: epoch.faults.slice(-8).map((fault) => fault.code),
        };
      });
  }

  async flush(): Promise<void> {
    while (this.writePending || this.writeInFlight) {
      if (this.writeInFlight) await this.writeInFlight;
      else this.scheduleWrite();
    }
  }

  private scheduleWrite(): void {
    this.writePending = true;
    if (this.writeInFlight) return;
    const drain = async () => {
      while (this.writePending) {
        this.writePending = false;
        const revision = this.ledgerRevision;
        const contents = `${JSON.stringify({
          schemaVersion: 1,
          epochs: structuredClone(this.epochs),
        } satisfies QualificationLedgerFile, null, 2)}\n`;
        try {
          await this.writeLedger(this.filePath, contents);
          this.durableRevision = revision;
          this.persistenceError = undefined;
        } catch {
          this.persistenceError = "qualification-ledger-unavailable";
        }
      }
    };
    this.writeInFlight = drain().finally(() => { this.writeInFlight = undefined; });
  }

  private ledgerIsDurable(): boolean {
    return !this.persistenceError
      && !this.writePending
      && this.durableRevision === this.ledgerRevision;
  }

  private publicQualification(epoch: PersistedQualification): ProductionQualification {
    const visible = cloneQualification(epoch);
    if (!this.observedFingerprints.has(epoch.fingerprint)) {
      visible.ready = false;
      visible.blockers = boundedCodes([...visible.blockers, "qualification-runtime-binding-pending"]).slice(-32);
      if (visible.state !== "simulation") visible.state = "pending";
      return visible;
    }
    if (this.ledgerIsDurable()) return visible;
    visible.ready = false;
    const persistenceBlocker = this.persistenceError
      ? "qualification-ledger-unavailable"
      : "qualification-ledger-pending";
    visible.blockers = boundedCodes([...visible.blockers, persistenceBlocker]).slice(-32);
    if (visible.state !== "simulation") {
      visible.state = this.persistenceError || visible.state === "failed" ? "failed" : "pending";
    }
    return visible;
  }
}
