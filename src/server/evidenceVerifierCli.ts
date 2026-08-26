#!/usr/bin/env node
import path from "node:path";
import { verifyEvidenceDirectory, verifyMultipartEvidenceDirectories } from "./evidenceVerifier";

const arguments_ = process.argv.slice(2);
const json = arguments_.includes("--json");
const multipart = arguments_.includes("--multipart");
const targets = arguments_.filter((argument) => argument !== "--json" && argument !== "--multipart");

if (!targets.length) {
  process.stderr.write("Usage: evidence-verifier [--json] [--multipart] DIRECTORY [DIRECTORY ...]\n");
  process.exitCode = 64;
} else {
  const absoluteTargets = targets.map((target) => path.resolve(target));
  const results = multipart
    ? [{ path: absoluteTargets.join(","), ...(await verifyMultipartEvidenceDirectories(absoluteTargets)) }]
    : await Promise.all(absoluteTargets.map(async (absolutePath) => ({
        path: absolutePath,
        ...(await verifyEvidenceDirectory(absolutePath)),
      })));
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const detail = result.reasons.length ? ` — ${result.reasons.join(", ")}` : "";
      process.stdout.write(`${result.outcome}  ${result.path}${detail}\n`);
    }
  }
  process.exitCode = results.some((result) => result.outcome === "FAIL")
    ? 1
    : results.some((result) => result.outcome === "INCOMPLETE") ? 2 : 0;
}
