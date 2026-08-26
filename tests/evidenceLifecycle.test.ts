import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceStore,
  type EvidenceFinalizationFaultPoint,
} from "../src/server/evidenceStore";
import { verifyEvidenceDirectory } from "../src/server/evidenceVerifier";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `rf-monitor-${label}-`));
  roots.push(root);
  return root;
}

async function writeLegacyManifest(
  root: string,
  complete: boolean | undefined = undefined,
): Promise<void> {
  const payload = Buffer.from("legacy-evidence\n");
  await writeFile(path.join(root, "payload.bin"), payload);
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const manifest = {
    schemaVersion: 1,
    sessionId: "session-legacy-v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    hashAlgorithm: "SHA-256",
    files: [{ path: "payload.bin", bytes: payload.byteLength, sha256: payloadHash }],
    ...(complete === undefined ? {} : { complete, evidenceGap: !complete }),
    disclaimer: "Legacy test evidence",
  };
  const manifestContents = JSON.stringify(manifest, null, 2);
  await writeFile(path.join(root, "manifest.json"), manifestContents);
  const manifestHash = createHash("sha256").update(manifestContents).digest("hex");
  await writeFile(path.join(root, "SHA256SUMS.txt"), `${payloadHash}  payload.bin\n${manifestHash}  manifest.json\n`);
}

