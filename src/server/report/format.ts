/** Formatting shared by the report renderers. Times are always UTC first. */

export function utcDateTime(iso: string | number | undefined): string {
  if (iso === undefined) return "Not recorded";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "Not recorded";
  const value = new Date(ms).toISOString();
  return `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;
}

export function utcTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function localDateTime(iso: string | number | undefined, timeZone: string): string | undefined {
  if (iso === undefined || !timeZone || timeZone === "UTC") return undefined;
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`;
  } catch {
    return undefined;
  }
}

export function durationText(startIso: string | undefined, endIso: string | undefined): string {
  const start = startIso ? Date.parse(startIso) : NaN;
  const end = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Not recorded";
  const seconds = Math.round((end - start) / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** Frequency with precision matched to the measurement resolution, never false precision. */
export function frequencyMHz(hz: number, resolutionHz = 1_000): string {
  const decimals = resolutionHz >= 100_000 ? 1 : resolutionHz >= 10_000 ? 2 : resolutionHz >= 1_000 ? 3 : 4;
  return `${(hz / 1e6).toFixed(decimals)} MHz`;
}

export function frequencyRange(range: [number, number], resolutionHz = 1_000): string {
  const decimals = resolutionHz >= 100_000 ? 1 : resolutionHz >= 10_000 ? 2 : resolutionHz >= 1_000 ? 3 : 4;
  return `${(range[0] / 1e6).toFixed(decimals)}–${(range[1] / 1e6).toFixed(decimals)} MHz`;
}

export function bandwidthText(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(hz >= 1e7 ? 0 : 1)} MHz`;
  if (hz >= 1e3) return `${Math.round(hz / 1e3)} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function multiple(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}×`;
}

export function percent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "–";
  const value = ratio * 100;
  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}

export function bytesText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

const PDF_REPLACEMENTS: Record<string, string> = {
  "≥": ">=",
  "≤": "<=",
  // Without this, NFD stripping would turn "≠" into "=" and invert the meaning.
  "≠": "!=",
  "−": "-",
  "→": "->",
  "←": "<-",
  "σ": "sigma",
  "✓": "Yes",
  "✗": "No",
  " ": " ",
  " ": " ",
  " ": " ",
};

/**
 * The PDF uses the standard Helvetica font (WinAnsi). Characters outside it
 * are transliterated for the PDF only; the HTML report keeps the exact text.
 */
export function pdfSafe(value: string): string {
  let output = "";
  for (const character of value.normalize("NFC")) {
    const replacement = PDF_REPLACEMENTS[character];
    if (replacement !== undefined) {
      output += replacement;
      continue;
    }
    const code = character.codePointAt(0)!;
    if (code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(code)) {
      output += character;
      continue;
    }
    const stripped = character.normalize("NFD").replace(/\p{M}/gu, "");
    output += /^[\x20-\x7e]$/.test(stripped) ? stripped : "?";
  }
  return output;
}
