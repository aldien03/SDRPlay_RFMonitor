import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { IncidentReportModel, ReportFact } from "./reportModel";
import type { ChartSpec } from "./chartSpec";
import { drawChartPdf } from "./pdfChart";
import { pdfSafe } from "./format";
import { hexToRgb01, REPORT_COLORS } from "./theme";

export const A4 = { width: 595.28, height: 841.89 };
export const MARGIN = { left: 46, right: 46, top: 62, bottom: 54 };
export const CONTENT_WIDTH = A4.width - MARGIN.left - MARGIN.right;

function color(hex: string) {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
}

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

/** Word wrap with a hard break for very long tokens such as hashes. */
export function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(value).split("\n")) {
    let current = "";
    for (const rawWord of paragraph.split(/\s+/).filter(Boolean)) {
      let word = rawWord;
      while (font.widthOfTextAtSize(word, size) > width) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut -= 1;
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) current = candidate;
      else {
        if (current) lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

export class Layout {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];

  constructor(private readonly doc: PDFDocument, private readonly fonts: Fonts) {}

  newPage(): void {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN.top;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN.bottom) this.newPage();
  }

  space(points: number): void {
    this.y -= points;
  }

  text(value: string, options: { size?: number; bold?: boolean; mono?: boolean; color?: string; indent?: number; width?: number; lineGap?: number } = {}): void {
    const size = options.size ?? 10;
    const font = options.mono ? this.fonts.mono : options.bold ? this.fonts.bold : this.fonts.regular;
    const indent = options.indent ?? 0;
    const width = options.width ?? CONTENT_WIDTH - indent;
    const lineHeight = size * (options.lineGap ?? 1.38);
    for (const line of wrap(value, font, size, width)) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x: MARGIN.left + indent, y: this.y - size, size, font, color: color(options.color ?? REPORT_COLORS.ink) });
      this.y -= lineHeight;
    }
  }

  heading(number: number, title: string): void {
    this.ensure(64);
    this.space(14);
    this.page.drawText(String(number), { x: MARGIN.left, y: this.y - 15, size: 12, font: this.fonts.bold, color: color(REPORT_COLORS.accent) });
    this.page.drawText(pdfSafe(title), { x: MARGIN.left + 18, y: this.y - 15, size: 15, font: this.fonts.bold, color: color(REPORT_COLORS.navy) });
    this.y -= 22;
    this.page.drawLine({ start: { x: MARGIN.left, y: this.y }, end: { x: A4.width - MARGIN.right, y: this.y }, thickness: 1.4, color: color(REPORT_COLORS.navy) });
    this.y -= 10;
  }

  subheading(title: string): void {
    this.ensure(36);
    this.space(6);
    this.text(title, { size: 11, bold: true, color: REPORT_COLORS.navy });
    this.space(2);
  }

  facts(rows: ReportFact[], labelWidth = 150, valueBold = true): void {
    const size = 9.5;
    for (const row of rows) {
      const valueLines = wrap(`${row.value}${row.note ? `\n${row.note}` : ""}`, this.fonts.regular, size, CONTENT_WIDTH - labelWidth - 12);
      const labelLines = wrap(row.label, this.fonts.bold, size, labelWidth - 12);
      const height = Math.max(valueLines.length, labelLines.length) * size * 1.35 + 8;
      this.ensure(height);
      this.page.drawRectangle({ x: MARGIN.left, y: this.y - height, width: labelWidth, height, color: color(REPORT_COLORS.panel) });
      labelLines.forEach((line, index) => this.page.drawText(line, { x: MARGIN.left + 6, y: this.y - 4 - size - index * size * 1.35, size, font: this.fonts.bold, color: color(REPORT_COLORS.muted) }));
      const noteStart = row.note ? wrap(row.value, this.fonts.regular, size, CONTENT_WIDTH - labelWidth - 12).length : valueLines.length;
      valueLines.forEach((line, index) => this.page.drawText(line, { x: MARGIN.left + labelWidth + 8, y: this.y - 4 - size - index * size * 1.35, size, font: index < noteStart && valueBold ? this.fonts.bold : this.fonts.regular, color: color(index < noteStart ? REPORT_COLORS.ink : REPORT_COLORS.muted) }));
      this.y -= height;
      this.page.drawLine({ start: { x: MARGIN.left, y: this.y }, end: { x: A4.width - MARGIN.right, y: this.y }, thickness: 0.5, color: color(REPORT_COLORS.rule) });
    }
    this.space(6);
  }

  table(columns: Array<{ title: string; width: number; mono?: boolean }>, rows: string[][], options: { highlightColumn?: number; highlight?: (row: string[]) => boolean } = {}): void {
    const size = 9;
    const total = columns.reduce((sum, column) => sum + column.width, 0);
    const widths = columns.map((column) => (column.width / total) * CONTENT_WIDTH);
    const drawHeader = () => {
      this.ensure(22);
      this.page.drawRectangle({ x: MARGIN.left, y: this.y - 18, width: CONTENT_WIDTH, height: 18, color: color(REPORT_COLORS.panel) });
      let x = MARGIN.left;
      columns.forEach((column, index) => {
        this.page.drawText(pdfSafe(column.title.toUpperCase()), { x: x + 5, y: this.y - 12.5, size: 7.5, font: this.fonts.bold, color: color(REPORT_COLORS.muted) });
        x += widths[index];
      });
      this.y -= 18;
    };
    drawHeader();
    rows.forEach((row, rowIndex) => {
      const cellLines = row.map((cell, index) => wrap(cell, columns[index].mono ? this.fonts.mono : this.fonts.regular, columns[index].mono ? 8 : size, widths[index] - 10));
      const height = Math.max(...cellLines.map((lines) => lines.length)) * size * 1.35 + 8;
      if (this.y - height < MARGIN.bottom) {
        this.newPage();
        drawHeader();
      }
      if (rowIndex % 2 === 1) this.page.drawRectangle({ x: MARGIN.left, y: this.y - height, width: CONTENT_WIDTH, height, color: color("#fafbfc") });
      let x = MARGIN.left;
      cellLines.forEach((lines, index) => {
        const highlighted = options.highlightColumn === index && options.highlight?.(row);
        lines.forEach((line, lineIndex) => {
          this.page.drawText(line, {
            x: x + 5,
            y: this.y - 4 - size - lineIndex * size * 1.35,
            size: columns[index].mono ? 8 : size,
            font: columns[index].mono ? this.fonts.mono : index === 0 || highlighted ? this.fonts.bold : this.fonts.regular,
            color: color(highlighted ? REPORT_COLORS.anomaly : REPORT_COLORS.ink),
          });
        });
        x += widths[index];
      });
      this.y -= height;
      this.page.drawLine({ start: { x: MARGIN.left, y: this.y }, end: { x: A4.width - MARGIN.right, y: this.y }, thickness: 0.5, color: color(REPORT_COLORS.rule) });
    });
    this.space(8);
  }

  callout(title: string, lines: string[], accent: string, background: string): void {
    const size = 9.5;
    const wrapped = lines.flatMap((line) => wrap(`•  ${line}`, this.fonts.regular, size, CONTENT_WIDTH - 24));
    const height = 22 + wrapped.length * size * 1.4 + 6;
    this.ensure(height);
    this.page.drawRectangle({ x: MARGIN.left, y: this.y - height, width: CONTENT_WIDTH, height, color: color(background) });
    this.page.drawRectangle({ x: MARGIN.left, y: this.y - height, width: 3.5, height, color: color(accent) });
    this.page.drawText(pdfSafe(title), { x: MARGIN.left + 12, y: this.y - 15, size: 10, font: this.fonts.bold, color: color(REPORT_COLORS.ink) });
    wrapped.forEach((line, index) => this.page.drawText(line, { x: MARGIN.left + 12, y: this.y - 30 - index * size * 1.4, size, font: this.fonts.regular, color: color(REPORT_COLORS.ink) }));
    this.y -= height + 8;
  }

  chart(spec: ChartSpec, number: number, image?: PDFImage): void {
    const height = CONTENT_WIDTH * (spec.height / spec.width);
    const titleLines = wrap(`Figure ${number}. ${spec.title}.`, this.fonts.bold, 9, CONTENT_WIDTH);
    const bodyLines = wrap(spec.caption, this.fonts.regular, 8.5, CONTENT_WIDTH);
    const captionLines = [...titleLines.map((line) => ({ line, bold: true })), ...bodyLines.map((line) => ({ line, bold: false }))];
    this.ensure(height + captionLines.length * 12 + 14);
    drawChartPdf(this.page, spec, MARGIN.left, this.y, CONTENT_WIDTH, { regular: this.fonts.regular, bold: this.fonts.bold }, image);
    this.page.drawRectangle({ x: MARGIN.left, y: this.y - height, width: CONTENT_WIDTH, height, borderColor: color(REPORT_COLORS.rule), borderWidth: 0.5 });
    this.y -= height + 6;
    captionLines.forEach((entry, index) => this.page.drawText(entry.line, { x: MARGIN.left, y: this.y - 8.5 - index * 12, size: entry.bold ? 9 : 8.5, font: entry.bold ? this.fonts.bold : this.fonts.regular, color: color(entry.bold ? REPORT_COLORS.ink : REPORT_COLORS.muted) }));
    this.y -= captionLines.length * 12 + 12;
  }
}

