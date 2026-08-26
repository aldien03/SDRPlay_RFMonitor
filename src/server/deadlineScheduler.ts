export type SchedulerTier = "tier1" | "tier2" | "survey";

export interface DeadlineTarget {
  id: string;
  tier: SchedulerTier;
  revisitObjectiveMs: number;
  nominalVisitMs: number;
  maxVisitMs: number;
  weight: number;
}

export interface DeadlineSchedulerOptions {
  now?: () => number;
  initialNowMs?: number;
  /**
   * Real, externally restored valid completions. These participate in the
   * first measured revisit and must never be used merely to phase a schedule.
   */
  initialValidCompletions?: Readonly<Record<string, number>>;
  /**
   * Deadline anchors used only to phase the first selection cycle. They are
   * not observations and therefore cannot form a measured revisit or exposure
   * boundary.
   */
  initialPhaseAnchorsMs?: Readonly<Record<string, number>>;
  historyLimit?: number;
  protectedReserveFraction?: number;
  tierOneTieOrder?: readonly string[];
  lookAheadPeriods?: number;
  optionalQualificationMs?: number;
  minimumTierOneValidRevisitsForOptional?: number;
  optionalQualificationOnTimeRatio?: number;
  enforceOptionalQualification?: boolean;
}

export interface SchedulerDecision {
  target: Readonly<DeadlineTarget>;
  selectedAtMs: number;
  /** Deadline used to order the next bounded attempt. */
  deadlineMs: number;
  latestSafeStartMs: number;
  latenessMs: number;
  /** Valid-observation deadline. Invalid visits never advance it. */
  complianceDeadlineMs: number;
  complianceLatestSafeStartMs: number;
  complianceLatenessMs: number;
  retryNotBeforeMs: number;
  reason: "tier1-least-laxity" | "optional-weighted-deficit";
}

export interface VisitCompletion {
  valid: boolean;
  completedAtMs?: number;
  cause?: string;
  observedExposureMs?: number;
  firstObservedAtMs?: number;
  lastObservedAtMs?: number;
}

export interface VisitRecord {
  sequence: number;
  targetId: string;
  tier: SchedulerTier;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  observedExposureMs: number;
  firstObservedAtMs?: number;
  lastObservedAtMs?: number;
  valid: boolean;
  completionCause: string;
  previousValidCompletionMs?: number;
  revisitMs?: number;
  actualUnobservedGapMs?: number;
  revisitObjectiveMs: number;
  deadlineAtStartMs: number;
  missedObjective: boolean;
  missByMs: number;
  missCause?: string;
}

export interface AdmissionDecision {
  allowed: boolean;
  reason:
    | "admitted"
    | "unknown-target"
    | "not-optional"
    | "visit-in-progress"
    | "tier1-not-qualified"
    | "protected-reserve-unavailable"
    | "tier1-look-ahead-failed";
}

export interface VisitExtensionDecision {
  allowed: boolean;
  reason:
    | "within-nominal-budget"
    | "extension-safe"
    | "no-visit-in-progress"
    | "below-elapsed-time"
    | "above-maximum-budget"
    | "active-deadline-would-be-missed"
    | "tier1-look-ahead-failed";
}

export interface SchedulerTargetState {
  id: string;
  tier: SchedulerTier;
  revisitObjectiveMs: number;
  /** Valid-observation deadline retained across invalid visits. */
  deadlineMs: number;
  latestSafeStartMs: number;
  /** Separate cadence deadline used to prevent a failed target monopolizing the tuner. */
  nextAttemptDeadlineMs: number;
  nextAttemptLatestSafeStartMs: number;
  retryNotBeforeMs: number;
  lastValidCompletionMs?: number;
  currentUnobservedGapMs?: number;
  validCompletions: number;
  validRevisits: number;
  onTimeValidRevisits: number;
  lateValidRevisits: number;
  onTimeRatio?: number;
  failedVisits: number;
  missedRevisits: number;
}

