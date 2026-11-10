import { LineCapStyle, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { areaPaths, bandPaths, linePath, plotBox, scaleX, scaleY, type ChartSpec } from "./chartSpec";
import { hexToRgb01, REPORT_COLORS } from "./theme";
import { pdfSafe } from "./format";

function color(hex: string) {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
}

export interface PdfChartFonts {
  regular: PDFFont;
  bold: PDFFont;
}

/**
 * Draw a chart spec as vector graphics inside a box on a PDF page.
 * `x`,`y` is the box's top-left corner in PDF points (y measured from the
 * page bottom, as pdf-lib does). The spec's pixel layout is scaled to fit.
 */
export function drawChartPdf(page: PDFPage, spec: ChartSpec, x: number, top: number, width: number, fonts: PdfChartFonts, image?: PDFImage): number {
  const scale = width / spec.width;
  const height = spec.height * scale;
  const box = plotBox(spec);
  const svg = (path: string, options: Parameters<PDFPage["drawSvgPath"]>[1]) => page.drawSvgPath(path, { x, y: top, scale, ...options });
  const toPdfX = (value: number) => x + value * scale;
  const toPdfY = (value: number) => top - value * scale;
  const text = (value: string, px: number, py: number, size: number, options: { bold?: boolean; color?: string; align?: "left" | "center" | "right"; rotate?: boolean } = {}) => {
    const font = options.bold ? fonts.bold : fonts.regular;
    const safe = pdfSafe(value);
    const fontSize = size * scale;
    const textWidth = font.widthOfTextAtSize(safe, fontSize);
    if (options.rotate) {
      page.drawText(safe, { x: toPdfX(px) + fontSize / 3, y: toPdfY(py) - textWidth / 2, size: fontSize, font, color: color(options.color ?? REPORT_COLORS.ink), rotate: { type: "degrees" as never, angle: 90 } as never });
      return;
    }
    const offset = options.align === "center" ? textWidth / 2 : options.align === "right" ? textWidth : 0;
    page.drawText(safe, { x: toPdfX(px) - offset, y: toPdfY(py), size: fontSize, font, color: color(options.color ?? REPORT_COLORS.ink) });
  };

  page.drawRectangle({ x: toPdfX(box.left), y: toPdfY(box.top + box.height), width: box.width * scale, height: box.height * scale, borderColor: color(REPORT_COLORS.rule), borderWidth: 0.6, color: color(REPORT_COLORS.white) });
  for (const tick of spec.y.ticks) {
    const y = scaleY(spec, tick.value);
    page.drawLine({ start: { x: toPdfX(box.left), y: toPdfY(y) }, end: { x: toPdfX(box.left + box.width), y: toPdfY(y) }, thickness: 0.4, color: color(REPORT_COLORS.grid) });
    text(tick.label, box.left - 8, y + 4, 11, { align: "right", color: REPORT_COLORS.muted });
  }
  for (const tick of spec.x.ticks) {
    const px = scaleX(spec, tick.value);
    page.drawLine({ start: { x: toPdfX(px), y: toPdfY(box.top) }, end: { x: toPdfX(px), y: toPdfY(box.top + box.height) }, thickness: 0.4, color: color(REPORT_COLORS.grid) });
    text(tick.label, px, box.top + box.height + 16, 11, { align: "center", color: REPORT_COLORS.muted });
  }
  text(spec.x.label, box.left + box.width / 2, box.top + box.height + 38, 12, { align: "center" });
  text(spec.y.label, 18, box.top + box.height / 2, 12, { rotate: true });

  if (image) {
    page.drawImage(image, { x: toPdfX(box.left), y: toPdfY(box.top + box.height), width: box.width * scale, height: box.height * scale });
  }
  for (const region of spec.xRegions ?? []) {
    const x1 = Math.max(box.left, Math.min(scaleX(spec, region.from), scaleX(spec, region.to)));
    const x2 = Math.min(box.left + box.width, Math.max(scaleX(spec, region.from), scaleX(spec, region.to)));
    page.drawRectangle({ x: toPdfX(x1), y: toPdfY(box.top + box.height), width: Math.max(0.6, (x2 - x1) * scale), height: box.height * scale, color: color(region.color), opacity: region.opacity });
    if (region.label && x2 - x1 > 90) text(region.label, x1 + 6, box.top + box.height - 8, 11, { color: REPORT_COLORS.muted });
  }
  for (const series of spec.series) {
    if (series.kind === "band") {
      for (const path of bandPaths(spec, series.upper, series.lower)) svg(path, { color: color(series.color), opacity: series.opacity });
    } else if (series.kind === "area") {
      for (const path of areaPaths(spec, series.points)) svg(path, { color: color(series.color), opacity: series.opacity });
    } else if (series.kind === "points") {
      series.points.forEach((point, index) => {
        if (!point) return;
        page.drawCircle({ x: toPdfX(scaleX(spec, point[0])), y: toPdfY(scaleY(spec, point[1])), size: (series.radius ?? 2.6) * scale, color: color(series.colors?.[index] ?? series.color), borderColor: color(REPORT_COLORS.ink), borderWidth: 0.3, borderOpacity: 0.45 });
      });
    } else {
      const path = linePath(spec, series.points);
      if (path) {
        svg(path, {
          borderColor: color(series.color),
          borderWidth: (series.width ?? 1.6) * scale,
          borderLineCap: LineCapStyle.Round,
          ...(series.dash?.length ? { borderDashArray: series.dash.map((value) => value * scale) } : {}),
        });
      }
    }
  }
  for (const rule of spec.hRules ?? []) {
    const y = scaleY(spec, rule.value);
    page.drawLine({ start: { x: toPdfX(box.left), y: toPdfY(y) }, end: { x: toPdfX(box.left + box.width), y: toPdfY(y) }, thickness: 1.2 * scale, color: color(rule.color), ...(rule.dash ? { dashArray: rule.dash.map((value) => value * scale) } : {}) });
    if (rule.label) text(rule.label, box.left + box.width - 4, y - 4, 11, { align: "right", bold: true, color: rule.color });
  }
  for (const rule of spec.vRules ?? []) {
    const px = scaleX(spec, rule.value);
    if (px < box.left || px > box.left + box.width) continue;
    page.drawLine({ start: { x: toPdfX(px), y: toPdfY(box.top) }, end: { x: toPdfX(px), y: toPdfY(box.top + box.height) }, thickness: 1.4 * scale, color: color(rule.color), ...(rule.dash ? { dashArray: rule.dash.map((value) => value * scale) } : {}) });
    if (rule.label) text(rule.label, px + 4, box.top + 12, 11, { bold: true, color: rule.color });
  }
  if (spec.emptyMessage) text(spec.emptyMessage, box.left + box.width / 2, box.top + box.height / 2, 14, { align: "center", color: REPORT_COLORS.muted });

  let legendX = box.left;
  for (const item of spec.legend) {
    const ly = 18;
    if (item.style === "area" || item.style === "region") {
      page.drawRectangle({ x: toPdfX(legendX), y: toPdfY(ly + 2), width: 16 * scale, height: 10 * scale, color: color(item.color), opacity: item.style === "region" ? 0.25 : 0.35, borderColor: color(item.color), borderWidth: 0.5 });
    } else {
      page.drawLine({ start: { x: toPdfX(legendX), y: toPdfY(ly - 3) }, end: { x: toPdfX(legendX + 18), y: toPdfY(ly - 3) }, thickness: 2 * scale, color: color(item.color), ...(item.style === "dash" ? { dashArray: [5 * scale, 3 * scale] } : {}) });
    }
    text(item.name, legendX + 24, ly + 1, 11.5);
    legendX += 24 + fonts.regular.widthOfTextAtSize(pdfSafe(item.name), 11.5) + 18;
  }
  return height;
}
