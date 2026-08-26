export const TRACEABILITY_SCHEMA_VERSION = 2 as const;
export const TRACEABILITY_MATRIX_VERSION = "rf-monitor-v0-2026.08.23.4" as const;

export const TRACEABILITY_CATEGORIES = [
  "wave-deliverable",
  "product-invariant",
  "hardware-invariant",
  "slo",
  "resource-bound",
  "prohibited-claim",
  "qualification-gate",
] as const;

export type TraceabilityCategory = typeof TRACEABILITY_CATEGORIES[number];
export type TraceabilityStatus = "passed" | "evidence-ready" | "in-progress" | "blocked" | "not-run" | "failed";
export type TraceabilityReferenceKind =
  | "automated-test"
  | "evidence-record"
  | "immutable-artifact"
  | "documentation"
  | "planned-evidence"
  | "external-evidence";

export interface TraceabilityReleaseBinding {
  buildId: string;
  sourceDigest: string;
  packageDigest: string;
}

export interface TraceabilityReference {
  kind: TraceabilityReferenceKind;
  path?: string;
  description: string;
  gate?: `V${number}`;
  /** Immutable artifacts must identify the exact release they tested. */
  release?: TraceabilityReleaseBinding;
  /** Historical artifacts remain useful provenance but cannot qualify this candidate. */
  historical?: boolean;
}

export interface TraceabilityLimit {
  metric: string;
  comparator: "<" | "<=" | "=" | ">=" | ">";
  value: number;
  unit: string;
  window?: string;
}

export interface TraceabilityRequirement {
  id: string;
  category: TraceabilityCategory;
  statement: string;
  source: string;
  status: TraceabilityStatus;
  dependsOn?: string[];
  verificationRefs: string[];
  /**
   * Automated-test references whose executable Vitest title carries this
   * requirement's exact `[trace:REQUIREMENT-ID]` marker.
   */
  assertionRefs?: string[];
  blockers?: string[];
  limitations?: string[];
  limits?: TraceabilityLimit[];
  contractValues?: Record<string, string | number | boolean>;
  prohibitedClaims?: string[];
  externalEvidenceRequired?: boolean;
}

export interface TraceabilityRisk {
  id: string;
  risk: string;
  consequence: string;
  mitigationRequirementIds: string[];
  ownerRole: string;
  status: "open" | "controlled" | "blocked";
  verificationRefs: string[];
}

export interface TraceabilityMatrix {
  schemaVersion: typeof TRACEABILITY_SCHEMA_VERSION;
  matrixVersion: typeof TRACEABILITY_MATRIX_VERSION;
  generatedAt: string;
  /** Candidate identity is carried by an outer immutable validation record. */
  bindingMode: "external-release-record";
  authoritativeSources: string[];
  references: Record<string, TraceabilityReference>;
  requirements: TraceabilityRequirement[];
  risks: TraceabilityRisk[];
}

export interface TraceabilityValidationReport {
  schemaVersion: 2;
  valid: true;
  matrixVersion: string;
  requirements: number;
  risks: number;
  references: number;
  byCategory: Record<TraceabilityCategory, number>;
  byStatus: Record<TraceabilityStatus, number>;
  roadmapDeliverables: string[];
  qualificationGates: string[];
  externalGatesNotRun: string[];
  releaseBinding: { state: "unbound" } | ({ state: "verified" } & TraceabilityReleaseBinding);
}

const STATUS_VALUES = new Set<TraceabilityStatus>(["passed", "evidence-ready", "in-progress", "blocked", "not-run", "failed"]);
const CATEGORY_VALUES = new Set<TraceabilityCategory>(TRACEABILITY_CATEGORIES);
const REFERENCE_KINDS = new Set<TraceabilityReferenceKind>([
  "automated-test", "evidence-record", "immutable-artifact", "documentation", "planned-evidence", "external-evidence",
]);
const COMPARATORS = new Set(["<", "<=", "=", ">=", ">"]);
const CONCRETE_REFERENCE_KINDS = new Set<TraceabilityReferenceKind>(["automated-test", "evidence-record", "immutable-artifact", "documentation", "external-evidence"]);
const EXTERNAL_GATES = new Set(["V5", "V6", "V7"]);
const MAX_ASSERTION_REFS_PER_REQUIREMENT = 8;
const MAX_EXECUTABLE_ASSERTIONS_PER_TEST_REFERENCE = 128;
const TRACE_MARKER = /\[trace:((?:[A-Z]{2,12}-\d{3}|V\d))\]/g;