function decodeDataUri(value: string | undefined): { bytes: Uint8Array; mediaType: string } | undefined {
  const match = value ? /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(value) : undefined;
  return match ? { mediaType: match[1], bytes: Uint8Array.from(Buffer.from(match[2], "base64")) } : undefined;
}

/** A4 PDF of the incident report: the same model and charts as the HTML, as vector graphics. */
export async function renderIncidentReportPdf(model: IncidentReportModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const author = model.identity.companyName ?? model.identity.siteName;
  doc.setTitle(pdfSafe(`${model.title} ${model.reference}`));
  doc.setSubject(pdfSafe(`${model.incident.verdict} - ${model.incident.affected}`));
  doc.setAuthor(pdfSafe(author));
  doc.setCreator("RF Monitor");
  doc.setProducer("RF Monitor (pdf-lib)");
  doc.setKeywords(["RF incident", model.reference, model.incident.evidenceStrength, model.dataDomain].map(pdfSafe));
  doc.setCreationDate(new Date(model.generatedAt));
  doc.setModificationDate(new Date(model.generatedAt));

  const logoSource = decodeDataUri(model.identity.logo?.dataUri);
  let logo: PDFImage | undefined;
  try {
    if (logoSource) logo = logoSource.mediaType === "image/png" ? await doc.embedPng(logoSource.bytes) : await doc.embedJpg(logoSource.bytes);
  } catch {
    logo = undefined;
  }

  const layout = new Layout(doc, fonts);

  // ---- Cover -----------------------------------------------------------------
  layout.newPage();
  const cover = layout.page;
  const bandHeight = 330;
  cover.drawRectangle({ x: 0, y: A4.height - bandHeight, width: A4.width, height: bandHeight, color: color(REPORT_COLORS.navy) });
  let brandX = MARGIN.left;
  if (logo) {
    const scale = Math.min(150 / logo.width, 44 / logo.height);
    const width = logo.width * scale;
    const height = logo.height * scale;
    cover.drawRectangle({ x: MARGIN.left - 4, y: A4.height - 56 - height - 4, width: width + 8, height: height + 8, color: rgb(1, 1, 1) });
    cover.drawImage(logo, { x: MARGIN.left, y: A4.height - 56 - height, width, height });
    brandX = MARGIN.left + width + 18;
  }
  cover.drawText(pdfSafe(model.identity.companyName ?? model.identity.siteName), { x: brandX, y: A4.height - 80, size: 13, font: fonts.bold, color: rgb(1, 1, 1) });
  cover.drawText(pdfSafe(model.title.toUpperCase()), { x: MARGIN.left, y: A4.height - 140, size: 11, font: fonts.bold, color: color("#c9d6e3") });
  const verdictLines = wrap(model.incident.verdict, fonts.bold, 26, CONTENT_WIDTH);
  verdictLines.forEach((line, index) => cover.drawText(line, { x: MARGIN.left, y: A4.height - 176 - index * 30, size: 26, font: fonts.bold, color: rgb(1, 1, 1) }));
  const afterVerdict = A4.height - 176 - verdictLines.length * 30;
  cover.drawText(pdfSafe(`${model.reference}`), { x: MARGIN.left, y: afterVerdict - 4, size: 10.5, font: fonts.regular, color: color("#c9d6e3") });
  cover.drawText(pdfSafe(model.incident.affected), { x: MARGIN.left, y: afterVerdict - 20, size: 10.5, font: fonts.regular, color: color("#c9d6e3") });
  let chipX = MARGIN.left;
  const chip = (label: string, fill?: string) => {
    const width = fonts.bold.widthOfTextAtSize(pdfSafe(label), 9) + 16;
    cover.drawRectangle({ x: chipX, y: afterVerdict - 52, width, height: 17, color: fill ? color(fill) : color(REPORT_COLORS.navy), borderColor: rgb(1, 1, 1), borderWidth: 0.6, borderOpacity: 0.7 });
    cover.drawText(pdfSafe(label), { x: chipX + 8, y: afterVerdict - 46.5, size: 9, font: fonts.bold, color: rgb(1, 1, 1) });
    chipX += width + 8;
  };
  chip(model.incident.status);
  chip(`${model.incident.evidenceStrength} evidence`, model.incident.evidenceStrength === "Medium" ? REPORT_COLORS.ok : REPORT_COLORS.warn);
  if (model.incident.ruleLabel) chip(model.incident.ruleLabel);
  if (model.dataDomain === "test") chip("Simulation / Test data", REPORT_COLORS.simulation);

  // Cover facts grid
  const coverFacts: Array<[string, string]> = [
    ...(model.identity.clientName ? [["Client", model.identity.clientName] as [string, string]] : []),
    ...(model.identity.vesselName ? [["Vessel or platform", model.identity.vesselName] as [string, string]] : []),
    ...(model.identity.projectReference ? [["Project", model.identity.projectReference] as [string, string]] : []),
    ["Site", `${model.identity.siteName}${model.identity.deploymentId ? ` (${model.identity.deploymentId})` : ""}`],
    ["Started", model.incident.startedAt],
    [model.incident.endedAt ? "Ended" : "Status", model.incident.endedAt ?? model.incident.status],
    ["Disturbed frequencies", model.incident.disturbed],
    ["Report generated", model.generatedAtText],
    ["Record", model.scope === "evidence-package" ? "Evidence package" : "Live report"],
  ];
  let gridY = A4.height - bandHeight - 34;
  const columnWidth = CONTENT_WIDTH / 2 - 10;
  for (let index = 0; index < coverFacts.length; index += 2) {
    let rowHeight = 0;
    for (let column = 0; column < 2; column += 1) {
      const fact = coverFacts[index + column];
      if (!fact) continue;
      const x = MARGIN.left + column * (columnWidth + 20);
      cover.drawText(pdfSafe(fact[0].toUpperCase()), { x, y: gridY, size: 7.5, font: fonts.bold, color: color(REPORT_COLORS.muted) });
      const lines = wrap(fact[1], fonts.bold, 10.5, columnWidth);
      lines.forEach((line, lineIndex) => cover.drawText(line, { x, y: gridY - 15 - lineIndex * 14, size: 10.5, font: fonts.bold, color: color(REPORT_COLORS.ink) }));
      rowHeight = Math.max(rowHeight, 18 + lines.length * 14);
    }
    gridY -= rowHeight + 8;
  }
  layout.y = gridY - 6;
  layout.callout("What this report does not show", model.limitations.slice(0, 3), REPORT_COLORS.alertLevel, "#fff6e5");

  // ---- Body ------------------------------------------------------------------
  layout.newPage();
  let section = 0;
  layout.heading(++section, "Summary");
  layout.text(model.summary.paragraph, { size: 10.5 });
  layout.space(6);
  layout.facts(model.summary.facts);

  layout.heading(++section, "Why the alert was raised");
  if (model.why) {
    layout.text(model.why.sentence, { size: 10.5 });
    layout.space(4);
    layout.table(
      [{ title: "Rule", width: 34 }, { title: "Measured", width: 26 }, { title: "Alert level", width: 26 }, { title: "Met", width: 10 }],
      model.why.rules.map((rule) => [rule.label, rule.measured, rule.threshold, rule.met ? "Yes" : "No"]),
      { highlightColumn: 3, highlight: (row) => row[3] === "Yes" },
    );
    layout.text(model.why.persistence, { size: 9, color: REPORT_COLORS.muted });
    layout.subheading(`Alert sensitivity: ${model.why.sensitivity.label} (${model.why.sensitivity.source})`);
    layout.facts(model.why.sensitivity.rules);
    layout.subheading("Reference used");
    layout.facts(model.why.reference);
  } else {
    layout.text(model.incident.observed);
    layout.text("This record was made before trigger details were stored, so the exact values compared are not available.", { size: 9, color: REPORT_COLORS.muted });
  }

  let figureNumber = 0;
  const imageFor = async (spec: ChartSpec) => {
    if (!spec.image) return undefined;
    try {
      return await doc.embedPng(Uint8Array.from(Buffer.from(spec.image.pngBase64, "base64")));
    } catch {
      return undefined;
    }
  };
  const drawCharts = async (ids: string[]) => {
    for (const id of ids) {
      const spec = model.charts.find((chart) => chart.id === id);
      if (!spec) continue;
      layout.chart(spec, ++figureNumber, await imageFor(spec));
    }
  };

  layout.heading(++section, "What the receiver recorded");
  if (!model.charts.some((chart) => ["trigger-snapshot", "spectrum-overview", "waterfall"].includes(chart.id))) {
    layout.text("No recorded frames were available to draw for this record.", { color: REPORT_COLORS.muted });
  }
  await drawCharts(["trigger-snapshot", "spectrum-overview", "waterfall"]);

  layout.heading(++section, "Timeline");
  layout.table([{ title: "Time", width: 38 }, { title: "Event", width: 26 }, { title: "Detail", width: 36 }], model.timeline.map((row) => [row.atText, row.label, row.detail ?? ""]));

  layout.heading(++section, "Analysis of the recorded frames");
  for (const finding of model.findings) layout.text(`•  ${finding}`, { size: 9.5 });
  if (model.keyNumbers.length) {
    layout.subheading("Key numbers");
    layout.facts(model.keyNumbers, 190);
  }
  await drawCharts(["level-over-time", "excess-over-time", "strongest-frequency", "above-normal-by-frequency"]);

  layout.heading(++section, "Receiver and configuration");
  layout.facts(model.receiver);
  layout.subheading("Software");
  layout.facts(model.software);

  layout.heading(++section, "Operator notes");
  if (model.notes.length) {
    for (const note of model.notes) {
      layout.text(note.atText, { size: 8.5, color: REPORT_COLORS.muted });
      layout.text(note.text, { size: 10, indent: 8 });
      layout.space(4);
    }
  } else layout.text("No notes were added to this incident.", { color: REPORT_COLORS.muted });

  layout.heading(++section, "Evidence integrity");
  for (const statement of model.integrity.statements) layout.text(statement, { size: 9.5 });
  layout.subheading("Completeness");
  for (const statement of model.completeness.statements) layout.text(`•  ${statement}`, { size: 9.5 });
  layout.subheading("How to check the files");
  layout.table([{ title: "Computer", width: 28 }, { title: "Command, run inside the extracted folder", width: 72, mono: true }], model.integrity.verify.map((row) => [row.platform, row.command]));
  if (model.integrity.files.length) {
    layout.subheading("Key evidence files");
    layout.table([{ title: "File", width: 38, mono: true }, { title: "Bytes", width: 14 }, { title: "SHA-256", width: 48, mono: true }], model.integrity.files.map((file) => [file.path, file.bytes.toLocaleString("en-GB"), file.sha256]));
  }

  layout.heading(++section, "Limitations and terms");
  for (const line of model.limitations) layout.text(`•  ${line}`, { size: 9.5 });
  layout.subheading("Terms used");
  layout.facts(model.glossary, 130, false);

  // ---- Running header and footer on every page after the cover ----------------
  const total = layout.pages.length;
  layout.pages.forEach((page, index) => {
    const pageNumber = `Page ${index + 1} of ${total}`;
    const footerY = 30;
    page.drawLine({ start: { x: MARGIN.left, y: footerY + 12 }, end: { x: A4.width - MARGIN.right, y: footerY + 12 }, thickness: 0.5, color: color(REPORT_COLORS.rule) });
    page.drawText(pdfSafe("RF data can show interference, not intent. Relative, uncalibrated levels."), { x: MARGIN.left, y: footerY, size: 7.5, font: fonts.regular, color: color(REPORT_COLORS.muted) });
    page.drawText(pageNumber, { x: A4.width - MARGIN.right - fonts.regular.widthOfTextAtSize(pageNumber, 7.5), y: footerY, size: 7.5, font: fonts.regular, color: color(REPORT_COLORS.muted) });
    if (index === 0) return;
    const headerY = A4.height - 36;
    page.drawText(pdfSafe(model.identity.companyName ?? model.identity.siteName), { x: MARGIN.left, y: headerY, size: 8, font: fonts.bold, color: color(REPORT_COLORS.navy) });
    const right = pdfSafe(`${model.reference}${model.dataDomain === "test" ? " - SIMULATION / TEST" : ""}`);
    page.drawText(right, { x: A4.width - MARGIN.right - fonts.regular.widthOfTextAtSize(right, 8), y: headerY, size: 8, font: fonts.regular, color: color(model.dataDomain === "test" ? REPORT_COLORS.simulation : REPORT_COLORS.muted) });
    page.drawLine({ start: { x: MARGIN.left, y: headerY - 8 }, end: { x: A4.width - MARGIN.right, y: headerY - 8 }, thickness: 0.5, color: color(REPORT_COLORS.rule) });
  });

  return doc.save({ useObjectStreams: true });
}