export interface DeadlineSchedulerSnapshot {
  atMs: number;
  tierOneUtilization: number;
  protectedReserveFraction: number;
  optionalQualificationReady: boolean;
  optionalQualificationElapsedMs: number;
  activeTargetId?: string;
  completionHistorySize: number;
  missHistorySize: number;
  targets: SchedulerTargetState[];
}

interface RuntimeTarget {
  target: Readonly<DeadlineTarget>;
  /** Compliance deadline derived only from a valid completion. */
  deadlineMs: number;
  /** Scheduling deadline advanced after every attempt, including an invalid one. */
  nextAttemptDeadlineMs: number;
  /** A failed early visit cannot immediately spin another tune attempt. */
  retryNotBeforeMs: number;
  lastValidCompletionMs?: number;
  lastObservedAtMs?: number;
  validCompletions: number;
  validRevisits: number;
  onTimeValidRevisits: number;
  failedVisits: number;
  missedRevisits: number;
  deficit: number;
}

interface ActiveVisit {
  targetId: string;
  startedAtMs: number;
  deadlineAtStartMs: number;
}

interface SimulatedTierOneTarget {
  runtime: RuntimeTarget;
  nextAttemptDeadlineMs: number;
}

const DEFAULT_TIER_ONE_TIE_ORDER = [
  "gnss-l1-e1-b1c-sbas",
  "gnss-gps-l2c",
  "gnss-l5-e5a-b2a",
  "gnss-glonass-g1",
] as const;

const EPSILON_MS = 1e-6;
const DEFAULT_HISTORY_LIMIT = 256;
const MAX_HISTORY_LIMIT = 4_096;

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
}

function appendBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

/**
 * A deterministic, I/O-free scheduler driven only by monotonic timestamps.
 *
 * The caller owns tuning and observation validity. A failed visit leaves the
 * compliance deadline unchanged, so missing data can never masquerade as a
 * clean or completed revisit. A separate attempt deadline advances after each
 * attempt so a persistently faulty target cannot starve the remaining targets.
 */
export class DeadlineScheduler {
  private readonly nowProvider: () => number;
  private readonly targets = new Map<string, RuntimeTarget>();
  private readonly targetOrder: string[];
  private readonly tieRanks = new Map<string, number>();
  private readonly historyLimit: number;
  private readonly protectedReserveFraction: number;
  private readonly lookAheadPeriods: number;
  private readonly optionalQualificationMs: number;
  private readonly minimumTierOneValidRevisitsForOptional: number;
  private readonly optionalQualificationOnTimeRatio: number;
  private readonly enforceOptionalQualification: boolean;
  private readonly startedAtMs: number;
  private readonly completionHistory: VisitRecord[] = [];
  private readonly missHistory: VisitRecord[] = [];
  private active?: ActiveVisit;
  private lastMonotonicMs: number;
  private sequence = 0;