/**
 * Independent coverage contract. The matrix is intentionally not allowed to
 * redefine its own completeness by deleting a row and decrementing a count.
 * Roadmap deliverables and gates are extracted from the roadmap; the remaining
 * stable IDs are checked against this registry.
 */
export const REQUIRED_TRACEABILITY_IDS = Object.freeze({
  "product-invariant": [
    "PROD-001", "PROD-002", "PROD-003", "PROD-004", "PROD-005", "PROD-006", "PROD-007",
    "TRUTH-001", "TRUTH-002", "TRUTH-003", "TRUTH-004",
    "RUNTIME-001", "RUNTIME-002", "RUNTIME-003", "RUNTIME-004",
  ],
  "hardware-invariant": ["HW-001", "HW-002", "HW-003", "HW-004", "HW-005", "HW-006", "HW-007", "HW-008"],
  // SLO-022 is retired. No required development objective may exceed 24 hours.
  slo: [
    ...Array.from({ length: 21 }, (_, index) => `SLO-${String(index + 1).padStart(3, "0")}`),
    "SLO-023",
    "SLO-024",
  ],
  "resource-bound": Array.from({ length: 20 }, (_, index) => `RES-${String(index + 1).padStart(3, "0")}`),
  "prohibited-claim": Array.from({ length: 7 }, (_, index) => `CLAIM-${String(index + 1).padStart(3, "0")}`),
} as const satisfies Record<Exclude<TraceabilityCategory, "wave-deliverable" | "qualification-gate">, readonly string[]>);

