/** Small shared helpers for the incident figure and the incident analysis charts. */

export function xml(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Same wording rules as the rest of the evidence package. */
export function plain(value: string): string {
  return value
    .replace(/spoof(?:ing|ed)?/gi, "navigation anomaly")
    .replace(/\bd\s*b\s*m\b/gi, "relative units")
    .replace(/confidence/gi, "evidence strength");
}

export function utc(ms: number, withDate: boolean): string {
  const iso = new Date(ms).toISOString();
  return withDate ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(11, 19);
}

export function niceStep(rawStep: number): number {
  const exponent = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const fraction = rawStep / exponent;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * exponent;
}

const TIME_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((seconds) => seconds * 1000);

export function timeTicks(startMs: number, endMs: number, target: number): number[] {
  const span = Math.max(1, endMs - startMs);
  const step = TIME_STEPS_MS.find((candidate) => span / candidate <= target) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  const ticks: number[] = [];
  for (let tick = Math.ceil(startMs / step) * step; tick <= endMs; tick += step) ticks.push(tick);
  return ticks;
}

export function frequencyTicks(startHz: number, endHz: number, target: number): number[] {
  const step = niceStep((endHz - startHz) / target);
  const ticks: number[] = [];
  for (let tick = Math.ceil(startHz / step) * step; tick <= endHz + 1; tick += step) ticks.push(tick);
  return ticks;
}