describe("transactional evidence lifecycle", { timeout: 30_000 }, () => {
  it("publishes Complete only after a durable commit that the offline verifier passes", async () => {
    const root = await temporaryRoot("evidence-complete");
    const store = new EvidenceStore(root);
    const active = await store.initialize({ config: {}, sdrconnect: {} });
    expect(active).toMatchObject({ lifecycle: "Active", status: "recording" });

    const closed = await store.closeActive();
    expect(closed).toMatchObject({
      lifecycle: "Complete",
      status: "closed",
      finalizedAt: expect.any(String),
      verification: { outcome: "pass", verifiedAt: expect.any(String) },
    });
    expect(await verifyEvidenceDirectory(closed.path)).toMatchObject({ outcome: "PASS", sessionId: closed.id });
    expect(JSON.parse(await readFile(path.join(closed.path, "finalization.json"), "utf8"))).toMatchObject({
      lifecycle: "Complete",
      sessionId: closed.id,
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sha256SumsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.getFinalizerHealth()).toMatchObject({
      queueItems: 0,
      queueLimit: 8,
      completedTotal: 1,
      incompleteTotal: 0,
      corruptTotal: 0,
    });
  });

  it("refuses Active and unlabelled Incomplete sources while allowing a committed Complete source", async () => {
    const root = await temporaryRoot("evidence-export-allowlist");
    const store = new EvidenceStore(root);
    const active = await store.initialize({ config: {}, sdrconnect: {} });
    await expect(store.exportSession(active.id)).rejects.toMatchObject({ code: "EVIDENCE_SOURCE_NOT_COMMITTED" });
    await store.closeActive();
    await expect(store.prepareSessionExport(active.id)).resolves.toMatchObject({
      sessionId: active.id,
      commitKey: expect.stringContaining(`session:${active.id}:`),
    });

    const unlabelled = await store.initialize({ config: { part: 2 }, sdrconnect: {} });
    await store.closeActive();
    const descriptorPath = path.join(unlabelled.path, "session.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    await writeFile(descriptorPath, JSON.stringify({
      ...descriptor,
      lifecycle: "Incomplete",
      evidenceGap: false,
      incompleteReasons: [],
    }, null, 2));
    await expect(store.exportSession(unlabelled.id)).rejects.toMatchObject({ code: "EVIDENCE_SOURCE_INCOMPLETE_UNLABELLED" });
  });

  it.each<EvidenceFinalizationFaultPoint>(["hash", "write", "rename", "fsync"])(
    "keeps a %s fault explicitly Incomplete and never PASS",
    async (faultPoint) => {
      const root = await temporaryRoot(`evidence-${faultPoint}`);
      let injected = false;
      const store = new EvidenceStore(root, {
        finalizationFaultInjector: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`fixture-${faultPoint}`);
          }
        },
      });
      await store.initialize({ config: {}, sdrconnect: {} });
      const closed = await store.closeActive();

      expect(closed).toMatchObject({
        lifecycle: "Incomplete",
        status: "closed",
        evidenceGap: true,
        incompleteReasons: expect.arrayContaining(["finalization-failed"]),
      });
      expect((await verifyEvidenceDirectory(closed.path)).outcome).toBe("INCOMPLETE");
      expect(store.getFinalizerHealth()).toMatchObject({
        queueItems: 0,
        incompleteTotal: 1,
        lastFailure: { lifecycle: "Incomplete", reason: `fixture-${faultPoint}` },
      });
      await expect(stat(path.join(closed.path, "finalization.json"))).rejects.toThrow();
    },
  );

  it("recovers a durable Finalizing checkpoint after restart without inventing a gap", async () => {
    const root = await temporaryRoot("evidence-finalizing-restart");
    const interrupted = new EvidenceStore(root);
    const session = await interrupted.initialize({ config: {}, sdrconnect: {} });
    const descriptorPath = path.join(session.path, "session.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    const checkpointAt = "2026-01-01T00:00:00.000Z";
    await writeFile(descriptorPath, JSON.stringify({
      ...descriptor,
      path: ".",
      lifecycle: "Finalizing",
      status: "closed",
      endedAt: checkpointAt,
      durabilityCheckpointAt: checkpointAt,
      finalizationStartedAt: checkpointAt,
    }, null, 2));

    const recovered = new EvidenceStore(root);
    await recovered.initialize({ config: { boot: 2 }, sdrconnect: {} });
    const recoveredSession = (await recovered.listSessions()).find((candidate) => candidate.id === session.id);
    expect(recoveredSession).toMatchObject({ lifecycle: "Complete", status: "closed" });
    expect(await verifyEvidenceDirectory(session.path)).toMatchObject({ outcome: "PASS" });
    await recovered.closeActive();
  });

  it("keeps restart bounded to commit metadata and marks payload corruption on explicit verification", async () => {
    const root = await temporaryRoot("evidence-corrupt-restart");
    const first = new EvidenceStore(root);
    const session = await first.initialize({ config: { value: 1 }, sdrconnect: {} });
    await first.closeActive();
    await writeFile(path.join(session.path, "config.json"), JSON.stringify({ value: 2 }));
    expect((await verifyEvidenceDirectory(session.path)).outcome).toBe("FAIL");

    const recovered = new EvidenceStore(root);
    await recovered.initialize({ config: {}, sdrconnect: {} });
    expect((await recovered.listSessions()).find((candidate) => candidate.id === session.id)).toMatchObject({
      lifecycle: "Complete",
      verification: { outcome: "pass", verifiedAt: expect.any(String) },
    });
    await expect(recovered.exportSession(session.id)).rejects.toMatchObject({
      code: "EVIDENCE_SOURCE_VERIFICATION_FAILED",
    });
    expect((await recovered.listSessions()).find((candidate) => candidate.id === session.id)).toMatchObject({
      lifecycle: "Corrupt",
      status: "storage-error",
      evidenceGap: true,
      verification: { outcome: "fail", verifiedAt: expect.any(String) },
    });
    await recovered.closeActive();
  });

  it("bounds a saturated finalizer queue and persists the rejected disposition", async () => {
    const root = await temporaryRoot("evidence-finalizer-bound");
    let release!: () => void;
    let blocked = true;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new EvidenceStore(root, {
      finalizerMaxItems: 2,
      finalizationFaultInjector: async (point) => {
        if (point === "hash" && blocked) await gate;
      },
    });
    await store.initialize({ config: { part: 1 }, sdrconnect: {} });
    await store.rotate({ config: { part: 2 }, sdrconnect: {} });
    const rejectedSourceDescriptor = await store.rotate({ config: { part: 3 }, sdrconnect: {} });
    await store.rotate({ config: { part: 4 }, sdrconnect: {} });
    const rejectedSource = (await store.listSessions()).find((candidate) => candidate.id === rejectedSourceDescriptor.id);

    expect(store.getFinalizerHealth()).toMatchObject({ queueItems: 2, queueLimit: 2, rejectedTotal: 1 });
    expect(rejectedSource).toMatchObject({
      lifecycle: "Incomplete",
      incompleteReasons: expect.arrayContaining(["finalizer-queue-full"]),
    });
    blocked = false;
    release();
    await store.flushFinalizers();
    await store.closeActive();
    expect(store.getFinalizerHealth()).toMatchObject({ queueItems: 0, rejectedTotal: 1 });
  });

  it("refuses Corrupt and Finalizing export sources with stable reason codes", async () => {
    const finalizingRoot = await temporaryRoot("evidence-export-finalizing");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finalizingStore = new EvidenceStore(finalizingRoot, {
      finalizationFaultInjector: async (point) => {
        if (point === "hash") await gate;
      },
    });
    const source = await finalizingStore.initialize({ config: {}, sdrconnect: {} });
    await finalizingStore.rotate({ config: { part: 2 }, sdrconnect: {} });
    await expect(finalizingStore.exportSession(source.id)).rejects.toMatchObject({
      code: "EVIDENCE_SOURCE_FINALIZING",
      message: expect.stringContaining("Finalizing"),
    });
    release();
    await finalizingStore.flushFinalizers();
    await finalizingStore.closeActive();

    const corruptRoot = await temporaryRoot("evidence-export-corrupt");
    const first = new EvidenceStore(corruptRoot);
    const corruptSource = await first.initialize({ config: { original: true }, sdrconnect: {} });
    await first.closeActive();
    await writeFile(path.join(corruptSource.path, "config.json"), "{}\n");
    const recovered = new EvidenceStore(corruptRoot);
    await recovered.initialize({ config: {}, sdrconnect: {} });
    await expect(recovered.exportSession(corruptSource.id)).rejects.toMatchObject({
      code: "EVIDENCE_SOURCE_VERIFICATION_FAILED",
      message: expect.stringContaining("failed verification"),
    });
    await expect(recovered.exportSession(corruptSource.id)).rejects.toMatchObject({
      code: "EVIDENCE_SOURCE_CORRUPT",
      message: expect.stringContaining("Corrupt"),
    });
    await recovered.closeActive();
  });

  it("deterministically verifies legacy manifest-v1 PASS, INCOMPLETE, and FAIL", async () => {
    const passRoot = await temporaryRoot("evidence-v1-pass");
    await writeLegacyManifest(passRoot);
    expect(await verifyEvidenceDirectory(passRoot)).toMatchObject({ outcome: "PASS", manifestSchemaVersion: 1 });

    const incompleteRoot = await temporaryRoot("evidence-v1-incomplete");
    await writeLegacyManifest(incompleteRoot, false);
    expect(await verifyEvidenceDirectory(incompleteRoot)).toMatchObject({ outcome: "INCOMPLETE", manifestSchemaVersion: 1 });

    await writeFile(path.join(passRoot, "payload.bin"), "modified\n");
    expect(await verifyEvidenceDirectory(passRoot)).toMatchObject({ outcome: "FAIL", reasons: ["file-size-mismatch:payload.bin"] });
  });

  it("discards interrupted export partials and never overwrites an immutable export ID", async () => {
    const root = await temporaryRoot("evidence-partial-recovery");
    await mkdir(path.join(root, "exports", ".fixture.partial-crash"), { recursive: true });
    await writeFile(path.join(root, "exports", ".fixture.partial-crash", "partial.zip"), "not complete");
    const store = new EvidenceStore(root);
    const session = await store.initialize({ config: {}, sdrconnect: {} });
    await expect(stat(path.join(root, "exports", ".fixture.partial-crash"))).rejects.toThrow();
    expect(await readFile(path.join(root, "export-recovery.jsonl"), "utf8")).toContain("discarded-interrupted-export-partials");
    await store.closeActive();

    const first = await store.exportSession(session.id, "immutable-job");
    if (Array.isArray(first)) throw new Error("Expected one export part");
    const firstHash = createHash("sha256").update(await readFile(first)).digest("hex");
    await expect(store.exportSession(session.id, "immutable-job")).rejects.toMatchObject({ code: "EEXIST" });
    expect(createHash("sha256").update(await readFile(first)).digest("hex")).toBe(firstHash);
  });

  it("deletes only finalized recordings in the named domain and reports exact retained classes", async () => {
    const root = await temporaryRoot("recordings-delete-domain");
    const fieldRoot = path.join(root, "field-evidence");
    const testRoot = path.join(root, "test-evidence");
    const field = new EvidenceStore(fieldRoot, { dataDomain: "field" });
    const fieldSession = await field.initialize({ config: { domain: "field" }, sdrconnect: {} });
    await field.closeActive();

    const test = new EvidenceStore(testRoot, { dataDomain: "test" });
    const archived = await test.initialize({ config: { domain: "test", archived: true }, sdrconnect: {} });
    await test.closeActive();
    const active = await test.initialize({ config: { domain: "test", active: true }, sdrconnect: {} });
    const result = await test.deleteRecordings("settings-admin");

    expect(result).toMatchObject({
      state: "complete",
      dataDomain: "test",
      deletedSessions: 1,
      deletedBytes: expect.any(Number),
      retainedActiveSessions: 1,
      retainedFinalizingSessions: 0,
      retainedLeasedSessions: 0,
      auditDurable: true,
    });
    expect(result.deletedBytes).toBeGreaterThan(0);
    expect((await test.listSessions()).map((session) => session.id)).toEqual([active.id]);
    expect((await field.listSessions()).map((session) => session.id)).toContain(fieldSession.id);
    await expect(stat(archived.path)).rejects.toThrow();
    expect(await readFile(path.join(testRoot, "recording-delete-audit.jsonl"), "utf8")).toContain(result.operationId);
    await test.closeActive();
  });

  it("retains active, finalizing, and export-leased sessions", async () => {
    const root = await temporaryRoot("recordings-delete-retained");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new EvidenceStore(root, {
      finalizationFaultInjector: async (point) => {
        if (point === "hash") await gate;
      },
    });
    const finalizing = await store.initialize({ config: { part: 1 }, sdrconnect: {} });
    const active = await store.rotate({ config: { part: 2 }, sdrconnect: {} });
    const whileFinalizing = await store.deleteRecordings("settings-admin");
    expect(whileFinalizing).toMatchObject({
      state: "complete",
      deletedSessions: 0,
      retainedActiveSessions: 1,
      retainedFinalizingSessions: 1,
    });
    expect((await store.listSessions()).map((session) => session.id)).toEqual(expect.arrayContaining([active.id, finalizing.id]));

    release();
    await store.flushFinalizers();
    const exporting = store.exportSession(finalizing.id, "lease-fixture");
    const whileExporting = await store.deleteRecordings("settings-admin");
    expect(whileExporting).toMatchObject({
      state: "complete",
      deletedSessions: 0,
      retainedActiveSessions: 1,
      retainedLeasedSessions: 1,
    });
    await exporting;
    await store.closeActive();
  });

  it("rolls a pre-commit deletion fault back without deleting a recording", async () => {
    const root = await temporaryRoot("recordings-delete-rollback");
    let injected = false;
    const store = new EvidenceStore(root, {
      recordingDeletionFaultInjector: (point) => {
        if (!injected && point === "after-first-rename") {
          injected = true;
          throw new Error("fixture-precommit-delete");
        }
      },
    });
    const archived = await store.initialize({ config: {}, sdrconnect: {} });
    await store.closeActive();
    const result = await store.deleteRecordings("settings-admin");
    expect(result).toMatchObject({ state: "refused", deletedSessions: 0, deletedBytes: 0, auditDurable: true });
    expect((await store.listSessions()).map((session) => session.id)).toContain(archived.id);
    await expect(stat(path.join(root, "recording-delete-operation.json"))).rejects.toThrow();
  });

  it("finishes a committed deletion after restart and preserves its durable audit", async () => {
    const root = await temporaryRoot("recordings-delete-recovery");
    let injected = false;
    const interrupted = new EvidenceStore(root, {
      recordingDeletionFaultInjector: (point) => {
        if (!injected && point === "after-commit") {
          injected = true;
          throw new Error("fixture-postcommit-delete");
        }
      },
    });
    const archived = await interrupted.initialize({ config: {}, sdrconnect: {} });
    await interrupted.closeActive();
    const pending = await interrupted.deleteRecordings("settings-admin");
    expect(pending).toMatchObject({ state: "recovery-required", deletedSessions: 1, auditDurable: false });
    expect(await stat(path.join(root, "recording-delete-operation.json"))).toBeTruthy();

    const recovered = new EvidenceStore(root);
    const active = await recovered.initialize({ config: { recovered: true }, sdrconnect: {} });
    expect((await recovered.listSessions()).map((session) => session.id)).toEqual([active.id]);
    await expect(stat(archived.path)).rejects.toThrow();
    const audit = await readFile(path.join(root, "recording-delete-audit.jsonl"), "utf8");
    expect(audit).toContain(pending.operationId);
    expect(audit).toContain('"recovered":true');
    await recovered.closeActive();
  });
});
