import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommissioningHealth, RuntimeIdentity } from "../src/shared/types";
import {
  ProductionQualificationStore,
  qualificationApprovalRecordDigest,
  qualificationReceiverSerialHash,
  qualificationSiteBindingHash,
  type QualificationApprovalRecordV1,
  type QualificationObservation,
  type UnsignedQualificationApprovalRecordV1,
} from "../src/server/productionQualification";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(overrides: Partial<RuntimeIdentity["release"]> = {}, sampleRateHz = 10_000_000): RuntimeIdentity {
  return {
    schemaVersion: 1,
    serviceBootId: "00000000-0000-4000-8000-000000000001",
    serviceStartedAt: "2026-08-23T00:00:00.000Z",
    nodeVersion: "v22.0.0",
    release: {
      schemaVersion: 1,
      product: "rf-monitor",
      releaseVersion: "1.0.0",
      buildId: "release-test",
      serverBuildId: "release-test",
      clientBuildId: "release-test",
      sourceDigest: "1".repeat(64),
      packageDigest: "2".repeat(64),
      dependencyLockDigest: "3".repeat(64),
      integrity: "release-metadata",
      ...overrides,
    },
    protocols: { health: 2, live: 2, evidenceManifest: 2, catalogSchema: 3, operationalSchema: 3 },
    configuration: {
      catalogVersion: "catalog-v3",
      configurationHash: "4".repeat(64),
      configurationRevision: 1,
      detectorRuleSetId: "rf-relative-mad-v1",
      expectedSampleRateHz: sampleRateHz,
    },
  };
}

function commissioning(overrides: Partial<CommissioningHealth> = {}): CommissioningHealth {
  return {
    epochId: "00000000-0000-4000-8000-000000000002",
    state: "qualifying",
    ready: false,
    receiverReady: true,
    sampleRateReady: true,
    simulation: false,
    dataDomain: "field",
    soakRequiredMs: 24 * 60 * 60_000,
    soakElapsedMs: 1_000,
    soakStartedAt: "2026-08-23T00:00:00.000Z",
    scanObjectiveReady: false,
    resourceSoakClean: true,
    faults: [],
    ...overrides,
  };
}

const SITE = { siteName: "Harbor North", deploymentId: "harbor-north-rf-01" } as const;
const RECEIVER = { model: "RSPdx R2", serial: "RSPDX-R2-0001" } as const;

function observation(overrides: Partial<QualificationObservation> = {}): QualificationObservation {
  return {
    identity: identity(),
    commissioning: commissioning(),
    protectedBaselinesReady: true,
    site: SITE,
    receiver: RECEIVER,
    ...overrides,
  };
}

function approvalRecord(
  approvedIdentity: RuntimeIdentity,
  approvedCommissioning: CommissioningHealth,
  overrides: Partial<UnsignedQualificationApprovalRecordV1> = {},
): QualificationApprovalRecordV1 {
  const unsigned: UnsignedQualificationApprovalRecordV1 = {
    schemaVersion: 1,
    kind: "rf-monitor-production-qualification-approval",
    approvalId: "approval-harbor-north-001",
    approvedBy: "Independent site acceptance board",
    approvedAt: "2026-08-27T00:00:00.000Z",
    qualificationBundleSha256: "a".repeat(64),
    release: {
      buildId: approvedIdentity.release.buildId,
      serverBuildId: approvedIdentity.release.serverBuildId,
      clientBuildId: approvedIdentity.release.clientBuildId,
      sourceDigest: approvedIdentity.release.sourceDigest,
      packageDigest: approvedIdentity.release.packageDigest,
      dependencyLockDigest: approvedIdentity.release.dependencyLockDigest,
    },
    configuration: {
      configurationHash: approvedIdentity.configuration.configurationHash,
      catalogVersion: approvedIdentity.configuration.catalogVersion,
    },
    site: {
      deploymentId: SITE.deploymentId,
      bindingHash: qualificationSiteBindingHash(SITE)!,
    },
    receiver: {
      model: "RSPdx R2",
      serialSha256: qualificationReceiverSerialHash(RECEIVER.serial)!,
    },
    commissioning: {
      epochId: approvedCommissioning.epochId,
      soakStartedAt: approvedCommissioning.soakStartedAt,
    },
    gates: {
      installedChainQualified: true,
      timingAndBaselineQualified: true,
      hardwareRecoveryQualified: true,
      faultInjectionQualified: true,
      evidenceContinuityQualified: true,
    },
    ...overrides,
  };
  return { ...unsigned, recordDigest: qualificationApprovalRecordDigest(unsigned) };
}

