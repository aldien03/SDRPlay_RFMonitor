import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import matrixJson from "../config/qualification-traceability.json";
import { generateReleaseMetadata } from "../scripts/generate-release-metadata.mjs";
import { V1_COMMANDS } from "../scripts/generate-v1-validation-record.mjs";
import { RELEASE_PACKAGE_ROOTS, RELEASE_SOURCE_ROOTS } from "../scripts/release-digest-policy.mjs";
import { RESOURCE_LIMITS } from "../src/server/resourceBudget";
import { runTraceabilityValidation } from "../src/server/traceabilityCli";
import { normalizeLiveSubscription } from "../src/shared/liveSubscription";
import {
  MAX_ANALYSIS_SPAN_HZ,
  MAX_RF_ONLY_EVIDENCE_STRENGTH,
  PHYSICAL_TUNER_COUNT,
  PRODUCTION_SAMPLE_RATE_HZ,
  RF_ONLY_VERDICTS,
} from "../src/shared/productContract";
import {
  REQUIRED_TRACEABILITY_IDS,
  extractExecutableTraceabilityAssertions,
  roadmapDeliverableIds,
  roadmapQualificationGateIds,
  type TraceabilityMatrix,
  type TraceabilityRequirement,
  validateTraceabilityMatrix,
} from "../src/shared/traceability";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROADMAP_TEXT = await readFile(path.join(REPOSITORY_ROOT, "docs/production-development-roadmap.md"), "utf8");
const PACKAGE_JSON = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const MATRIX = matrixJson as TraceabilityMatrix;
const TEMPORARY_ROOTS: string[] = [];
const EXECUTABLE_ASSERTIONS = new Map<string, ReadonlySet<string>>(
  await Promise.all(Object.entries(MATRIX.references)
    .filter(([, reference]) => reference.kind === "automated-test" && reference.path)
    .map(async ([referenceId, reference]) => [
      referenceId,
      extractExecutableTraceabilityAssertions(
        await readFile(path.join(REPOSITORY_ROOT, reference.path!), "utf8"),
        `Test reference ${referenceId}`,
      ),
    ] as const)),
);

const EXPECTED_WAVE_IDS = [
  "SCP-000", "REL-010", "DOM-020", "DOM-030", "HLT-040", "RF-100",
  "SCH-110", "DET-200", "DET-201", "DET-202", "DET-210",
  "EVD-300", "EVD-310", "BUD-400", "REC-500",
  "UX-001", "UX-002", "UX-003", "UX-101", "UX-102", "UX-103", "UX-104",
  "UX-201", "UX-202", "UX-301", "UX-401", "DOC-001", "QA-001",
  "DEP-600", "OPS-700", "OPS-710",
];