function nonEmptyText(value: unknown, label: string, maximum = 1_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be non-empty and at most ${maximum} characters`);
  return value;
}

function safeRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return normalized;
}

function exactIdList(actual: string[], expected: string[], label: string): void {
  const observed = [...new Set(actual)].sort();
  const required = [...new Set(expected)].sort();
  const missing = required.filter((id) => !observed.includes(id));
  const unexpected = observed.filter((id) => !required.includes(id));
  if (missing.length || unexpected.length || actual.length !== observed.length) {
    throw new Error(`${label} mismatch; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}], duplicates=${actual.length - observed.length}`);
  }
}

function releaseBinding(value: unknown, label: string): TraceabilityReleaseBinding {
  const binding = value as TraceabilityReleaseBinding;
  if (!binding || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(String(binding.buildId ?? ""))) {
    throw new Error(`${label} buildId is invalid`);
  }
  for (const field of ["sourceDigest", "packageDigest"] as const) {
    if (!/^[a-f0-9]{64}$/.test(String(binding[field] ?? ""))) throw new Error(`${label} ${field} is invalid`);
  }
  return binding;
}

/**
 * Extracts trace markers only from literal direct `it(title, ...)` and
 * `test(title, ...)` calls that begin a source line (apart from indentation).
 * Any marker elsewhere fails closed, including comments, regexes, member
 * calls, `.skip`/`.todo`/`.each`, and dynamic titles.
 */
export function extractExecutableTraceabilityAssertions(source: string, label = "Automated test"): ReadonlySet<string> {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) {
    throw new Error(`${label} source exceeds the 2 MiB traceability bound`);
  }
  const assertions = new Set<string>();
  const length = source.length;

  const skipQuoted = (start: number, quote: string): number => {
    let index = start + 1;
    while (index < length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === quote) return index + 1;
      index += 1;
    }
    return length;
  };

  const skipTrivia = (start: number): number => {
    let index = start;
    while (index < length) {
      if (/\s/.test(source[index])) {
        index += 1;
        continue;
      }
      if (source[index] === "/" && source[index + 1] === "/") {
        index = source.indexOf("\n", index + 2);
        if (index < 0) return length;
        continue;
      }
      if (source[index] === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) return length;
        index = end + 2;
        continue;
      }
      break;
    }
    return index;
  };

  let index = 0;
  while (index < length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    if (["\"", "'", "`"].includes(source[index])) {
      index = skipQuoted(index, source[index]);
      continue;
    }
    const token = source.startsWith("test", index) ? "test" : source.startsWith("it", index) ? "it" : undefined;
    const tokenEnd = token ? index + token.length : index;
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    if (!token
      || (index > 0 && /[A-Za-z0-9_$]/.test(source[index - 1]))
      || source.slice(lineStart, index).trim().length > 0
      || (tokenEnd < length && /[A-Za-z0-9_$]/.test(source[tokenEnd]))) {
      index += 1;
      continue;
    }
    let cursor = skipTrivia(tokenEnd);
    if (source[cursor] !== "(") {
      index = tokenEnd;
      continue;
    }
    cursor = skipTrivia(cursor + 1);
    const quote = source[cursor];
    if (!["\"", "'", "`"].includes(quote)) {
      index = tokenEnd;
      continue;
    }
    const titleStart = cursor + 1;
    const afterTitle = skipQuoted(cursor, quote);
    if (afterTitle > length || source[afterTitle - 1] !== quote) {
      throw new Error(`${label} has an unterminated traced test title`);
    }
    const title = source.slice(titleStart, afterTitle - 1);
    if (quote === "`" && title.includes("${")) {
      if (title.includes("[trace:")) throw new Error(`${label} uses a dynamic traced test title`);
      index = afterTitle;
      continue;
    }
    cursor = skipTrivia(afterTitle);
    if (source[cursor] !== ",") {
      index = afterTitle;
      continue;
    }
    for (const marker of title.matchAll(TRACE_MARKER)) {
      if (assertions.has(marker[1])) throw new Error(`${label} repeats executable trace marker ${marker[1]}`);
      assertions.add(marker[1]);
      if (assertions.size > MAX_EXECUTABLE_ASSERTIONS_PER_TEST_REFERENCE) {
        throw new Error(`${label} exceeds ${MAX_EXECUTABLE_ASSERTIONS_PER_TEST_REFERENCE} executable trace markers`);
      }
    }
    index = afterTitle;
  }
  const rawMarkers = [...source.matchAll(TRACE_MARKER)].map((match) => match[1]);
  if (rawMarkers.length !== assertions.size || rawMarkers.some((id) => !assertions.has(id))) {
    throw new Error(`${label} contains a trace marker outside a direct executable it/test title`);
  }
  return assertions;
}

export function roadmapDeliverableIds(roadmapText: string): string[] {
  const section = roadmapText.split("## 6. Engineering Work Breakdown")[1]?.split("## 7. Operator Recovery Contract")[0];
  if (!section) throw new Error("Roadmap engineering work-breakdown section is missing");
  return [...section.matchAll(/^\|\s*`([A-Z]{2,4}-\d{3})`\s*\|/gm)].map((match) => match[1]);
}

export function roadmapQualificationGateIds(roadmapText: string): string[] {
  const section = roadmapText
    .split("## 8. Verification and Qualification Ladder")[1]
    ?.split("### Optional site-owned assurance records")[0];
  if (!section) throw new Error("Roadmap qualification-ladder section is missing");
  return [...section.matchAll(/^\|\s*`(V\d)`[^|]*\|/gm)].map((match) => match[1]);
}

