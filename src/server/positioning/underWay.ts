/**
 * Comparing DGNSS positions while the vessel is under way.
 *
 * At speed, a position that is not exactly time-aligned to the shot (taken
 * from the receiver's latest update, or time-tagged late) is displaced along
 * the track by speed × time error, while the solution itself is fine across
 * track. Positions are compared against a smooth reference track built from
 * all systems:
 *  - agreement under way is judged across track at every shot, plus the
 *    steady (median) along-track offset, which a steady lag or an along-track
 *    lever-arm error would show and which is judged against the limit;
 *  - shot-to-shot along-track excursions from that steady offset are timing:
 *    reported in seconds of travel and set aside from the 2D statistics.
 */

export interface TrackPoint {
  /** Reference CRP at the shot (smoothed consensus of all systems). */
  e: number;
  n: number;
  /** Reference velocity, m/s. */
  vE: number;
  vN: number;
  knots: number;
}

const KNOT = 0.514444;

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Least squares of y = a + b·x + c·x² (c = 0 when `linear`); returns [a, b, c]. */
function fit(points: Array<[number, number]>, linear: boolean): [number, number, number] | undefined {
  const size = linear ? 2 : 3;
  const matrix = Array.from({ length: size }, () => new Array<number>(size + 1).fill(0));
  for (const [x, y] of points) {
    const basis = linear ? [1, x] : [1, x, x * x];
    for (let row = 0; row < size; row += 1) {
      matrix[row][size] += basis[row] * y;
      for (let column = 0; column < size; column += 1) matrix[row][column] += basis[row] * basis[column];
    }
  }
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
    if (Math.abs(matrix[best][pivot]) < 1e-12) return undefined;
    [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
    for (let row = pivot + 1; row < size; row += 1) {
      const factor = matrix[row][pivot] / matrix[pivot][pivot];
      for (let column = pivot; column <= size; column += 1) matrix[row][column] -= factor * matrix[pivot][column];
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = matrix[row][size];
    for (let column = row + 1; column < size; column += 1) value -= matrix[row][column] * solution[column];
    solution[row] = value / matrix[row][row];
  }
  return [solution[0], solution[1], linear ? 0 : solution[2]];
}

/**
 * Smooth reference track from per-shot consensus positions [timeMs, E, N]:
 * a local quadratic over about ±15 s (at least ±2.5 shot intervals) gives the
 * position and velocity at each shot. Shots that sit far off the local curve
 * (several systems stepping together) are dropped and the curve refitted.
 */
export function referenceTrack(samples: ReadonlyArray<readonly [number, number, number]>, intervalMs: number): Map<number, TrackPoint> {
  const halfMs = Math.min(60_000, Math.max(15_000, 2.5 * intervalMs));
  const track = new Map<number, TrackPoint>();
  let low = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const [time, originE, originN] = samples[index];
    while (samples[low][0] < time - halfMs) low += 1;
    let high = index;
    while (high + 1 < samples.length && samples[high + 1][0] <= time + halfMs) high += 1;
    let window = samples.slice(low, high + 1).map(([t, e, n]) => [(t - time) / 1000, e - originE, n - originN] as [number, number, number]);
    const solve = (points: typeof window) => {
      const linear = points.length < 5;
      if (points.length < 3) return undefined;
      const e = fit(points.map(([x, east]) => [x, east]), linear);
      const n = fit(points.map(([x, , north]) => [x, north]), linear);
      return e && n ? { e, n, linear } : undefined;
    };
    let solved = solve(window);
    if (solved) {
      // One robust pass: drop points well off the first curve (at least 0.3 m, or 3× the typical residual).
      const s = solved;
      const residual = ([x, east, north]: [number, number, number]) =>
        Math.hypot(east - (s.e[0] + s.e[1] * x + s.e[2] * x * x), north - (s.n[0] + s.n[1] * x + s.n[2] * x * x));
      const residuals = window.map(residual);
      const tolerance = Math.max(0.3, 3 * median(residuals));
      const kept = window.filter((point, position) => residuals[position] <= tolerance);
      if (kept.length >= 3 && kept.length < window.length) {
        window = kept;
        solved = solve(window) ?? solved;
      }
    }
    if (!solved) continue;
    const vE = solved.e[1];
    const vN = solved.n[1];
    track.set(time, { e: originE + solved.e[0], n: originN + solved.n[0], vE, vN, knots: Math.hypot(vE, vN) / KNOT });
  }
  return track;
}

