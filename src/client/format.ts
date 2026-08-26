export function formatFrequency(hz: number, digits = 1): string {
  return `${(hz / 1_000_000).toFixed(digits).replace(/\.0$/, "")} MHz`;
}

export function formatRange(startHz: number, endHz: number): string {
  return `${(startHz / 1_000_000).toFixed(startHz % 1_000_000 ? 3 : 0)} - ${(endHz / 1_000_000).toFixed(endHz % 1_000_000 ? 3 : 0)} MHz`;
}

export function formatDuration(startedAt: string, endedAt = new Date().toISOString()): string {
  const seconds = Math.max(0, Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function compactNumber(value: number): string {
  if (value >= 10 || Number.isInteger(value)) return Math.round(value).toLocaleString();
  return value.toFixed(1).replace(/\.0$/, "");
}

/** Short, operator-facing storage value. Detailed diagnostics retain exact units. */
export function formatCompactBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "Not reported";
  const absolute = Math.max(0, bytes);
  if (absolute < 1_024) return `${Math.round(absolute)} B`;
  if (absolute < 1_048_576) return `${compactNumber(absolute / 1_024)} KB`;
  if (absolute < 1_073_741_824) return `${compactNumber(absolute / 1_048_576)} MB`;
  if (absolute < 1_099_511_627_776) return `${compactNumber(absolute / 1_073_741_824)} GB`;
  return `${compactNumber(absolute / 1_099_511_627_776)} TB`;
}

export function formatCompactRate(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)
    ? "Not reported"
    : `${formatCompactBytes(bytesPerSecond)}/s`;
}

export function formatCompactPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "Not reported" : `${compactNumber(Math.max(0, value))}%`;
}

export function timeOnly(timestamp: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(timestamp));
}

export function dateTime(timestamp: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(timestamp));
}

export function timeZoneShort(timeZone: string, timestamp = new Date()): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "short" })
    .formatToParts(timestamp)
    .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}
