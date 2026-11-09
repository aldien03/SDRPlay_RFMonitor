/**
 * One visual language for every incident deliverable (HTML report, PDF report,
 * stand-alone SVG charts). Colours follow the dashboard: blue received energy,
 * green learned usual level, amber alert level, red raised (anomalous) energy.
 * All text colours meet WCAG AA on white.
 */
export const REPORT_COLORS = {
  ink: "#14212e",
  muted: "#4a5b6b",
  faint: "#6b7a88",
  rule: "#d5dde4",
  grid: "#e6ebef",
  panel: "#f4f7f9",
  navy: "#0b2340",
  accent: "#0a5cad",
  received: "#1f6fd1",
  receivedFill: "#1f6fd1",
  usual: "#1d7f45",
  alertLevel: "#a35f00",
  anomaly: "#c8102e",
  before: "#7a8794",
  gap: "#eef1f4",
  incident: "#c8102e",
  white: "#ffffff",
  simulation: "#6a4bb3",
  ok: "#1d7f45",
  warn: "#a35f00",
} as const;

/** The dashboard's own font stack, so the in-app report and charts match the screen around them. */
export const REPORT_FONT_STACK = "Inter, 'Segoe UI', Arial, sans-serif";

export type ReportColor = string;

export function hexToRgb01(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((part) => part + part).join("") : value;
  const number = Number.parseInt(full, 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}
