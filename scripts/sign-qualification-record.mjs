#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

const SYSTEM_NODE = "/usr/bin/node";
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function value(name) {
  const index = process.argv.indexOf(name);
  assertion(index >= 0, `${name}-required`);
  const result = process.argv[index + 1];
  assertion(result && !result.startsWith("--"), `${name}-value-required`);
  return result;
}

function absolute(name) {
  const candidate = value(name);
  assertion(path.isAbsolute(candidate), `${name}-must-be-absolute`);
  return path.resolve(candidate);
}

function canonicalJson(input) {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  if (input !== null && typeof input === "object") return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
  return JSON.stringify(input);
}

async function assertNoSymlinks(filePath, allowMissingFinal = false) {
  assertion(path.isAbsolute(filePath), "witness-path-must-be-absolute");
  const resolved = path.resolve(filePath);
  assertion(resolved !== path.parse(resolved).root, "witness-filesystem-root-refused");
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      assertion(!details.isSymbolicLink(), `witness-symlink-refused:${current}`);
      if (index < segments.length - 1) assertion(details.isDirectory(), `witness-path-component-not-directory:${current}`);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingFinal && index === segments.length - 1) return;
      throw error;
    }
  }
}

async function readBounded(filePath, maximumBytes, privateKey = false) {
  await assertNoSymlinks(filePath);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    assertion(details.isFile() && details.size > 0 && details.size <= maximumBytes, `witness-input-file-invalid:${filePath}`);
    if (privateKey) assertion((details.mode & 0o077) === 0, "witness-private-key-permissions-must-be-0600-or-stricter");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeNoReplace(filePath, contents) {
  await assertNoSymlinks(path.dirname(filePath));
  await assertNoSymlinks(filePath, true);
  const temporary = `${filePath}.${randomUUID()}.partial`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o440);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function keyDigest(key) {
  return createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
}

function usage() {
  process.stdout.write([
    "RF Monitor offline qualification witness",
    "",
    "Commands:",
    "  /usr/bin/node scripts/sign-qualification-record.mjs key-info --public-key ABS",
    "  /usr/bin/node scripts/sign-qualification-record.mjs sign --input ABS --output ABS --private-key ABS --public-key ABS --witness-id ID",
    "",
    "Run this on the independent witness workstation. Never copy the private key to the RF Monitor host.",
  ].join("\n") + "\n");
}

async function main() {
  assertion(process.execPath === SYSTEM_NODE, `witness-tool-requires-system-node:${SYSTEM_NODE}`);
  const command = String(process.argv[2] ?? "");
  if (process.argv.includes("--help") || !["key-info", "sign"].includes(command)) {
    usage();
    if (!process.argv.includes("--help")) process.exitCode = 2;
    return;
  }
  const publicKeyPath = absolute("--public-key");
  const publicKey = createPublicKey(await readBounded(publicKeyPath, MAX_KEY_BYTES));
  assertion(publicKey.asymmetricKeyType === "ed25519", "witness-public-key-must-be-ed25519");
  const publicKeySha256 = keyDigest(publicKey);
  if (command === "key-info") {
    process.stdout.write(`${JSON.stringify({ algorithm: "Ed25519", publicKeySha256 })}\n`);
    return;
  }

  const privateKeyPath = absolute("--private-key");
  const privateKey = createPrivateKey(await readBounded(privateKeyPath, MAX_KEY_BYTES, true));
  assertion(privateKey.asymmetricKeyType === "ed25519", "witness-private-key-must-be-ed25519");
  const derivedPublicKey = createPublicKey(privateKey);
  assertion(keyDigest(derivedPublicKey) === publicKeySha256, "witness-private-public-key-mismatch");
  const witnessId = value("--witness-id");
  assertion(SAFE_ID.test(witnessId), "witness-id-invalid");
  const inputPath = absolute("--input");
  const outputPath = absolute("--output");
  assertion(inputPath !== outputPath && privateKeyPath !== outputPath && publicKeyPath !== outputPath, "witness-output-path-conflict");
  const record = JSON.parse((await readBounded(inputPath, MAX_RECORD_BYTES)).toString("utf8"));
  assertion(record !== null && typeof record === "object" && !Array.isArray(record), "witness-record-object-required");
  assertion(!record.witness?.signatureBase64, "witness-record-already-signed");
  const completedAt = Date.parse(record.completedAt);
  assertion(Number.isFinite(completedAt), "witness-record-completed-at-invalid");
  const signedAt = new Date().toISOString();
  assertion(completedAt <= Date.parse(signedAt), "witness-refuses-future-completion");
  const unsigned = {
    ...record,
    witness: {
      id: witnessId,
      algorithm: "Ed25519",
      signedAt,
      publicKeySha256,
    },
  };
  const signatureBase64 = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64");
  const signedRecord = { ...unsigned, witness: { ...unsigned.witness, signatureBase64 } };
  await writeNoReplace(outputPath, `${JSON.stringify(signedRecord, null, 2)}\n`);
  process.stdout.write(`SIGNED ${outputPath}\npublicKeySha256=${publicKeySha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