  constructor(targets: readonly DeadlineTarget[], options: DeadlineSchedulerOptions = {}) {
    this.nowProvider = options.now ?? (() => performance.now());
    const initialNowMs = options.initialNowMs ?? this.nowProvider();
    assertFinite(initialNowMs, "initial monotonic time");
    this.lastMonotonicMs = initialNowMs;
    this.startedAtMs = initialNowMs;

    const requestedHistoryLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    assertPositive(requestedHistoryLimit, "historyLimit");
    this.historyLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(requestedHistoryLimit)));
    this.protectedReserveFraction = options.protectedReserveFraction ?? 0.1;
    if (
      !Number.isFinite(this.protectedReserveFraction) ||
      this.protectedReserveFraction < 0 ||
      this.protectedReserveFraction >= 1
    ) {
      throw new RangeError("protectedReserveFraction must be between zero (inclusive) and one (exclusive)");
    }
    const requestedLookAheadPeriods = options.lookAheadPeriods ?? 4;
    assertPositive(requestedLookAheadPeriods, "lookAheadPeriods");
    this.lookAheadPeriods = Math.min(16, Math.max(2, Math.trunc(requestedLookAheadPeriods)));
    this.optionalQualificationMs = options.optionalQualificationMs ?? 24 * 60 * 60_000;
    this.minimumTierOneValidRevisitsForOptional = options.minimumTierOneValidRevisitsForOptional ?? 1;
    this.optionalQualificationOnTimeRatio = options.optionalQualificationOnTimeRatio ?? 0.999;
    this.enforceOptionalQualification = options.enforceOptionalQualification ?? true;
    if (!Number.isFinite(this.optionalQualificationMs) || this.optionalQualificationMs < 0) throw new RangeError("optionalQualificationMs must be non-negative");
    if (!Number.isSafeInteger(this.minimumTierOneValidRevisitsForOptional) || this.minimumTierOneValidRevisitsForOptional < 0) throw new RangeError("minimumTierOneValidRevisitsForOptional must be a non-negative safe integer");
    if (!Number.isFinite(this.optionalQualificationOnTimeRatio) || this.optionalQualificationOnTimeRatio < 0 || this.optionalQualificationOnTimeRatio > 1) throw new RangeError("optionalQualificationOnTimeRatio must be between zero and one");

    const tieOrder = options.tierOneTieOrder ?? DEFAULT_TIER_ONE_TIE_ORDER;
    tieOrder.forEach((id, index) => this.tieRanks.set(id, index));

    for (const input of targets) {
      if (!input.id.trim()) throw new Error("Scheduler target IDs cannot be empty");
      if (this.targets.has(input.id)) throw new Error(`Duplicate scheduler target ID: ${input.id}`);
      if (!(["tier1", "tier2", "survey"] as const).includes(input.tier)) {
        throw new Error(`Unsupported scheduler tier for ${input.id}: ${String(input.tier)}`);
      }
      assertPositive(input.revisitObjectiveMs, `${input.id} revisitObjectiveMs`);
      assertPositive(input.nominalVisitMs, `${input.id} nominalVisitMs`);
      assertPositive(input.maxVisitMs, `${input.id} maxVisitMs`);
      assertPositive(input.weight, `${input.id} weight`);
      if (input.nominalVisitMs > input.maxVisitMs) {
        throw new RangeError(`${input.id} nominalVisitMs cannot exceed maxVisitMs`);
      }

      const target = Object.freeze({ ...input });
      const restoredCompletion = options.initialValidCompletions?.[target.id];
      const phaseAnchor = options.initialPhaseAnchorsMs?.[target.id];
      if (restoredCompletion !== undefined && phaseAnchor !== undefined) {
        throw new Error(`${target.id} cannot have both an initial valid completion and an initial phase anchor`);
      }
      if (restoredCompletion !== undefined) {
        assertFinite(restoredCompletion, `${target.id} initial completion`);
        if (restoredCompletion > initialNowMs) {
          throw new RangeError(`${target.id} initial completion cannot be later than the initial monotonic time`);
        }
      }
      if (phaseAnchor !== undefined) {
        assertFinite(phaseAnchor, `${target.id} initial phase anchor`);
        if (phaseAnchor > initialNowMs) {
          throw new RangeError(`${target.id} initial phase anchor cannot be later than the initial monotonic time`);
        }
      }
      const deadlineAnchor = restoredCompletion ?? phaseAnchor;
      const deadlineMs = deadlineAnchor === undefined
        ? initialNowMs
        : deadlineAnchor + target.revisitObjectiveMs;
      this.targets.set(target.id, {
        target,
        deadlineMs,
        nextAttemptDeadlineMs: deadlineMs,
        retryNotBeforeMs: initialNowMs,
        lastValidCompletionMs: restoredCompletion,
        lastObservedAtMs: restoredCompletion,
        validCompletions: 0,
        validRevisits: 0,
        onTimeValidRevisits: 0,
        failedVisits: 0,
        missedRevisits: 0,
        deficit: 0,
      });
    }
    this.targetOrder = [...this.targets.keys()];
  }

  peekNext(atMs?: number): SchedulerDecision | undefined {
    const now = this.resolveNow(atMs);
    if (this.active) return undefined;
    return this.chooseNext(now);
  }

  beginNext(atMs?: number): SchedulerDecision | undefined {
    const now = this.resolveNow(atMs);
    if (this.active) throw new Error(`A visit to ${this.active.targetId} is already in progress`);
    const decision = this.chooseNext(now);
    if (!decision) return undefined;

    this.active = {
      targetId: decision.target.id,
      startedAtMs: now,
      deadlineAtStartMs: decision.complianceDeadlineMs,
    };
    if (decision.target.tier !== "tier1") this.commitOptionalDeficit(decision.target.id);
    return decision;
  }

  completeActive(completion: VisitCompletion): VisitRecord {
    if (!this.active) throw new Error("No visit is in progress");
    const completedAtMs = this.resolveNow(completion.completedAtMs);
    const active = this.active;
    if (completedAtMs < active.startedAtMs) throw new RangeError("Visit completion cannot precede its start");

    const runtime = this.targets.get(active.targetId);
    if (!runtime) throw new Error(`Unknown active target: ${active.targetId}`);
    const durationMs = completedAtMs - active.startedAtMs;
    const firstObservedAtMs = completion.firstObservedAtMs;
    const lastObservedAtMs = completion.lastObservedAtMs;
    if ((firstObservedAtMs === undefined) !== (lastObservedAtMs === undefined)) {
      throw new RangeError("firstObservedAtMs and lastObservedAtMs must be supplied together");
    }
    if (firstObservedAtMs !== undefined && lastObservedAtMs !== undefined) {
      assertFinite(firstObservedAtMs, "firstObservedAtMs");
      assertFinite(lastObservedAtMs, "lastObservedAtMs");
      if (firstObservedAtMs < active.startedAtMs - EPSILON_MS || lastObservedAtMs < firstObservedAtMs || lastObservedAtMs > completedAtMs + EPSILON_MS) {
        throw new RangeError("Observed timestamps must fall in order within the active visit");
      }
    }
    const previousValidCompletionMs = runtime.lastValidCompletionMs;
    const revisitMs = completion.valid && previousValidCompletionMs !== undefined
      ? completedAtMs - previousValidCompletionMs
      : undefined;
    const priorObservedAtMs = runtime.lastObservedAtMs ?? previousValidCompletionMs;
    // A visit boundary is not RF exposure. Without an accepted frame timestamp
    // there is no truthful point at which an unobserved gap can be closed.
    const actualUnobservedGapMs = priorObservedAtMs === undefined || firstObservedAtMs === undefined
      ? undefined
      : Math.max(0, firstObservedAtMs - priorObservedAtMs);
    const missedObjective = previousValidCompletionMs !== undefined && completedAtMs > active.deadlineAtStartMs + EPSILON_MS;
    const missByMs = missedObjective ? completedAtMs - active.deadlineAtStartMs : 0;
    const completionCause = completion.cause ?? (completion.valid ? "valid-observation" : "invalid-observation");
    const exposure = completion.observedExposureMs ?? (completion.valid ? durationMs : 0);
    assertFinite(exposure, "observedExposureMs");
    if (exposure < 0 || exposure > durationMs + EPSILON_MS) {
      throw new RangeError("observedExposureMs must be between zero and the visit duration");
    }

    if (completion.valid) {
      if (revisitMs !== undefined) {
        runtime.validRevisits += 1;
        if (!missedObjective) runtime.onTimeValidRevisits += 1;
      }
      runtime.lastValidCompletionMs = completedAtMs;
      runtime.lastObservedAtMs = lastObservedAtMs ?? completedAtMs;
      runtime.deadlineMs = completedAtMs + runtime.target.revisitObjectiveMs;
      runtime.nextAttemptDeadlineMs = runtime.deadlineMs;
      runtime.retryNotBeforeMs = completedAtMs;
      runtime.validCompletions += 1;
    } else {
      runtime.failedVisits += 1;
      // Advance only the attempt cadence. The compliance deadline and last
      // valid completion remain untouched, while missed periods coalesce into
      // one future attempt instead of creating a catch-up burst.
      runtime.nextAttemptDeadlineMs = completedAtMs + runtime.target.revisitObjectiveMs;
      runtime.retryNotBeforeMs = completedAtMs + runtime.target.nominalVisitMs;
    }
    // Incomplete visits remain Unknown for detection, but accepted RF frames
    // still end an actual coverage gap. Preserve that physical exposure without
    // converting the visit into a valid detector observation.
    if (lastObservedAtMs !== undefined) runtime.lastObservedAtMs = lastObservedAtMs;
    if (missedObjective) runtime.missedRevisits += 1;

    const record: VisitRecord = {
      sequence: ++this.sequence,
      targetId: runtime.target.id,
      tier: runtime.target.tier,
      startedAtMs: active.startedAtMs,
      completedAtMs,
      durationMs,
      observedExposureMs: exposure,
      firstObservedAtMs,
      lastObservedAtMs,
      valid: completion.valid,
      completionCause,
      previousValidCompletionMs,
      revisitMs,
      actualUnobservedGapMs,
      revisitObjectiveMs: runtime.target.revisitObjectiveMs,
      deadlineAtStartMs: active.deadlineAtStartMs,
      missedObjective,
      missByMs,
      missCause: missedObjective
        ? completion.cause ?? (completion.valid ? "revisit-objective-missed" : "invalid-observation")
        : undefined,
    };
    this.active = undefined;
    appendBounded(this.completionHistory, record, this.historyLimit);
    if (!record.valid || record.missedObjective) appendBounded(this.missHistory, record, this.historyLimit);
    return { ...record };
  }

  canAdmitOptional(targetId: string, atMs?: number): AdmissionDecision {
    const now = this.resolveNow(atMs);
    const runtime = this.targets.get(targetId);
    if (!runtime) return { allowed: false, reason: "unknown-target" };
    if (runtime.target.tier === "tier1") return { allowed: false, reason: "not-optional" };
    if (this.active) return { allowed: false, reason: "visit-in-progress" };
    return this.canAdmitOptionalAt(runtime, now);
  }

  canExtendActive(totalVisitMs: number, atMs?: number): VisitExtensionDecision {
    assertPositive(totalVisitMs, "totalVisitMs");
    const now = this.resolveNow(atMs);
    if (!this.active) return { allowed: false, reason: "no-visit-in-progress" };
    const runtime = this.targets.get(this.active.targetId);
    if (!runtime) return { allowed: false, reason: "no-visit-in-progress" };
    if (this.active.startedAtMs + totalVisitMs < now - EPSILON_MS) {
      return { allowed: false, reason: "below-elapsed-time" };
    }
    if (totalVisitMs > runtime.target.maxVisitMs + EPSILON_MS) {
      return { allowed: false, reason: "above-maximum-budget" };
    }
    if (totalVisitMs <= runtime.target.nominalVisitMs + EPSILON_MS) {
      return { allowed: true, reason: "within-nominal-budget" };
    }

    const proposedCompletionMs = this.active.startedAtMs + totalVisitMs;
    if (
      runtime.target.tier === "tier1" &&
      runtime.lastValidCompletionMs !== undefined &&
      proposedCompletionMs > this.active.deadlineAtStartMs + EPSILON_MS
    ) {
      return { allowed: false, reason: "active-deadline-would-be-missed" };
    }

    const deadlineOverrides = runtime.target.tier === "tier1"
      ? new Map([[runtime.target.id, proposedCompletionMs + runtime.target.revisitObjectiveMs]])
      : undefined;
    if (!this.simulateTierOneFeasibility(proposedCompletionMs, 1, deadlineOverrides)) {
      return { allowed: false, reason: "tier1-look-ahead-failed" };
    }
    return { allowed: true, reason: "extension-safe" };
  }

  getCompletionHistory(): VisitRecord[] {
    return this.completionHistory.map((record) => ({ ...record }));
  }

  getMissHistory(): VisitRecord[] {
    return this.missHistory.map((record) => ({ ...record }));
  }

  /**
   * Earliest monotonic time at which a currently gated target may be selected.
   * Callers can arm one timer instead of polling while every retry is waiting.
   */
  nextSelectionAtMs(atMs?: number): number | undefined {
    const now = this.resolveNow(atMs);
    if (this.active) return undefined;
    const future = [...this.targets.values()]
      .map((runtime) => runtime.retryNotBeforeMs)
      .filter((retryAt) => retryAt > now + EPSILON_MS);
    return future.length ? Math.min(...future) : undefined;
  }

  snapshot(atMs?: number): DeadlineSchedulerSnapshot {
    const now = this.resolveNow(atMs);
    return {
      atMs: now,
      tierOneUtilization: this.tierOneUtilization(),
      protectedReserveFraction: this.protectedReserveFraction,
      optionalQualificationReady: this.optionalQualificationReady(now),
      optionalQualificationElapsedMs: Math.max(0, now - this.startedAtMs),
      activeTargetId: this.active?.targetId,
      completionHistorySize: this.completionHistory.length,
      missHistorySize: this.missHistory.length,
      targets: this.targetOrder.map((id) => {
        const runtime = this.targets.get(id)!;
        return {
          id,
          tier: runtime.target.tier,
          revisitObjectiveMs: runtime.target.revisitObjectiveMs,
          deadlineMs: runtime.deadlineMs,
          latestSafeStartMs: runtime.deadlineMs - runtime.target.nominalVisitMs,
          nextAttemptDeadlineMs: runtime.nextAttemptDeadlineMs,
          nextAttemptLatestSafeStartMs: runtime.nextAttemptDeadlineMs - runtime.target.nominalVisitMs,
          retryNotBeforeMs: runtime.retryNotBeforeMs,
          lastValidCompletionMs: runtime.lastValidCompletionMs,
          currentUnobservedGapMs: runtime.lastObservedAtMs === undefined
            ? undefined
            : Math.max(0, now - runtime.lastObservedAtMs),
          validCompletions: runtime.validCompletions,
          validRevisits: runtime.validRevisits,
          onTimeValidRevisits: runtime.onTimeValidRevisits,
          lateValidRevisits: runtime.validRevisits - runtime.onTimeValidRevisits,
          onTimeRatio: runtime.validRevisits ? runtime.onTimeValidRevisits / runtime.validRevisits : undefined,
          failedVisits: runtime.failedVisits,
          missedRevisits: runtime.missedRevisits,
        };
      }),
    };
  }

  private resolveNow(explicit?: number): number {
    const now = explicit ?? this.nowProvider();
    assertFinite(now, "monotonic time");
    if (now < this.lastMonotonicMs - EPSILON_MS) {
      throw new RangeError(`Monotonic time moved backwards (${now} < ${this.lastMonotonicMs})`);
    }
    this.lastMonotonicMs = Math.max(this.lastMonotonicMs, now);
    return now;
  }

  private chooseNext(now: number): SchedulerDecision | undefined {
    const tierOne = this.rankedTierOne(now);
    const admissibleOptional = [...this.targets.values()].filter(
      (runtime) => runtime.target.tier !== "tier1"
        && runtime.retryNotBeforeMs <= now + EPSILON_MS
        && this.canAdmitOptionalAt(runtime, now).allowed,
    );

    if (admissibleOptional.length) {
      const runtime = this.chooseWeightedOptional(admissibleOptional);
      return this.toDecision(runtime, now, "optional-weighted-deficit");
    }
    const runtime = tierOne[0];
    return runtime ? this.toDecision(runtime, now, "tier1-least-laxity") : undefined;
  }

  private toDecision(
    runtime: RuntimeTarget,
    now: number,
    reason: SchedulerDecision["reason"],
  ): SchedulerDecision {
    const latestSafeStartMs = runtime.nextAttemptDeadlineMs - runtime.target.nominalVisitMs;
    const complianceLatestSafeStartMs = runtime.deadlineMs - runtime.target.nominalVisitMs;
    return {
      target: runtime.target,
      selectedAtMs: now,
      deadlineMs: runtime.nextAttemptDeadlineMs,
      latestSafeStartMs,
      latenessMs: Math.max(0, now - latestSafeStartMs),
      complianceDeadlineMs: runtime.deadlineMs,
      complianceLatestSafeStartMs,
      complianceLatenessMs: Math.max(0, now - complianceLatestSafeStartMs),
      retryNotBeforeMs: runtime.retryNotBeforeMs,
      reason,
    };
  }

  private rankedTierOne(now: number): RuntimeTarget[] {
    return [...this.targets.values()]
      .filter((runtime) => runtime.target.tier === "tier1" && runtime.retryNotBeforeMs <= now + EPSILON_MS)
      .sort((left, right) => this.compareTierOne(left, right, now, 1));
  }

  private compareTierOne(left: RuntimeTarget, right: RuntimeTarget, _atMs: number, durationMultiplier: number): number {
    const leftLatest = left.nextAttemptDeadlineMs - left.target.nominalVisitMs * durationMultiplier;
    const rightLatest = right.nextAttemptDeadlineMs - right.target.nominalVisitMs * durationMultiplier;
    if (Math.abs(leftLatest - rightLatest) > EPSILON_MS) return leftLatest - rightLatest;
    if (Math.abs(left.nextAttemptDeadlineMs - right.nextAttemptDeadlineMs) > EPSILON_MS) {
      return left.nextAttemptDeadlineMs - right.nextAttemptDeadlineMs;
    }
    const rankDifference = this.tieRank(left.target.id) - this.tieRank(right.target.id);
    return rankDifference || left.target.id.localeCompare(right.target.id);
  }

  private tieRank(id: string): number {
    return this.tieRanks.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  private tierOneUtilization(): number {
    let utilization = 0;
    for (const runtime of this.targets.values()) {
      if (runtime.target.tier === "tier1") {
        utilization += runtime.target.nominalVisitMs / runtime.target.revisitObjectiveMs;
      }
    }
    return utilization;
  }

  private canAdmitOptionalAt(runtime: RuntimeTarget, now: number): AdmissionDecision {
    if (runtime.target.tier === "tier1") return { allowed: false, reason: "not-optional" };
    if (!this.optionalQualificationReady(now)) return { allowed: false, reason: "tier1-not-qualified" };
    const maximumTierOneUtilization = 1 - this.protectedReserveFraction;
    if (this.tierOneUtilization() > maximumTierOneUtilization + EPSILON_MS) {
      return { allowed: false, reason: "protected-reserve-unavailable" };
    }

    const optionalCompletionMs = now + runtime.target.nominalVisitMs;
    const reserveMultiplier = 1 / maximumTierOneUtilization;
    if (!this.simulateTierOneFeasibility(optionalCompletionMs, reserveMultiplier)) {
      return { allowed: false, reason: "tier1-look-ahead-failed" };
    }
    return { allowed: true, reason: "admitted" };
  }

  private optionalQualificationReady(now: number): boolean {
    if (!this.enforceOptionalQualification) return true;
    const tierOne = [...this.targets.values()].filter((candidate) => candidate.target.tier === "tier1");
    if (!tierOne.length) return true;
    if (now - this.startedAtMs < this.optionalQualificationMs) return false;
    return tierOne.every((candidate) => (
      candidate.validRevisits >= this.minimumTierOneValidRevisitsForOptional
      && candidate.failedVisits === 0
      && now <= candidate.deadlineMs + EPSILON_MS
      && (
        candidate.validRevisits === 0
        || candidate.onTimeValidRevisits / candidate.validRevisits >= this.optionalQualificationOnTimeRatio
      )
    ));
  }

  private simulateTierOneFeasibility(
    startMs: number,
    durationMultiplier: number,
    deadlineOverrides?: ReadonlyMap<string, number>,
  ): boolean {
    const simulated: SimulatedTierOneTarget[] = [...this.targets.values()]
      .filter((runtime) => runtime.target.tier === "tier1")
      .map((runtime) => ({
        runtime,
        nextAttemptDeadlineMs: deadlineOverrides?.get(runtime.target.id) ?? runtime.nextAttemptDeadlineMs,
      }));
    if (!simulated.length) return true;

    const maximumObjectiveMs = Math.max(...simulated.map(({ runtime }) => runtime.target.revisitObjectiveMs));
    const lookAheadEndMs = startMs + maximumObjectiveMs * this.lookAheadPeriods;
    const maximumSteps = Math.min(2_048, Math.max(64, simulated.length * this.lookAheadPeriods * 16));
    let cursor = startMs;
    let steps = 0;

    while (cursor < lookAheadEndMs - EPSILON_MS && steps < maximumSteps) {
      simulated.sort((left, right) => {
        const leftLatest = left.nextAttemptDeadlineMs - left.runtime.target.nominalVisitMs * durationMultiplier;
        const rightLatest = right.nextAttemptDeadlineMs - right.runtime.target.nominalVisitMs * durationMultiplier;
        if (Math.abs(leftLatest - rightLatest) > EPSILON_MS) return leftLatest - rightLatest;
        if (Math.abs(left.nextAttemptDeadlineMs - right.nextAttemptDeadlineMs) > EPSILON_MS) {
          return left.nextAttemptDeadlineMs - right.nextAttemptDeadlineMs;
        }
        const rankDifference = this.tieRank(left.runtime.target.id) - this.tieRank(right.runtime.target.id);
        return rankDifference || left.runtime.target.id.localeCompare(right.runtime.target.id);
      });
      const next = simulated[0];
      const durationMs = next.runtime.target.nominalVisitMs * durationMultiplier;
      // The feasibility proof models an event-driven scheduler, so it may idle
      // until the next latest-safe start instead of inventing continuous visits
      // that exhaust the bounded look-ahead step count.
      const serviceStartMs = Math.max(cursor, next.nextAttemptDeadlineMs - durationMs);
      const completedAtMs = serviceStartMs + durationMs;
      if (completedAtMs > next.nextAttemptDeadlineMs + EPSILON_MS) return false;
      cursor = completedAtMs;
      next.nextAttemptDeadlineMs = completedAtMs + next.runtime.target.revisitObjectiveMs;
      steps += 1;
    }
    return cursor >= lookAheadEndMs - EPSILON_MS;
  }

  private chooseWeightedOptional(candidates: RuntimeTarget[]): RuntimeTarget {
    return [...candidates].sort((left, right) => {
      const projectedDifference = (right.deficit + right.target.weight) - (left.deficit + left.target.weight);
      if (Math.abs(projectedDifference) > EPSILON_MS) return projectedDifference;
      const leftLast = left.lastValidCompletionMs ?? Number.NEGATIVE_INFINITY;
      const rightLast = right.lastValidCompletionMs ?? Number.NEGATIVE_INFINITY;
      if (leftLast !== rightLast) return leftLast - rightLast;
      return left.target.id.localeCompare(right.target.id);
    })[0];
  }

  private commitOptionalDeficit(selectedId: string): void {
    const optional = [...this.targets.values()].filter((runtime) => runtime.target.tier !== "tier1");
    const totalWeight = optional.reduce((sum, runtime) => sum + runtime.target.weight, 0);
    for (const runtime of optional) runtime.deficit += runtime.target.weight;
    const selected = this.targets.get(selectedId);
    if (selected) selected.deficit -= totalWeight;

    // Normalizing by a common offset preserves ordering and prevents numerical
    // growth during long-running survey operation.
    const minimum = Math.min(...optional.map((runtime) => runtime.deficit));
    for (const runtime of optional) runtime.deficit -= minimum;
  }
}