async function installApproval(root: string, approvedIdentity: RuntimeIdentity, approvedCommissioning: CommissioningHealth, overrides: Partial<UnsignedQualificationApprovalRecordV1> = {}): Promise<string> {
  const filePath = path.join(root, "approval.json");
  await writeFile(filePath, `${JSON.stringify(approvalRecord(approvedIdentity, approvedCommissioning, overrides), null, 2)}\n`);
  return filePath;
}

describe("persistent production qualification", () => {
  it("keeps a healthy completed 24-hour local gate pending until an exact V0-V7 approval is installed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"));
    const pending = store.observe(observation({ evaluatedAt: "2026-08-23T00:00:01.000Z" }));
    expect(pending).toMatchObject({ state: "pending", ready: false });
    expect(pending.blockers).toEqual(expect.arrayContaining(["scan-objectives-pending", "qualification-soak-incomplete"]));
    await store.flush();
    const completeIdentity = identity();
    const completeCommissioning = commissioning({
        state: "qualified",
        ready: true,
        scanObjectiveReady: true,
        soakElapsedMs: 24 * 60 * 60_000,
      });
    const completeObservation = observation({
      identity: completeIdentity,
      commissioning: completeCommissioning,
      evaluatedAt: "2026-08-26T00:00:00.000Z",
    });
    const beforeCommit = store.observe(completeObservation);
    expect(beforeCommit).toMatchObject({
      state: "pending",
      ready: false,
      blockers: expect.arrayContaining(["external-qualification-approval-missing"]),
    });
    await store.flush();
    expect(store.observe(completeObservation)).toMatchObject({
      state: "pending",
      ready: false,
      requirements: {
        soakComplete: true,
        externalApproval: false,
        installedChainQualified: false,
        timingAndBaselineQualified: false,
        hardwareRecoveryQualified: false,
        faultQualification: false,
        evidenceContinuityQualified: false,
        clean72HourSoakQualified: false,
        controlledPilotQualified: false,
      },
    });

    const approvalRecordPath = await installApproval(root, completeIdentity, completeCommissioning);
    const approvedStore = await ProductionQualificationStore.open(path.join(root, "qualification.json"), { approvalRecordPath });
    expect(approvedStore.observe(completeObservation)).toMatchObject({ state: "pending", ready: false, blockers: expect.arrayContaining(["qualification-ledger-pending"]) });
    await approvedStore.flush();
    const qualified = approvedStore.observe(completeObservation);
    expect(qualified).toMatchObject({ state: "qualified", ready: true, blockers: [] });
    expect(qualified.requirements).toMatchObject({
      externalApproval: true,
      installedChainQualified: true,
      timingAndBaselineQualified: true,
      hardwareRecoveryQualified: true,
      faultQualification: true,
      evidenceContinuityQualified: true,
      clean72HourSoakQualified: false,
      controlledPilotQualified: false,
    });

    const reopenedWithoutRuntimeBinding = await ProductionQualificationStore.open(path.join(root, "qualification.json"));
    expect(reopenedWithoutRuntimeBinding.list()[0]).toMatchObject({
      state: "pending",
      ready: false,
      blockers: expect.arrayContaining(["qualification-runtime-binding-pending"]),
    });
  });

  it("rejects a legacy 72-hour local-window declaration and accepts its optional assurance fields only as metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const approvedIdentity = identity();
    const exactCommissioning = commissioning({
      state: "qualified",
      ready: true,
      scanObjectiveReady: true,
      soakElapsedMs: 24 * 60 * 60_000,
    });
    const compatibilityApproval = await installApproval(root, approvedIdentity, exactCommissioning, {
      gates: {
        installedChainQualified: true,
        timingAndBaselineQualified: true,
        hardwareRecoveryQualified: true,
        faultInjectionQualified: true,
        evidenceContinuityQualified: true,
        clean72HourSoakQualified: true,
        controlledPilotQualified: true,
      },
    });
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"), {
      approvalRecordPath: compatibilityApproval,
    });
    const legacyWindow = { ...exactCommissioning, soakRequiredMs: 72 * 60 * 60_000 };
    expect(store.observe(observation({ identity: approvedIdentity, commissioning: legacyWindow }))).toMatchObject({
      ready: false,
      requirements: { soakComplete: false, externalApproval: false },
      blockers: expect.arrayContaining(["qualification-soak-incomplete", "qualification-window-invalid"]),
    });
    await store.flush();

    const exact = store.observe(observation({ identity: approvedIdentity, commissioning: exactCommissioning }));
    await store.flush();
    expect(store.observe(observation({ identity: approvedIdentity, commissioning: exactCommissioning }))).toMatchObject({
      state: "qualified",
      ready: true,
      requirements: { clean72HourSoakQualified: true, controlledPilotQualified: true },
    });
    expect(exact.ready).toBe(false);
  });

  it("returns zero qualified responses until the exact latest ledger revision commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    let finishWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeLedger = vi.fn((_filePath: string, _contents: string) => new Promise<void>((resolve) => {
      finishWrite = resolve;
      markWriteStarted?.();
    }));
    const completeIdentity = identity();
    const completeCommissioning = commissioning({
        state: "qualified",
        ready: true,
        scanObjectiveReady: true,
        soakElapsedMs: 24 * 60 * 60_000,
      });
    const approvalRecordPath = await installApproval(root, completeIdentity, completeCommissioning);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"), { writeLedger, approvalRecordPath });
    const completeObservation = observation({
      identity: completeIdentity,
      commissioning: completeCommissioning,
      evaluatedAt: "2026-08-26T00:00:00.000Z",
    });

    expect(store.observe(completeObservation)).toMatchObject({ state: "pending", ready: false });
    await writeStarted;
    expect(store.observe(completeObservation)).toMatchObject({ state: "pending", ready: false });
    expect(store.list()[0]).toMatchObject({ state: "pending", ready: false });

    finishWrite?.();
    await store.flush();
    expect(store.observe(completeObservation)).toMatchObject({ state: "qualified", ready: true, blockers: [] });
    expect(writeLedger).toHaveBeenCalledTimes(1);
  });

  it("does not expose an older committed revision while a newer qualified epoch is pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const finishWrites: Array<() => void> = [];
    let markSecondWriteStarted: (() => void) | undefined;
    const secondWriteStarted = new Promise<void>((resolve) => { markSecondWriteStarted = resolve; });
    const writeLedger = vi.fn((_filePath: string, _contents: string) => new Promise<void>((resolve) => {
      finishWrites.push(resolve);
      if (finishWrites.length === 2) markSecondWriteStarted?.();
    }));
    const complete = commissioning({
      state: "qualified",
      ready: true,
      scanObjectiveReady: true,
      soakElapsedMs: 24 * 60 * 60_000,
    });
    const nextIdentity = identity();
    nextIdentity.configuration = {
      ...nextIdentity.configuration,
      configurationRevision: 2,
      configurationHash: "5".repeat(64),
    };
    const approvalRecordPath = await installApproval(root, nextIdentity, complete);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"), { writeLedger, approvalRecordPath });
    const first = observation({ identity: identity(), commissioning: complete });
    const latest = observation({ identity: nextIdentity, commissioning: complete });

    expect(store.observe(first)).toMatchObject({ state: "failed", ready: false, blockers: expect.arrayContaining(["external-qualification-configuration-mismatch"]) });
    expect(store.observe(latest)).toMatchObject({ state: "pending", ready: false });
    expect(writeLedger).toHaveBeenCalledTimes(1);

    finishWrites[0]();
    await secondWriteStarted;
    expect(store.observe(latest)).toMatchObject({ state: "pending", ready: false });
    expect(store.list().every((qualification) => !qualification.ready)).toBe(true);

    finishWrites[1]();
    await store.flush();
    expect(store.observe(latest)).toMatchObject({ state: "qualified", ready: true });
    expect(writeLedger).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a write error and qualifies only after a later durable retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    let failWrite = true;
    const committedContents: string[] = [];
    const writeLedger = vi.fn(async (_filePath: string, contents: string) => {
      if (failWrite) throw new Error("injected ledger failure");
      committedContents.push(contents);
    });
    const completeIdentity = identity();
    const completeCommissioning = commissioning({
        state: "qualified",
        ready: true,
        scanObjectiveReady: true,
        soakElapsedMs: 24 * 60 * 60_000,
      });
    const approvalRecordPath = await installApproval(root, completeIdentity, completeCommissioning);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"), { writeLedger, approvalRecordPath });
    const completeObservation = observation({
      identity: completeIdentity,
      commissioning: completeCommissioning,
      evaluatedAt: "2026-08-26T00:00:00.000Z",
    });

    expect(store.observe(completeObservation)).toMatchObject({ state: "pending", ready: false });
    await store.flush();
    expect(store.list()[0]).toMatchObject({
      state: "failed",
      ready: false,
      blockers: expect.arrayContaining(["qualification-ledger-unavailable"]),
    });

    failWrite = false;
    expect(store.observe(completeObservation)).toMatchObject({ state: "failed", ready: false });
    await store.flush();
    expect(store.observe(completeObservation)).toMatchObject({ state: "qualified", ready: true, blockers: [] });
    expect(writeLedger).toHaveBeenCalledTimes(2);
    expect(JSON.parse(committedContents[0])).toMatchObject({
      schemaVersion: 1,
      epochs: [{ state: "qualified", ready: true }],
    });
  });

  it("persists sticky faults without counting repeated polling as new occurrences", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const filePath = path.join(root, "qualification.json");
    const store = await ProductionQualificationStore.open(filePath);
    const faulted = commissioning({ faults: ["evidence-frame-drop"], resourceSoakClean: false });
    store.observe(observation({ commissioning: faulted, evaluatedAt: "2026-08-23T01:00:00.000Z" }));
    const repeated = store.observe(observation({ commissioning: faulted, evaluatedAt: "2026-08-23T01:01:00.000Z" }));
    expect(repeated).toMatchObject({ state: "failed", ready: false, faults: [{ code: "evidence-frame-drop", count: 1 }] });
    await store.flush();
    const reopened = await ProductionQualificationStore.open(filePath);
    const persisted = reopened.observe(observation({ commissioning: commissioning({ faults: [], resourceSoakClean: true }), evaluatedAt: "2026-08-23T02:00:00.000Z" }));
    expect(persisted).toMatchObject({ state: "failed", ready: false, faults: [{ code: "evidence-frame-drop", count: 1 }] });
    await reopened.flush();
  });

  it("keeps warm-up fingerprint metadata pending and latches the same loss after qualification starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"));
    const fingerprintFault = "rf-fingerprint-metadata-unavailable";
    const warmup = commissioning({
      state: "rf-flow-ready",
      soakElapsedMs: 0,
      faults: [fingerprintFault],
    });

    const pending = store.observe(observation({ commissioning: warmup, evaluatedAt: "2026-08-23T00:00:01.000Z" }));
    expect(pending).toMatchObject({ state: "pending", ready: false, faults: [] });
    expect(pending.blockers).not.toContain(`fault:${fingerprintFault}`);

    const missingReceiverPending = store.observe(observation({
      commissioning: { ...warmup, epochId: "warmup-receiver-metadata" },
      receiver: {},
      evaluatedAt: "2026-08-23T00:00:02.000Z",
    }));
    expect(missingReceiverPending).toMatchObject({
      state: "pending",
      ready: false,
      faults: [],
      blockers: expect.arrayContaining(["receiver-model-pending", "receiver-identity-pending"]),
    });

    const active = store.observe(observation({
      commissioning: { ...warmup, state: "qualifying", soakElapsedMs: 1, faults: [fingerprintFault] },
      evaluatedAt: "2026-08-23T00:05:00.001Z",
    }));
    expect(active).toMatchObject({
      state: "failed",
      ready: false,
      faults: [{ code: fingerprintFault, count: 1 }],
      blockers: expect.arrayContaining([`fault:${fingerprintFault}`]),
    });

    const recovered = store.observe(observation({
      commissioning: { ...warmup, state: "qualifying", soakElapsedMs: 2, faults: [] },
      evaluatedAt: "2026-08-23T00:05:00.002Z",
    }));
    expect(recovered).toMatchObject({
      state: "failed",
      ready: false,
      faults: [{ code: fingerprintFault, count: 1 }],
    });
    await store.flush();
  });

  it("rejects simulation, runtime-derived builds, unconfirmed read-back, and experimental 9 MS/s", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"));
    const complete = commissioning({ state: "qualified", ready: true, scanObjectiveReady: true, soakElapsedMs: 24 * 60 * 60_000 });
    expect(store.observe(observation({ commissioning: { ...complete, simulation: true, dataDomain: "test", state: "simulation", ready: false }, receiver: {} })).state).toBe("simulation");
    expect(store.observe(observation({ identity: identity({ integrity: "runtime-derived" }), commissioning: { ...complete, epochId: "runtime-derived" } }))).toMatchObject({ state: "failed", ready: false, blockers: expect.arrayContaining(["release-identity-unverified"]) });
    expect(store.observe(observation({ commissioning: { ...complete, epochId: "unconfirmed", sampleRateReady: false, ready: false } }))).toMatchObject({ state: "pending", ready: false, blockers: expect.arrayContaining(["sample-rate-unconfirmed"]) });
    expect(store.observe(observation({ identity: identity({}, 9_000_000), commissioning: { ...complete, epochId: "nine-msps" } }))).toMatchObject({ state: "failed", ready: false, blockers: expect.arrayContaining(["experimental-sample-rate"]) });
    expect(store.observe(observation({
      identity: identity({ serverBuildId: "release-test", clientBuildId: "different-client" }),
      commissioning: { ...complete, epochId: "build-mismatch" },
    }))).toMatchObject({
      state: "failed",
      ready: false,
      blockers: expect.arrayContaining(["release-build-mismatch"]),
      requirements: { clientServerBuildMatch: false },
    });
    await store.flush();
  });

  it("rejects deceptive hardware names and missing serial identity at qualification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const store = await ProductionQualificationStore.open(path.join(root, "qualification.json"));
    const complete = commissioning({ state: "qualified", ready: true, scanObjectiveReady: true, soakElapsedMs: 24 * 60 * 60_000 });
    for (const model of ["Clone RSPdx", "RSPdx Pro", "RSPdx (TEST)", "RSPdx R20"]) {
      expect(store.observe(observation({
        commissioning: { ...complete, epochId: `unsupported-${model.replace(/\W+/g, "-")}` },
        receiver: { model, serial: RECEIVER.serial },
      }))).toMatchObject({
        state: "failed",
        ready: false,
        requirements: { supportedReceiverModel: false, stableReceiverIdentity: false },
        blockers: expect.arrayContaining(["unsupported-receiver-model", "receiver-identity-pending"]),
      });
    }
    expect(store.observe(observation({
      commissioning: { ...complete, epochId: "missing-serial" },
      receiver: { model: "RSPdx" },
    }))).toMatchObject({
      state: "pending",
      ready: false,
      requirements: { supportedReceiverModel: true, stableReceiverIdentity: false },
      blockers: expect.arrayContaining(["receiver-identity-pending"]),
    });
    await store.flush();
  });

  it("fails closed on a tampered or incomplete external approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-qualification-"));
    roots.push(root);
    const approvedIdentity = identity();
    const approvedCommissioning = commissioning({ state: "qualified", ready: true, scanObjectiveReady: true, soakElapsedMs: 24 * 60 * 60_000 });
    const tampered = approvalRecord(approvedIdentity, approvedCommissioning);
    tampered.approvedBy = "Changed after approval";
    const tamperedPath = path.join(root, "tampered-approval.json");
    await writeFile(tamperedPath, JSON.stringify(tampered));
    const tamperedStore = await ProductionQualificationStore.open(path.join(root, "tampered-ledger.json"), { approvalRecordPath: tamperedPath });
    expect(tamperedStore.observe(observation({ identity: approvedIdentity, commissioning: approvedCommissioning }))).toMatchObject({
      state: "failed",
      ready: false,
      blockers: expect.arrayContaining(["external-qualification-approval-invalid"]),
    });
    await tamperedStore.flush();

    const incomplete = approvalRecord(approvedIdentity, approvedCommissioning);
    incomplete.gates.hardwareRecoveryQualified = false;
    incomplete.gates.faultInjectionQualified = false;
    const { recordDigest: _oldDigest, ...incompleteUnsigned } = incomplete;
    incomplete.recordDigest = qualificationApprovalRecordDigest(incompleteUnsigned);
    const incompletePath = path.join(root, "incomplete-approval.json");
    await writeFile(incompletePath, JSON.stringify(incomplete));
    const incompleteStore = await ProductionQualificationStore.open(path.join(root, "incomplete-ledger.json"), { approvalRecordPath: incompletePath });
    expect(incompleteStore.observe(observation({ identity: approvedIdentity, commissioning: approvedCommissioning }))).toMatchObject({
      state: "failed",
      ready: false,
      requirements: { externalApproval: false, hardwareRecoveryQualified: false, faultQualification: false },
      blockers: expect.arrayContaining([
        "external-qualification-gates-incomplete",
        "hardware-recovery-qualification-pending",
        "fault-qualification-pending",
      ]),
    });
    await incompleteStore.flush();
  });
});
