import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminAuth, AdminAuthenticationError, createAdminCredential } from "../src/server/adminAuth";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function authFor(password = "correct horse battery staple"): Promise<AdminAuth> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-auth-"));
  temporaryRoots.push(root);
  const credentialPath = path.join(root, "admin.json");
  await writeFile(credentialPath, JSON.stringify(await createAdminCredential(password)));
  return AdminAuth.load(credentialPath, 15 * 60_000);
}

describe("settings authentication", () => {
  it("stores a salted scrypt verifier and never the password", async () => {
    const credential = await createAdminCredential("correct horse battery staple");
    expect(credential).toMatchObject({ schemaVersion: 1, algorithm: "scrypt", cost: 32_768 });
    expect(JSON.stringify(credential)).not.toContain("correct horse");
    expect(Buffer.from(credential.salt, "base64")).toHaveLength(24);
  });

  it("issues an IP-bound short-lived server session with hardened cookie attributes", async () => {
    const auth = await authFor();
    const unlocked = await auth.unlock("correct horse battery staple", "127.0.0.1");
    expect(auth.session(`rf_monitor_admin=${encodeURIComponent(unlocked.cookie)}`, "127.0.0.1").unlocked).toBe(true);
    expect(auth.session(`rf_monitor_admin=${encodeURIComponent(unlocked.cookie)}`, "127.0.0.2").unlocked).toBe(false);
    expect(auth.cookieHeader(unlocked.cookie, true)).toContain("HttpOnly; SameSite=Strict");
    expect(auth.cookieHeader(unlocked.cookie, true)).toContain("; Secure");
    auth.lock(`rf_monitor_admin=${encodeURIComponent(unlocked.cookie)}`, "127.0.0.1");
    expect(auth.session(`rf_monitor_admin=${encodeURIComponent(unlocked.cookie)}`, "127.0.0.1").unlocked).toBe(false);
  });

  it("rate limits repeated password failures per client address", async () => {
    const auth = await authFor();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.unlock("incorrect password", "192.0.2.10")).rejects.toMatchObject({ status: 401 });
    }
    await expect(auth.unlock("correct horse battery staple", "192.0.2.10")).rejects.toEqual(expect.objectContaining<Partial<AdminAuthenticationError>>({ status: 429 }));
  });

  it("reserves attempts before scrypt so concurrent calls cannot bypass the per-address limit", async () => {
    const auth = await authFor();
    const first = auth.unlock("incorrect password", "192.0.2.20");
    await expect(auth.unlock("incorrect password", "192.0.2.20")).rejects.toEqual(
      expect.objectContaining<Partial<AdminAuthenticationError>>({ status: 429 }),
    );
    await expect(first).rejects.toEqual(expect.objectContaining<Partial<AdminAuthenticationError>>({ status: 401 }));
  });

  it("bounds global password derivations without blocking later legitimate unlocks", async () => {
    const auth = await authFor();
    const first = auth.unlock("incorrect password", "192.0.2.31");
    const second = auth.unlock("incorrect password", "192.0.2.32");
    await expect(auth.unlock("incorrect password", "192.0.2.33")).rejects.toEqual(
      expect.objectContaining<Partial<AdminAuthenticationError>>({ status: 503 }),
    );
    await Promise.allSettled([first, second]);
    await expect(auth.unlock("correct horse battery staple", "192.0.2.33")).resolves.toHaveProperty("cookie");
  });

  it("prunes expired client records and fails closed at the global tracking bound", async () => {
    const auth = await authFor();
    const failures = (auth as unknown as { failures: Map<string, number[]> }).failures;
    const now = Date.now();
    for (let index = 0; index < 2_048; index += 1) failures.set(`expired-${index}`, [now - 16 * 60_000]);

    await expect(auth.unlock("correct horse battery staple", "192.0.2.40")).resolves.toHaveProperty("cookie");
    expect(failures.size).toBe(0);

    for (let index = 0; index < 1_024; index += 1) failures.set(`active-${index}`, [Date.now()]);
    await expect(auth.unlock("incorrect password", "active-0")).rejects.toMatchObject({ status: 401 });
    expect(failures.size).toBe(1_024);
    await expect(auth.unlock("correct horse battery staple", "192.0.2.41")).rejects.toEqual(
      expect.objectContaining<Partial<AdminAuthenticationError>>({ status: 503 }),
    );
    expect(failures.size).toBe(1_024);
  });
});