export function validateTraceabilityMatrix(
  input: unknown,
  context: {
    roadmapText: string;
    existingPaths: ReadonlySet<string>;
    executableAssertions: ReadonlyMap<string, ReadonlySet<string>>;
    release?: TraceabilityReleaseBinding;
  },
): TraceabilityValidationReport {
  const matrix = input as TraceabilityMatrix;
  if (!matrix || matrix.schemaVersion !== TRACEABILITY_SCHEMA_VERSION || matrix.matrixVersion !== TRACEABILITY_MATRIX_VERSION) {
    throw new Error("Traceability matrix schema/version is unsupported");
  }
  if (matrix.bindingMode !== "external-release-record") throw new Error("Traceability release binding mode is invalid");
  const verifiedRelease = context.release ? releaseBinding(context.release, "External release") : undefined;
  if (!Number.isFinite(Date.parse(nonEmptyText(matrix.generatedAt, "generatedAt")))) throw new Error("Traceability generatedAt is invalid");
  if (!Array.isArray(matrix.authoritativeSources) || matrix.authoritativeSources.length < 2) throw new Error("Traceability authoritative sources are incomplete");
  for (const [index, source] of matrix.authoritativeSources.entries()) {
    const sourcePath = safeRelativePath(nonEmptyText(source, `authoritativeSources[${index}]`, 300), `authoritativeSources[${index}]`);
    if (!context.existingPaths.has(sourcePath)) throw new Error(`Authoritative source does not exist: ${sourcePath}`);
  }
  if (!matrix.references || typeof matrix.references !== "object" || Array.isArray(matrix.references)) throw new Error("Traceability references are invalid");
  const referenceEntries = Object.entries(matrix.references);
  if (!referenceEntries.length || referenceEntries.length > 256) throw new Error("Traceability reference catalog is empty or exceeds its bound");
  for (const [id, reference] of referenceEntries) {
    if (!/^[a-z][a-z0-9-]{2,79}$/.test(id) || !reference || !REFERENCE_KINDS.has(reference.kind)) throw new Error(`Traceability reference ${id} is invalid`);
    nonEmptyText(reference.description, `Reference ${id} description`, 500);
    if (CONCRETE_REFERENCE_KINDS.has(reference.kind)) {
      const referencePath = safeRelativePath(nonEmptyText(reference.path, `Reference ${id} path`, 300), `Reference ${id} path`);
      if (!context.existingPaths.has(referencePath)) throw new Error(`Traceability reference path does not exist: ${referencePath}`);
    } else if (reference.path !== undefined) {
      throw new Error(`Planned reference ${id} cannot claim an existing evidence path`);
    }
    if (reference.kind === "immutable-artifact") {
      releaseBinding(reference.release, `Reference ${id} release`);
      if (reference.historical !== true) throw new Error(`Immutable reference ${id} in the source registry must be historical`);
    } else if (reference.release !== undefined || reference.historical !== undefined) {
      throw new Error(`Non-immutable reference ${id} cannot carry release-binding fields`);
    }
    if (reference.gate !== undefined && !/^V\d$/.test(reference.gate)) throw new Error(`Reference ${id} gate is invalid`);
  }
  if (!Array.isArray(matrix.requirements) || !matrix.requirements.length || matrix.requirements.length > 256) throw new Error("Traceability requirements are empty or exceed their bound");
  const requirementIds = new Set<string>();
  const byCategory = Object.fromEntries(TRACEABILITY_CATEGORIES.map((category) => [category, 0])) as Record<TraceabilityCategory, number>;
  const statusValues: TraceabilityStatus[] = ["passed", "evidence-ready", "in-progress", "blocked", "not-run", "failed"];
  const byStatus = Object.fromEntries(statusValues.map((status) => [status, 0])) as Record<TraceabilityStatus, number>;
  for (const [index, requirement] of matrix.requirements.entries()) {
    if (!requirement || !/^(?:[A-Z]{2,12}-\d{3}|V\d)$/.test(requirement.id) || requirementIds.has(requirement.id)) throw new Error(`Requirement ${index} has an invalid or duplicate id`);
    requirementIds.add(requirement.id);
    if (!CATEGORY_VALUES.has(requirement.category) || !STATUS_VALUES.has(requirement.status)) throw new Error(`Requirement ${requirement.id} category/status is invalid`);
    byCategory[requirement.category] += 1;
    byStatus[requirement.status] += 1;
    nonEmptyText(requirement.statement, `${requirement.id} statement`);
    nonEmptyText(requirement.source, `${requirement.id} source`, 300);
    if (!Array.isArray(requirement.verificationRefs) || !requirement.verificationRefs.length || new Set(requirement.verificationRefs).size !== requirement.verificationRefs.length) {
      throw new Error(`Requirement ${requirement.id} verification references are empty or duplicated`);
    }
    const references = requirement.verificationRefs.map((id) => {
      const reference = matrix.references[id];
      if (!reference) throw new Error(`Requirement ${requirement.id} references unknown evidence ${id}`);
      return reference;
    });
    if (requirement.assertionRefs !== undefined
      && (!Array.isArray(requirement.assertionRefs)
        || !requirement.assertionRefs.length
        || requirement.assertionRefs.length > MAX_ASSERTION_REFS_PER_REQUIREMENT
        || new Set(requirement.assertionRefs).size !== requirement.assertionRefs.length)) {
      throw new Error(`Requirement ${requirement.id} executable assertion references are invalid or exceed their bound`);
    }
    for (const assertionRef of requirement.assertionRefs ?? []) {
      if (!requirement.verificationRefs.includes(assertionRef)) {
        throw new Error(`Requirement ${requirement.id} executable assertion ${assertionRef} is not a verification reference`);
      }
      if (matrix.references[assertionRef]?.kind !== "automated-test") {
        throw new Error(`Requirement ${requirement.id} executable assertion ${assertionRef} is not an automated test`);
      }
      if (!context.executableAssertions.get(assertionRef)?.has(requirement.id)) {
        throw new Error(`Requirement ${requirement.id} has no executable [trace:${requirement.id}] assertion in ${assertionRef}`);
      }
    }
    if (requirement.category === "qualification-gate" && EXTERNAL_GATES.has(requirement.id)
      && (!requirement.externalEvidenceRequired || !["not-run", "blocked"].includes(requirement.status))) {
      throw new Error(`External qualification gate ${requirement.id} cannot pass without external evidence`);
    }
    if (requirement.dependsOn?.some((id) => id === requirement.id)) throw new Error(`Requirement ${requirement.id} depends on itself`);
    if (["passed", "evidence-ready"].includes(requirement.status)) {
      const currentEvidence = references.some((reference) => reference.kind === "evidence-record");
      if (!requirement.assertionRefs?.length || !currentEvidence) {
        throw new Error(`Requirement ${requirement.id} claims ${requirement.status} without both executable assertion and evidence references`);
      }
    } else if (!requirement.blockers?.length && !references.some((reference) => reference.kind === "planned-evidence")) {
      throw new Error(`Requirement ${requirement.id} is ${requirement.status} without a blocker or planned evidence`);
    }
    if (["slo", "resource-bound"].includes(requirement.category)) {
      if (!Array.isArray(requirement.limits) || !requirement.limits.length) throw new Error(`Requirement ${requirement.id} has no structured limit`);
      for (const limit of requirement.limits) {
        nonEmptyText(limit.metric, `${requirement.id} metric`, 120);
        if (!COMPARATORS.has(limit.comparator) || !Number.isFinite(limit.value)) throw new Error(`Requirement ${requirement.id} has an invalid limit`);
        nonEmptyText(limit.unit, `${requirement.id} unit`, 60);
      }
    }
    if (requirement.category === "hardware-invariant" && (!requirement.contractValues || !Object.keys(requirement.contractValues).length)) {
      throw new Error(`Hardware requirement ${requirement.id} has no structured contract value`);
    }
    if (requirement.category === "prohibited-claim" && (!requirement.prohibitedClaims?.length || requirement.status !== "passed")) {
      throw new Error(`Prohibited claim ${requirement.id} is not mechanically enforced`);
    }
    if (requirement.category === "qualification-gate") {
      if (!/^V\d$/.test(requirement.id)) throw new Error(`Qualification gate ${requirement.id} is invalid`);
      if (EXTERNAL_GATES.has(requirement.id)) {
        if (!requirement.externalEvidenceRequired || !["not-run", "blocked"].includes(requirement.status)) {
          throw new Error(`External qualification gate ${requirement.id} cannot pass without external evidence`);
        }
        if (references.some((reference) => reference.kind === "external-evidence")) {
          throw new Error(`External qualification gate ${requirement.id} claims evidence that is not available`);
        }
      }
      if (requirement.status === "passed") throw new Error(`Qualification gate ${requirement.id} pass state belongs in an external immutable record`);
    }
  }
  for (const requirement of matrix.requirements) {
    for (const dependency of requirement.dependsOn ?? []) {
      if (!requirementIds.has(dependency)) throw new Error(`Requirement ${requirement.id} depends on unknown ${dependency}`);
    }
  }
  const roadmapIds = roadmapDeliverableIds(context.roadmapText);
  const matrixWaveIds = matrix.requirements.filter((requirement) => requirement.category === "wave-deliverable").map((requirement) => requirement.id);
  exactIdList(matrixWaveIds, roadmapIds, "Wave deliverable coverage");
  const gateIds = roadmapQualificationGateIds(context.roadmapText);
  const matrixGateIds = matrix.requirements.filter((requirement) => requirement.category === "qualification-gate").map((requirement) => requirement.id);
  exactIdList(matrixGateIds, gateIds, "Qualification gate coverage");
  for (const [category, expectedIds] of Object.entries(REQUIRED_TRACEABILITY_IDS)) {
    exactIdList(
      matrix.requirements.filter((requirement) => requirement.category === category).map((requirement) => requirement.id),
      [...expectedIds],
      `${category} coverage`,
    );
  }
  if (TRACEABILITY_CATEGORIES.some((category) => byCategory[category] < 1)) throw new Error("Traceability matrix leaves a required category empty");
  if (!Array.isArray(matrix.risks) || matrix.risks.length < 8 || matrix.risks.length > 64) throw new Error("V0 risk register is incomplete or exceeds its bound");
  const riskIds = new Set<string>();
  for (const [index, risk] of matrix.risks.entries()) {
    if (!risk || !/^RISK-\d{3}$/.test(risk.id) || riskIds.has(risk.id)) throw new Error(`Risk ${index} has an invalid or duplicate id`);
    riskIds.add(risk.id);
    nonEmptyText(risk.risk, `${risk.id} risk`);
    nonEmptyText(risk.consequence, `${risk.id} consequence`);
    nonEmptyText(risk.ownerRole, `${risk.id} ownerRole`, 120);
    if (!new Set(["open", "controlled", "blocked"]).has(risk.status)) throw new Error(`${risk.id} status is invalid`);
    if (!risk.mitigationRequirementIds?.length || risk.mitigationRequirementIds.some((id) => !requirementIds.has(id))) throw new Error(`${risk.id} mitigation mapping is invalid`);
    if (!risk.verificationRefs?.length || risk.verificationRefs.some((id) => !matrix.references[id])) throw new Error(`${risk.id} verification mapping is invalid`);
  }
  return {
    schemaVersion: 2,
    valid: true,
    matrixVersion: matrix.matrixVersion,
    requirements: matrix.requirements.length,
    risks: matrix.risks.length,
    references: referenceEntries.length,
    byCategory,
    byStatus,
    roadmapDeliverables: [...new Set(roadmapIds)].sort(),
    qualificationGates: [...new Set(gateIds)].sort(),
    externalGatesNotRun: matrix.requirements
      .filter((requirement) => EXTERNAL_GATES.has(requirement.id) && ["not-run", "blocked"].includes(requirement.status))
      .map((requirement) => requirement.id)
      .sort(),
    releaseBinding: verifiedRelease ? { state: "verified", ...verifiedRelease } : { state: "unbound" },
  };
}