afterEach(async () => {
  await Promise.all(TEMPORARY_ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cloneMatrix(): TraceabilityMatrix {
  return structuredClone(MATRIX);
}

function existingPaths(matrix: TraceabilityMatrix): Set<string> {
  return new Set([
    ...matrix.authoritativeSources,
    ...Object.values(matrix.references).flatMap((reference) => reference.path ? [reference.path] : []),
  ]);
}

function validate(matrix = cloneMatrix()) {
  return validateTraceabilityMatrix(matrix, {
    roadmapText: ROADMAP_TEXT,
    existingPaths: existingPaths(matrix),
    executableAssertions: EXECUTABLE_ASSERTIONS,
  });
}

function requirement(matrix: TraceabilityMatrix, id: string): TraceabilityRequirement {
  const found = matrix.requirements.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing test requirement ${id}`);
  return found;
}

function limitValue(matrix: TraceabilityMatrix, id: string, metric: string): number {
  const limit = requirement(matrix, id).limits?.find((entry) => entry.metric === metric);
  if (!limit) throw new Error(`Missing test limit ${id}/${metric}`);
  return limit.value;
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-traceability-"));
  TEMPORARY_ROOTS.push(root);
  const paths = new Set([
    "config/qualification-traceability.json",
    "docs/production-development-roadmap.md",
    ...MATRIX.authoritativeSources,
    ...Object.values(MATRIX.references).flatMap((reference) => reference.path ? [reference.path] : []),
  ]);
  for (const relative of paths) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await copyFile(path.join(REPOSITORY_ROOT, relative), path.join(root, relative));
  }
  return root;
}

async function releaseBoundFixture(): Promise<string> {
  const root = await repositoryFixture();
  for (const relative of new Set([...RELEASE_SOURCE_ROOTS, ...RELEASE_PACKAGE_ROOTS])) {
    const source = path.join(REPOSITORY_ROOT, relative);
    if (!await lstat(source).then(() => true, () => false)) continue;
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  }
  await generateReleaseMetadata({ repositoryRoot: root, environment: {} });
  return root;
}

describe("V0 claims and traceability", () => {
  it("[trace:V0] validates every catalogued requirement and the real repository references", async () => {
    const report = await runTraceabilityValidation({ repositoryRoot: REPOSITORY_ROOT });
    expect(report).toMatchObject({
      valid: true,
      requirements: 112,
      risks: 10,
      references: 60,
      byCategory: {
        "wave-deliverable": 31,
        "product-invariant": 15,
        "hardware-invariant": 8,
        slo: 23,
        "resource-bound": 20,
        "prohibited-claim": 7,
        "qualification-gate": 8,
      },
      qualificationGates: ["V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7"],
      externalGatesNotRun: ["V5", "V6", "V7"],
      releaseBinding: { state: "unbound" },
    });
  });

  it("[trace:SCP-000] keeps exact independent coverage registries for deliverables, invariants, bounds, claims, and gates", () => {
    expect(roadmapDeliverableIds(ROADMAP_TEXT)).toEqual(EXPECTED_WAVE_IDS);
    expect(roadmapQualificationGateIds(ROADMAP_TEXT)).toEqual(Array.from({ length: 8 }, (_, index) => `V${index}`));
    for (const [category, ids] of Object.entries(REQUIRED_TRACEABILITY_IDS)) {
      expect(MATRIX.requirements.filter((entry) => entry.category === category).map((entry) => entry.id)).toEqual(ids);
    }
    expect(validate()).toMatchObject({ valid: true, requirements: 112 });
  });

  it("matches hardware and resource rows to the executable product contract", () => {
    expect(requirement(MATRIX, "HW-002").contractValues?.physicalTunerCount).toBe(PHYSICAL_TUNER_COUNT);
    expect(requirement(MATRIX, "HW-003").contractValues?.sampleRateHz).toBe(PRODUCTION_SAMPLE_RATE_HZ);
    expect(requirement(MATRIX, "HW-004").contractValues?.maximumAnalysisSpanHz).toBe(MAX_ANALYSIS_SPAN_HZ);
    expect(requirement(MATRIX, "HW-006").contractValues?.iqEnabled).toBe(false);
    expect(MAX_RF_ONLY_EVIDENCE_STRENGTH).toBe("Medium");
    expect(RF_ONLY_VERDICTS).not.toContain("GNSS spoofing");

    expect(limitValue(MATRIX, "RES-012", "rss-pressure")).toBe(RESOURCE_LIMITS.pressureRssBytes);
    expect(limitValue(MATRIX, "RES-013", "rss-critical")).toBe(RESOURCE_LIMITS.criticalRssBytes);
    expect(limitValue(MATRIX, "RES-014", "heap-pressure") / 100).toBe(RESOURCE_LIMITS.pressureHeapUtilization);
    expect(limitValue(MATRIX, "RES-015", "external-buffer-pressure")).toBe(RESOURCE_LIMITS.pressureExternalBytes);
    expect(limitValue(MATRIX, "RES-016", "writer-oldest-age-critical")).toBe(RESOURCE_LIMITS.criticalWriterOldestAgeMs);
    for (const rateHz of [0.2, 2, 4] as const) {
      expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz, engineer: rateHz === 4 })).toBeDefined();
    }
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 4, engineer: false })).toBeUndefined();
  });

  it("keeps release identity external and all unexecuted qualification gates fail-closed", async () => {
    expect(MATRIX.bindingMode).toBe("external-release-record");
    expect(requirement(MATRIX, "V0").status).toBe("evidence-ready");
    for (const gate of ["V1", "V2", "V3", "V4", "V5", "V6", "V7"]) {
      expect(requirement(MATRIX, gate).status).toBe("not-run");
    }
    for (const gate of ["V5", "V6", "V7"]) {
      expect(requirement(MATRIX, gate).externalEvidenceRequired).toBe(true);
      expect(requirement(MATRIX, gate).verificationRefs.every((id) => MATRIX.references[id]?.kind !== "external-evidence")).toBe(true);
    }
    const historical = MATRIX.references["artifact-v1"];
    const record = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, historical.path!), "utf8"));
    expect(historical.historical).toBe(true);
    expect(historical.release).toEqual({
      buildId: record.release.buildId,
      sourceDigest: record.release.sourceDigest,
      packageDigest: record.release.packageDigest,
    });
  });

  it("keeps the required command surface bounded to V0-V7 and production qualification live-data only", () => {
    const scripts = PACKAGE_JSON.scripts ?? {};
    const gateCommands = Object.keys(scripts).filter((name) => /(?:^|:)v\d/i.test(name));
    expect(gateCommands.length).toBeGreaterThan(0);
    expect(gateCommands.every((name) => /^validate:v[0-7](?::|$)/i.test(name))).toBe(true);
    expect(JSON.stringify(scripts)).not.toMatch(/(?:external:)?v(?:8|9)|72[- ]?hour|30[- ]?day/i);
    expect(ROADMAP_TEXT).toMatch(/Production qualification is live-data only/);
    expect(requirement(MATRIX, "V5").statement).toMatch(/real RSPdx\/RSPdx R2/);
    expect(requirement(MATRIX, "V6").statement).toMatch(/real-receiver/);
    expect(requirement(MATRIX, "V7").statement).toMatch(/live field-domain/);
  });

  it("wires traceability into the system-Node V1 record after build and binds test sources into release identity", () => {
    const buildIndex = V1_COMMANDS.findIndex((command) => command.id === "build");
    const traceabilityIndex = V1_COMMANDS.findIndex((command) => command.id === "traceability");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(traceabilityIndex).toBeGreaterThan(buildIndex);
    expect(V1_COMMANDS[traceabilityIndex]).toEqual({ id: "traceability", command: "/usr/bin/npm", args: ["run", "validate:v0"] });
    expect(RELEASE_SOURCE_ROOTS).toEqual(expect.arrayContaining(["src", "scripts", "tests", "config", "docs", "package-lock.json"]));
  });

  it("binds to a real release tree externally and rejects source tampering without changing the matrix", async () => {
    const root = await releaseBoundFixture();
    await expect(runTraceabilityValidation({ repositoryRoot: root, releasePath: "dist/release.json" })).resolves.toMatchObject({
      valid: true,
      releaseBinding: {
        state: "verified",
        buildId: expect.stringMatching(/^1\.0\.0\+[a-f0-9]{12}$/),
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const source = path.join(root, "src/shared/productContract.ts");
    await writeFile(source, `${await readFile(source, "utf8")}\n// tampered after release\n`);
    await expect(runTraceabilityValidation({ repositoryRoot: root, releasePath: "dist/release.json" })).rejects.toThrow(/binding is stale/i);
    expect(MATRIX.bindingMode).toBe("external-release-record");
  });

  it("rejects self-consistent matrix truncation and malformed bound rows", () => {
    const missingSlo = cloneMatrix();
    missingSlo.requirements = missingSlo.requirements.filter((entry) => entry.id !== "SLO-024");
    expect(() => validate(missingSlo)).toThrow(/slo coverage mismatch/i);

    const missingWave = cloneMatrix();
    missingWave.requirements = missingWave.requirements.filter((entry) => entry.id !== "DET-210");
    expect(() => validate(missingWave)).toThrow(/Wave deliverable coverage mismatch/i);

    const noLimits = cloneMatrix();
    delete requirement(noLimits, "RES-012").limits;
    expect(() => validate(noLimits)).toThrow(/has no structured limit/i);
  });

  it("rejects unsupported completion claims, stale immutable evidence, and external-gate promotion", () => {
    const stale = cloneMatrix();
    stale.references["artifact-v1"].historical = false;
    expect(() => validate(stale)).toThrow(/source registry must be historical/i);

    const externalPass = cloneMatrix();
    requirement(externalPass, "V6").status = "passed";
    expect(() => validate(externalPass)).toThrow(/cannot pass without external evidence/i);

    const unsupported = cloneMatrix();
    requirement(unsupported, "PROD-005").status = "passed";
    requirement(unsupported, "PROD-005").blockers = undefined;
    expect(() => validate(unsupported)).toThrow(/without both executable assertion and evidence/i);
  });

  it("requires an exact executable requirement marker instead of an unrelated test filename", () => {
    const missingMap = cloneMatrix();
    delete requirement(missingMap, "RF-100").assertionRefs;
    expect(() => validate(missingMap)).toThrow(/without both executable assertion and evidence/i);

    const unrelated = cloneMatrix();
    requirement(unrelated, "RF-100").verificationRefs = ["test-product-contract", "evidence-rf-gate"];
    requirement(unrelated, "RF-100").assertionRefs = ["test-product-contract"];
    expect(() => validate(unrelated)).toThrow(/no executable \[trace:RF-100\] assertion/i);

    const outsideVerification = cloneMatrix();
    requirement(outsideVerification, "RF-100").assertionRefs = ["test-product-contract"];
    expect(() => validate(outsideVerification)).toThrow(/not a verification reference/i);

    const nonTest = cloneMatrix();
    requirement(nonTest, "RF-100").verificationRefs.push("evidence-v0");
    requirement(nonTest, "RF-100").assertionRefs = ["evidence-v0"];
    expect(() => validate(nonTest)).toThrow(/not an automated test/i);

    const unbounded = cloneMatrix();
    requirement(unbounded, "RF-100").assertionRefs = Array.from({ length: 9 }, (_, index) => `test-${index}`);
    expect(() => validate(unbounded)).toThrow(/invalid or exceed their bound/i);
  });

  it("extracts only direct literal Vitest titles and fails closed on marker-shaped text elsewhere", () => {
    const marker = (id: string) => `[tra${"ce"}:${id}]`;
    expect(extractExecutableTraceabilityAssertions(`\n  it("${marker("HW-001")} exact model", () => {});\n`)).toEqual(new Set(["HW-001"]));
    expect(extractExecutableTraceabilityAssertions(`\n  test('${marker("V0")} matrix', () => {});\n`)).toEqual(new Set(["V0"]));

    for (const invalid of [
      `\n  helper.it("${marker("HW-001")} member", () => {});\n`,
      `\n  it.skip("${marker("HW-001")} skipped", () => {});\n`,
      `\n  it.only("${marker("HW-001")} focused", () => {});\n`,
      `\n  it.todo("${marker("HW-001")} todo");\n`,
      `\n  it.each([])("${marker("HW-001")} parameterized", () => {});\n`,
      `\n  // it("${marker("HW-001")} comment", () => {});\n`,
      `\n  /it\\(\"${marker("HW-001")} regex\"/;\n`,
      `\n  it(\`${marker("HW-001")} ${"${dynamic}"}\`, () => {});\n`,
    ]) expect(() => extractExecutableTraceabilityAssertions(invalid)).toThrow(/trace marker|dynamic traced/i);
  });

  it("rejects symlinked references and declared immutable identities that differ from the record", async () => {
    const root = await repositoryFixture();
    const testPath = path.join(root, "tests/productContract.test.ts");
    await rm(testPath);
    await symlink("baselineStore.test.ts", testPath);
    await expect(runTraceabilityValidation({ repositoryRoot: root })).rejects.toThrow(/symbolic link/i);

    await rm(testPath);
    await copyFile(path.join(REPOSITORY_ROOT, "tests/productContract.test.ts"), testPath);
    const artifactPath = path.join(root, MATRIX.references["artifact-v1"].path!);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    artifact.release.sourceDigest = "0".repeat(64);
    await rm(artifactPath);
    await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`);
    await expect(runTraceabilityValidation({ repositoryRoot: root })).rejects.toThrow(/release identity does not match/i);
  });

  it("requires a bounded mapped risk register and current evidence for every completed row", () => {
    const noRisk = cloneMatrix();
    noRisk.risks = noRisk.risks.slice(0, 7);
    expect(() => validate(noRisk)).toThrow(/risk register is incomplete/i);

    const historicalOnly = cloneMatrix();
    requirement(historicalOnly, "CLAIM-001").verificationRefs = ["test-product-contract", "artifact-v1"];
    expect(() => validate(historicalOnly)).toThrow(/without both executable assertion and evidence/i);
  });
});
