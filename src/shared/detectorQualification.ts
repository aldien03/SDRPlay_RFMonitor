import type { SyntheticEventKind, SyntheticExpectedOutcome } from "./syntheticValidation";
import type { BandCatalog } from "./types";

export const DETECTOR_QUALIFICATION_PLAN_SCHEMA_VERSION = 1 as const;
export const DETECTOR_QUALIFICATION_PLAN_VERSION = "rf-relative-mad-qualification-1.1.0" as const;

export type DetectorValidationLevel =
  | "isolated-deterministic"
  | "isolated-randomized"
  | "held-out-replay"
  | "installed-chain";

export type DetectorQualificationFamily = SyntheticEventKind | "guard-bin-energy" | "target-range" | "replay-nuisance";

export interface DetectorQualificationTarget {
  id: string;
  label: string;
  centerHz: number;
  captureSpanHz: number;
  analysisSpanHz: number;
  revisitObjectiveMs: number;
}

export interface FrozenDetectorScenarioDefinition {
  id: string;
  version: "1.0.0";
  level: DetectorValidationLevel;
  families: DetectorQualificationFamily[];
  targetIds: string[];
  expectedOutcomes: Array<SyntheticExpectedOutcome | "metadata-match">;
  minimumIndependentRunsPerTargetFamily: number;
  seedProtocol: "sha256(plan-version:target:family:trial-index)" | "recorded-corpus-id" | "recorded-acquisition-id";
  truthProtocol: "pre-run-sha256-commitment";
  inputDomain: "generated-normalized-fft" | "held-out-normalized-fft" | "installed-rf-chain";
  parameterEnvelope: Record<string, string>;
  acceptance: string[];
  externalPrerequisites: string[];
}

export interface DetectorQualificationPlan {
  schemaVersion: typeof DETECTOR_QUALIFICATION_PLAN_SCHEMA_VERSION;
  version: typeof DETECTOR_QUALIFICATION_PLAN_VERSION;
  catalogVersion: string;
  detectorRuleSetId: "rf-relative-mad-v1";
  values: "normalized-uint8-relative-spectrum";
  scoringUnit: "independent-run";
  confidenceProtocol: "one-sided-wilson-95";
  targets: DetectorQualificationTarget[];
  scenarios: FrozenDetectorScenarioDefinition[];
  physicalQualificationRequired: true;
  limitations: string[];
}

const EVENT_FAMILIES: SyntheticEventKind[] = [
  "sham",
  "wideband",
  "pulsed-wideband",
  "cw",
  "multitone",
  "moving-narrowband",
  "overload",
  "configuration-change",
  "data-gap",
  "matched-power-spoofing",
];

