import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const auditRace = vi.hoisted(() => ({
  armed: false,
  auditPath: "",
  victimPath: "",
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    open: async (filePath: string | Buffer | URL, flags: string | number, mode?: number) => {
      if (auditRace.armed && String(filePath) === auditRace.auditPath) {
        auditRace.armed = false;
        await actual.unlink(auditRace.auditPath);
        await actual.symlink(auditRace.victimPath, auditRace.auditPath);
      }
      return actual.open(filePath, flags, mode);
    },
  };
});

const { createBackup } = await import("../src/server/evidenceBackup");
const { ensureDomainRoot } = await import("../src/server/dataDomains");

const roots: string[] = [];

afterEach(async () => {
  auditRace.armed = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("does not follow an audit symlink inserted at the final open boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-audit-race-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const configRoot = path.join(root, "config");
  const destinationRoot = path.join(root, "backup");
  await Promise.all([mkdir(configRoot), mkdir(destinationRoot)]);
  await ensureDomainRoot(path.join(dataRoot, "field"), "field");
  await ensureDomainRoot(path.join(dataRoot, "test"), "test");
  await writeFile(path.join(configRoot, "operational.json"), "{\"revision\":1}\n");
  const options = {
    dataRoot,
    configRoots: [{ label: "site", path: configRoot }],
    destinationRoot,
    backupId: "audit-race",
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
  };
  expect(await createBackup(options)).toMatchObject({ outcome: "PASS", auditDurable: true });

  const victimPath = path.join(root, "victim.txt");
  const auditPath = path.join(destinationRoot, "rf-monitor-backup-audit.jsonl");
  await writeFile(victimPath, "preserve-audit-race-victim\n");
  auditRace.auditPath = auditPath;
  auditRace.victimPath = victimPath;
  auditRace.armed = true;

  const raced = await createBackup({ ...options, now: () => new Date("2026-08-23T12:01:00.000Z") });
  expect(raced).toMatchObject({ outcome: "FAIL", state: "refused", auditDurable: false });
  expect(auditRace.armed).toBe(false);
  expect(await readFile(victimPath, "utf8")).toBe("preserve-audit-race-victim\n");
});
