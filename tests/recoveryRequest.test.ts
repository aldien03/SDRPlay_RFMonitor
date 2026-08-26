import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishApplicationRestartRequest,
  publishAuditedApplicationRestartRequest,
  publishReceiverRecoveryRequest,
  readRecoverySupervisorStatus,
  recoveryOperationState,
} from "../src/server/recoveryRequest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("receiver recovery request boundary", () => {
  it("atomically publishes a versioned request with protected permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-recovery-request-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "recover-sdrconnect");
    const now = new Date("2026-08-23T09:10:11.000Z");

    const request = await publishReceiverRecoveryRequest(destination, now);
    const stored = JSON.parse(await readFile(destination, "utf8"));

    expect(stored).toEqual(request);
    expect(stored).toMatchObject({
      schemaVersion: 1,
      requestedAt: "2026-08-23T09:10:11.000Z",
      source: "operator",
    });
    expect(stored.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((entry) => entry.includes(".partial-"))).toEqual([]);
  });

  it("replaces a previous request only after the new payload is complete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-recovery-request-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "recover-sdrconnect");
    await writeFile(destination, "legacy request\n", { mode: 0o600 });

    const request = await publishReceiverRecoveryRequest(destination, new Date("2026-08-23T09:12:00.000Z"));

    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(request);
    expect((await readdir(root)).filter((entry) => entry.includes(".partial-"))).toEqual([]);
  });

  it("reads bounded helper status and distinguishes pending, verified, cooldown, lockout, and unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-recovery-status-"));
    temporaryRoots.push(root);
    const source = path.join(root, "status.json");
    const now = Date.parse("2026-08-23T09:15:00.000Z");
    const writeStatus = async (state: string, reasonCode: string, extra: object = {}) => {
      await writeFile(source, `${JSON.stringify({
        schemaVersion: 1,
        state,
        reasonCode,
        source: "manual",
        observedAt: "2026-08-23T09:15:00.000Z",
        requestId: "request-1",
        ...extra,
      })}\n`);
      return readRecoverySupervisorStatus(source, now);
    };

    expect(recoveryOperationState(await writeStatus("requested", "observing-stale-stream"), false, now)).toMatchObject({ outcome: "helper-pending", requestId: "request-1" });
    expect(recoveryOperationState(await writeStatus("recovering", "restart-requested"), false, now).outcome).toBe("helper-pending");
    expect(recoveryOperationState(await writeStatus("live", "recovery-confirmed"), true, now).outcome).toBe("verified-recovery");
    expect(recoveryOperationState(await writeStatus("failed", "recovery-cooldown", { nextAttemptAt: "2026-08-23T09:17:00.000Z" }), false, now)).toMatchObject({ outcome: "cooldown", retryAfterMs: 120_000 });
    expect(recoveryOperationState(await writeStatus("lockout", "attempt-limit", { lockoutUntil: "2026-08-23T10:15:00.000Z", attemptsInWindow: 3, maxAttempts: 3 }), false, now)).toMatchObject({ outcome: "lockout", retryAfterMs: 3_600_000, attemptsInWindow: 3 });
    expect(recoveryOperationState(await readRecoverySupervisorStatus(path.join(root, "missing.json"), now), false, now)).toMatchObject({ outcome: "unavailable", reasonCode: "missing" });
  });

  it("rejects stale, malformed, and oversized helper state without retaining unbounded bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-recovery-status-"));
    temporaryRoots.push(root);
    const source = path.join(root, "status.json");
    await writeFile(source, '{"schemaVersion":1');
    expect(await readRecoverySupervisorStatus(source)).toEqual({ availability: "unavailable", reasonCode: "invalid" });
    await writeFile(source, "x".repeat(16 * 1024 + 1));
    expect(await readRecoverySupervisorStatus(source)).toEqual({ availability: "unavailable", reasonCode: "oversized" });
    await writeFile(source, `${JSON.stringify({ schemaVersion: 1, state: "live", reasonCode: "monitoring-ready", source: "automatic", observedAt: "2026-08-23T08:00:00.000Z" })}\n`);
    const stale = await readRecoverySupervisorStatus(source, Date.parse("2026-08-23T09:00:00.000Z"));
    expect(stale).toMatchObject({ availability: "available", fresh: false });
    expect(recoveryOperationState(stale, true, Date.parse("2026-08-23T09:00:00.000Z"))).toMatchObject({ outcome: "unavailable", reasonCode: "stale-status" });
  });

  it("rejects symlinks at both sides of the privileged recovery boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-recovery-symlink-"));
    temporaryRoots.push(root);
    const target = path.join(root, "target");
    const source = path.join(root, "status.json");
    await writeFile(target, `${JSON.stringify({ schemaVersion: 1, state: "live", reasonCode: "monitoring-ready", source: "automatic", observedAt: new Date().toISOString() })}\n`);
    await symlink(target, source);
    expect(await readRecoverySupervisorStatus(source)).toEqual({ availability: "unavailable", reasonCode: "unreadable" });

    const destination = path.join(root, "recover-sdrconnect");
    await symlink(target, destination);
    await expect(publishReceiverRecoveryRequest(destination)).rejects.toThrow(/regular file/);
    expect(await readFile(target, "utf8")).toContain("monitoring-ready");
  });

  it("publishes a protected, auditable application-restart request atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-app-restart-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "restart-application");
    const request = await publishApplicationRestartRequest(destination, {
      expectedConfigurationRevision: 3,
      previousBootId: "boot-123",
      auditEntryHash: "a".repeat(64),
    }, new Date("2026-08-23T09:20:00.000Z"));

    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(request);
    expect(request).toMatchObject({
      schemaVersion: 1,
      source: "settings-admin",
      requestedAt: "2026-08-23T09:20:00.000Z",
      expectedConfigurationRevision: 3,
      previousBootId: "boot-123",
      auditEntryHash: "a".repeat(64),
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((entry) => entry.includes(".partial-"))).toEqual([]);
  });

  it("never publishes an application restart when durable audit is uncertain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-app-restart-audit-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "restart-application");
    await expect(publishAuditedApplicationRestartRequest(destination, {
      expectedConfigurationRevision: 3,
      previousBootId: "boot-123",
    }, async () => {
      throw new Error("audit fsync failed");
    })).rejects.toThrow(/audit fsync failed/);
    await expect(readFile(destination, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((entry) => entry.includes(".partial-"))).toEqual([]);
  });
});