export function detectorQualificationPlan(catalog: BandCatalog): DetectorQualificationPlan {
  const targets = catalog.captureTargets
    .filter((target) => target.service === "gnss" && target.tier === "tier1" && target.defaultEnabled)
    .map((target) => ({
      id: target.id,
      label: target.label,
      centerHz: target.centerHz,
      captureSpanHz: target.captureSpanHz,
      analysisSpanHz: target.analysisSpanHz,
      revisitObjectiveMs: target.revisitObjectiveMs,
    }));
  if (targets.length !== 4) throw new Error(`Detector qualification requires exactly four default Tier-1 targets; catalog ${catalog.catalogVersion} has ${targets.length}`);
  if (targets.some((target) => target.analysisSpanHz <= 0 || target.analysisSpanHz > target.captureSpanHz || target.analysisSpanHz > 8_000_000)) {
    throw new Error("Detector qualification target analysis spans must be within the capture span and no wider than 8 MHz");
  }
  const targetIds = targets.map((target) => target.id);
  return {
    schemaVersion: DETECTOR_QUALIFICATION_PLAN_SCHEMA_VERSION,
    version: DETECTOR_QUALIFICATION_PLAN_VERSION,
    catalogVersion: catalog.catalogVersion,
    detectorRuleSetId: "rf-relative-mad-v1",
    values: "normalized-uint8-relative-spectrum",
    scoringUnit: "independent-run",
    confidenceProtocol: "one-sided-wilson-95",
    targets,
    scenarios: [
    {
      id: "deterministic-regression",
      version: "1.0.0",
      level: "isolated-deterministic",
      families: EVENT_FAMILIES,
      targetIds,
      expectedOutcomes: ["alert", "no-alert", "unknown"],
      minimumIndependentRunsPerTargetFamily: 1,
      seedProtocol: "sha256(plan-version:target:family:trial-index)",
      truthProtocol: "pre-run-sha256-commitment",
      inputDomain: "generated-normalized-fft",
      parameterEnvelope: { source: "exact versioned values in createResearchSyntheticScenarioSuite" },
      acceptance: ["Every mandatory event verdict matches", "No unmatched alert", "Truth commitment verifies"],
      externalPrerequisites: [],
    },
    {
      id: "randomized-high-margin",
      version: "1.0.0",
      level: "isolated-randomized",
      families: EVENT_FAMILIES,
      targetIds,
      expectedOutcomes: ["alert", "no-alert", "unknown"],
      minimumIndependentRunsPerTargetFamily: 400,
      seedProtocol: "sha256(plan-version:target:family:trial-index)",
      truthProtocol: "pre-run-sha256-commitment",
      inputDomain: "generated-normalized-fft",
      parameterEnvelope: {
        baseline: "24..48 normalized bins; noise 1..4; ripple 0..3",
        wideband: "48..96-bin rise; 0.60..0.90 occupancy",
        pulsedWideband: "48..96-bin rise; 0.60..0.90 occupancy; 1 s period; 0.60..0.90 duty; at least four median-preserved visits",
        narrowband: "96..200-bin rise; 1..5-bin width; position constrained to analyzed span",
        movingNarrowband: "96..200-bin rise; 3..9-bin width; 90..180 s sweep; within-visit motion no greater than two bins; path constrained to analyzed span",
        controls: "sham and matched-power distributions unchanged; gap/configuration truth explicit",
      },
      acceptance: [
        "At least 400 independent seeds for each target/family",
        "One-sided 95% detection lower limit at least 0.99 for high-margin alert families",
        "One-sided 95% alert-free lower limit at least 0.99 for negative controls",
        "Unknown controls are never scored clean",
        "A continuing detector incident is not split before the configured ten-clean-observation clear horizon",
      ],
      externalPrerequisites: [],
    },
    {
      id: "held-out-fft-replay",
      version: "1.0.0",
      level: "held-out-replay",
      families: ["wideband", "pulsed-wideband", "cw", "multitone", "moving-narrowband", "overload", "data-gap", "configuration-change", "matched-power-spoofing", "replay-nuisance"],
      targetIds,
      expectedOutcomes: ["alert", "no-alert", "unknown"],
      minimumIndependentRunsPerTargetFamily: 30,
      seedProtocol: "recorded-corpus-id",
      truthProtocol: "pre-run-sha256-commitment",
      inputDomain: "held-out-normalized-fft",
      parameterEnvelope: { source: "immutable corpus manifest; session boundaries are independent runs" },
      acceptance: ["Tested envelope and nuisance-alert limits are declared before unblinding", "No threshold tuning on holdout", "Per-session and per-target scores include one-sided 95% limits"],
      externalPrerequisites: ["Held-out corpus provenance and hashes", "Independent truth labels", "Frozen detector/rule/configuration hashes"],
    },
    {
      id: "installed-chain-characterization",
      version: "1.0.0",
      level: "installed-chain",
      families: ["target-range", "wideband", "cw", "multitone", "moving-narrowband", "overload", "guard-bin-energy", "sham"],
      targetIds,
      expectedOutcomes: ["alert", "no-alert", "metadata-match"],
      minimumIndependentRunsPerTargetFamily: 10,
      seedProtocol: "recorded-acquisition-id",
      truthProtocol: "pre-run-sha256-commitment",
      inputDomain: "installed-rf-chain",
      parameterEnvelope: { source: "predeclared conducted-RF test matrix; raw generator settings retained", guard: "energy outside central 8 MHz must not create analyzed anomaly bins" },
      acceptance: ["Correct target and analyzed range", "Overload reported separately from RF interference", "No guard-only or sham alert", "Detection envelope reported without converting display bins to dBm"],
      externalPrerequisites: ["Final receiver/antenna/filter/cable/LNA/gain chain", "Calibrated conducted-RF equipment", "Equipment calibration record", "Witnessed raw acquisitions"],
    },
    ],
    physicalQualificationRequired: true,
    limitations: [
      "Synthetic and replay results do not qualify the installed RF chain.",
      "Normalized spectrum cannot classify spoofing, navigation integrity, intent, dBm, or field strength.",
      "An event wholly between tuner visits is unobserved and scored separately.",
    ],
  };
}