/** Along-track (positive ahead, in the direction of travel) and across-track (positive to port) components. */
export function alongCross(dE: number, dN: number, point: TrackPoint): { along: number; cross: number } {
  const speed = Math.hypot(point.vE, point.vN);
  if (!(speed > 0)) return { along: Number.NaN, cross: Number.NaN };
  const ux = point.vE / speed;
  const uy = point.vN / speed;
  return { along: dE * ux + dN * uy, cross: -dE * uy + dN * ux };
}

export interface TimingStep {
  timeMs: number;
  /** Along-track excursion from the steady offset, m (+ ahead, − behind). */
  alongM: number;
  /** The same as time: excursion / speed, s. */
  seconds: number;
  knots: number;
}

export interface TimingRule {
  /** Smallest along-track excursion counted (set aside from 2D statistics), m. */
  minM: number;
  /** Largest across-track change in a timing excursion, m. */
  maxCrossM: number;
  /** Larger excursions are not timing (counted as offsets), s of travel. */
  maxSeconds: number;
}

export interface OffsetSample {
  timeMs: number;
  along: number;
  cross: number;
  knots: number;
}

export interface TimingProfile {
  n: number;
  /** Median along/across-track offsets, m; a steady lag or lever-arm error shows here. */
  steadyAlong: number;
  steadyCross: number;
  /** Steady along-track offset as time at the median speed, s. */
  steadySeconds: number;
  /** 95th percentile and largest of |along − steady| / speed, s. */
  p95Seconds: number;
  maxSeconds: number;
  /** Shots whose along-track excursion is at least `minM` and looks like timing. */
  excursions: TimingStep[];
  /** [timeMs, (along − steady) / speed] per shot, s. */
  series: Array<[number, number]>;
}

const percentile95 = (values: number[]) => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
};

/**
 * Timing of a series of along/across-track offsets (a system against the
 * reference track, or one system against another), measured from the series'
 * own steady values so a steady lag is never mistaken for jitter.
 */
export function timingProfile(samples: OffsetSample[], rule: TimingRule): TimingProfile {
  const steadyAlong = median(samples.map((sample) => sample.along));
  const steadyCross = median(samples.map((sample) => sample.cross));
  const seconds: number[] = [];
  const series: Array<[number, number]> = [];
  const excursions: TimingStep[] = [];
  for (const sample of samples) {
    const speed = sample.knots * KNOT;
    if (!(speed > 0)) continue;
    const excursion = sample.along - steadyAlong;
    const time = excursion / speed;
    seconds.push(Math.abs(time));
    series.push([sample.timeMs, time]);
    if (Math.abs(excursion) >= rule.minM && Math.abs(sample.cross - steadyCross) <= rule.maxCrossM && Math.abs(time) <= rule.maxSeconds) {
      excursions.push({ timeMs: sample.timeMs, alongM: excursion, seconds: time, knots: sample.knots });
    }
  }
  const medianSpeed = median(samples.map((sample) => sample.knots * KNOT));
  return {
    n: samples.length,
    steadyAlong,
    steadyCross,
    steadySeconds: medianSpeed > 0 ? steadyAlong / medianSpeed : Number.NaN,
    p95Seconds: percentile95(seconds),
    maxSeconds: seconds.length ? Math.max(...seconds) : Number.NaN,
    excursions,
    series,
  };
}

export { median as medianOf };
