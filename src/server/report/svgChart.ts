import { areaPaths, bandPaths, linePath, plotBox, scaleX, scaleY, type ChartSpec } from "./chartSpec";
import { REPORT_COLORS, REPORT_FONT_STACK } from "./theme";
import { escapeHtml } from "./format";

const xml = escapeHtml;

function dashAttribute(dash?: number[]): string {
  return dash?.length ? ` stroke-dasharray="${dash.join(" ")}"` : "";
}

/**
 * Render a chart spec as a self-contained, accessible SVG. With `standalone`,
 * the title and caption are drawn inside the image (for files opened alone);
 * inside the HTML report they are real headings and figure captions instead.
 */
export function chartToSvg(spec: ChartSpec, options: { standalone?: boolean; idPrefix?: string } = {}): string {
  const box = plotBox(spec);
  const titleOffset = options.standalone ? 34 : 0;
  const captionHeight = options.standalone ? 26 + (spec.footer?.length ?? 0) * 15 : 0;
  const width = spec.width;
  const height = spec.height + titleOffset + captionHeight;
  const id = `${options.idPrefix ?? "chart"}-${spec.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-title ${id}-desc" font-family="${xml(REPORT_FONT_STACK)}">`);
  out.push(`<title id="${id}-title">${xml(spec.title)}</title><desc id="${id}-desc">${xml(spec.ariaLabel)}</desc>`);
  out.push(`<rect width="${width}" height="${height}" fill="${REPORT_COLORS.white}"/>`);
  if (options.standalone) {
    out.push(`<text x="${box.left}" y="22" font-size="16" font-weight="700" fill="${REPORT_COLORS.ink}">${xml(spec.title)}</text>`);
  }
  out.push(`<g transform="translate(0 ${titleOffset})">`);
  const clipId = `${id}-clip`;
  out.push(`<defs><clipPath id="${clipId}"><rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}"/></clipPath></defs>`);
  out.push(`<rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="${REPORT_COLORS.white}" stroke="${REPORT_COLORS.rule}"/>`);

  // Grid and ticks
  for (const tick of spec.y.ticks) {
    const y = scaleY(spec, tick.value);
    out.push(`<line x1="${box.left}" x2="${box.left + box.width}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${REPORT_COLORS.grid}"/>`);
    out.push(`<text x="${box.left - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${REPORT_COLORS.muted}">${xml(tick.label)}</text>`);
  }
  for (const tick of spec.x.ticks) {
    const x = scaleX(spec, tick.value);
    out.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${box.top}" y2="${box.top + box.height}" stroke="${REPORT_COLORS.grid}"/>`);
    out.push(`<text x="${x.toFixed(1)}" y="${box.top + box.height + 16}" font-size="11" text-anchor="middle" fill="${REPORT_COLORS.muted}">${xml(tick.label)}</text>`);
  }
  out.push(`<text x="${box.left + box.width / 2}" y="${box.top + box.height + 38}" font-size="12" text-anchor="middle" fill="${REPORT_COLORS.ink}">${xml(spec.x.label)}</text>`);
  out.push(`<text transform="translate(16 ${box.top + box.height / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${REPORT_COLORS.ink}">${xml(spec.y.label)}</text>`);

  out.push(`<g clip-path="url(#${clipId})">`);
  if (spec.image) {
    out.push(`<image x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" preserveAspectRatio="none" style="image-rendering:pixelated" href="data:image/png;base64,${spec.image.pngBase64}"/>`);
  }
  for (const region of spec.xRegions ?? []) {
    const x1 = scaleX(spec, region.from);
    const x2 = scaleX(spec, region.to);
    out.push(`<rect x="${Math.min(x1, x2).toFixed(1)}" y="${box.top}" width="${Math.max(1, Math.abs(x2 - x1)).toFixed(1)}" height="${box.height}" fill="${region.color}" fill-opacity="${region.opacity}"/>`);
    if (region.label && Math.abs(x2 - x1) > 90) out.push(`<text x="${(Math.min(x1, x2) + 6).toFixed(1)}" y="${box.top + box.height - 8}" font-size="11" fill="${REPORT_COLORS.muted}">${xml(region.label)}</text>`);
  }
  for (const series of spec.series) {
    if (series.kind === "band") {
      for (const path of bandPaths(spec, series.upper, series.lower)) out.push(`<path d="${path}" fill="${series.color}" fill-opacity="${series.opacity}" stroke="none"/>`);
    } else if (series.kind === "area") {
      for (const path of areaPaths(spec, series.points)) out.push(`<path d="${path}" fill="${series.color}" fill-opacity="${series.opacity}" stroke="none"/>`);
    } else if (series.kind === "points") {
      series.points.forEach((point, index) => {
        if (!point) return;
        out.push(`<circle cx="${scaleX(spec, point[0]).toFixed(1)}" cy="${scaleY(spec, point[1]).toFixed(1)}" r="${series.radius ?? 2.6}" fill="${series.colors?.[index] ?? series.color}" stroke="${REPORT_COLORS.ink}" stroke-opacity="0.45" stroke-width="0.5"/>`);
      });
    } else {
      const path = linePath(spec, series.points);
      if (path) out.push(`<path d="${path}" fill="none" stroke="${series.color}" stroke-width="${series.width ?? 1.6}" stroke-linejoin="round" stroke-linecap="round"${dashAttribute(series.dash)}/>`);
    }
  }
  for (const rule of spec.hRules ?? []) {
    const y = scaleY(spec, rule.value);
    out.push(`<line x1="${box.left}" x2="${box.left + box.width}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${rule.color}" stroke-width="1.4"${dashAttribute(rule.dash)}/>`);
  }
  for (const rule of spec.vRules ?? []) {
    const x = scaleX(spec, rule.value);
    out.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${box.top}" y2="${box.top + box.height}" stroke="${rule.color}" stroke-width="1.6"${dashAttribute(rule.dash)}/>`);
  }
  out.push(`</g>`);
  for (const rule of spec.vRules ?? []) {
    if (!rule.label) continue;
    const x = scaleX(spec, rule.value);
    out.push(`<text x="${(x + 4).toFixed(1)}" y="${box.top + 12}" font-size="11" font-weight="600" fill="${rule.color}">${xml(rule.label)}</text>`);
  }
  for (const rule of spec.hRules ?? []) {
    if (!rule.label) continue;
    const y = scaleY(spec, rule.value);
    out.push(`<text x="${box.left + box.width - 4}" y="${(y - 4).toFixed(1)}" font-size="11" font-weight="600" text-anchor="end" fill="${rule.color}">${xml(rule.label)}</text>`);
  }
  if (spec.emptyMessage) {
    out.push(`<text x="${box.left + box.width / 2}" y="${box.top + box.height / 2}" font-size="14" text-anchor="middle" fill="${REPORT_COLORS.muted}">${xml(spec.emptyMessage)}</text>`);
  }

  // Legend (top row)
  let legendX = box.left;
  for (const item of spec.legend) {
    const y = 18;
    if (item.style === "area" || item.style === "region") {
      out.push(`<rect x="${legendX}" y="${y - 8}" width="16" height="10" fill="${item.color}" fill-opacity="${item.style === "region" ? 0.25 : 0.35}" stroke="${item.color}"/>`);
    } else {
      out.push(`<line x1="${legendX}" x2="${legendX + 18}" y1="${y - 3}" y2="${y - 3}" stroke="${item.color}" stroke-width="2.2"${item.style === "dash" ? ' stroke-dasharray="5 3"' : ""}/>`);
    }
    out.push(`<text x="${legendX + 24}" y="${y + 1}" font-size="11.5" fill="${REPORT_COLORS.ink}">${xml(item.name)}</text>`);
    legendX += 24 + item.name.length * 6.6 + 18;
  }
  out.push(`</g>`);
  if (options.standalone) {
    out.push(`<text x="${box.left}" y="${spec.height + titleOffset + 16}" font-size="11.5" fill="${REPORT_COLORS.muted}">${xml(spec.caption)}</text>`);
    (spec.footer ?? []).forEach((line, index) => {
      out.push(`<text x="${box.left}" y="${spec.height + titleOffset + 34 + index * 15}" font-size="10.5" fill="${REPORT_COLORS.faint}">${xml(line)}</text>`);
    });
  }
  out.push(`</svg>`);
  return out.join("");
}
