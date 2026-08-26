import { execFile } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { signedRecordPayload, witnessPublicKeyDigest } from "../scripts/lib/long-qualification.mjs";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("qualification witness CLI", () => {
  it("signs with the pinned Ed25519 key and refuses an exposed private key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-witness-"));
    roots.push(root);
    const keys = generateKeyPairSync("ed25519");
    const privatePath = path.join(root, "witness-private.pem");
    const publicPath = path.join(root, "witness-public.pem");
    const inputPath = path.join(root, "unsigned.json");
    const outputPath = path.join(root, "signed.json");
    const publicPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    await writeFile(privatePath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    await writeFile(publicPath, publicPem, { mode: 0o644 });
    await writeFile(inputPath, `${JSON.stringify({ schemaVersion: 1, kind: "test-record", completedAt: "2026-08-23T00:00:00.000Z", outcome: "PASS" })}\n`, { mode: 0o600 });

    const info = await run("/usr/bin/node", ["scripts/sign-qualification-record.mjs", "key-info", "--public-key", publicPath], { cwd: path.resolve(".") });
    expect(JSON.parse(info.stdout)).toEqual({ algorithm: "Ed25519", publicKeySha256: witnessPublicKeyDigest(publicPem) });
    await run("/usr/bin/node", [
      "scripts/sign-qualification-record.mjs", "sign",
      "--input", inputPath,
      "--output", outputPath,
      "--private-key", privatePath,
      "--public-key", publicPath,
      "--witness-id", "site-verifier-1",
    ], { cwd: path.resolve(".") });
    const signed = JSON.parse(await readFile(outputPath, "utf8"));
    expect(signed.witness).toMatchObject({ id: "site-verifier-1", algorithm: "Ed25519", publicKeySha256: witnessPublicKeyDigest(publicPem) });
    expect(verify(null, Buffer.from(signedRecordPayload(signed)), keys.publicKey, Buffer.from(signed.witness.signatureBase64, "base64"))).toBe(true);

    const exposedOutput = path.join(root, "must-not-exist.json");
    await chmod(privatePath, 0o644);
    await expect(run("/usr/bin/node", [
      "scripts/sign-qualification-record.mjs", "sign",
      "--input", inputPath,
      "--output", exposedOutput,
      "--private-key", privatePath,
      "--public-key", publicPath,
      "--witness-id", "site-verifier-1",
    ], { cwd: path.resolve(".") })).rejects.toThrow();
  });
});
