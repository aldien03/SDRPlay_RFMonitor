import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { drawChartPdf } from "../report/pdfChart";
import { pdfSafe } from "../report/format";
import { wrap } from "../report/reportPdf";
import { hexToRgb01, REPORT_COLORS } from "../report/theme";
import type { PositioningReportModel, ReportBlock, ReportTable, Status } from "./reportModel";

/** US Letter, like the existing DGNSS verification deliverable. */
const PAGE = { width: 612, height: 792 };
const MARGIN = { left: 40, right: 40, top: 52, bottom: 44 };
const WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const INK = "#111111";
const HEADER_FILL = "#d6e6f5";
const BORDER = "#9aa5b1";
export const STATUS_COLOR: Record<Status, string> = { PASS: "#1d7f45", FAIL: "#c8102e", ALERT: "#c8102e", CHECK: "#a35f00", INFO: "#4a5b6b" };

function color(hex: string) {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
}

class Pages {
  page!: PDFPage;
  y = 0;
  readonly all: PDFPage[] = [];
  constructor(private readonly doc: PDFDocument, private readonly regular: PDFFont, private readonly bold: PDFFont) {}

  add(): void {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.all.push(this.page);
    this.y = PAGE.height - MARGIN.top;
  }

  ensure(height: number): boolean {
    if (this.y - height >= MARGIN.bottom) return false;
    this.add();
    return true;
  }

  text(value: string, size: number, options: { bold?: boolean; color?: string; x?: number; width?: number } = {}): void {
    const font = options.bold ? this.bold : this.regular;
    for (const line of wrap(value, font, size, options.width ?? WIDTH)) {
      this.ensure(size * 1.35);
      this.page.drawText(line, { x: options.x ?? MARGIN.left, y: this.y - size, size, font, color: color(options.color ?? INK) });
      this.y -= size * 1.35;
    }
  }

  heading(value: string, size = 11): void {
    this.ensure(size + 40);
    this.y -= 4;
    this.text(value, size, { bold: true });
    this.y -= 2;
  }

  /** Height of a table with its header, for keep-together decisions. */
  tableHeight(model: ReportTable): number {
    const size = 7.5;
    const total = model.columns.reduce((sum, column) => sum + column.width, 0);
    const widths = model.columns.map((column) => (column.width / total) * WIDTH);
    const rowHeight = (cells: string[], header: boolean) => Math.max(...cells.map((cell, index) => wrap(cell, header ? this.bold : this.regular, size, widths[index] - 6).length)) * size * 1.3 + 6;
    return rowHeight(model.columns.map((column) => column.title), true) + model.rows.reduce((sum, row) => sum + rowHeight(row, false), 0) + 6;
  }

  table(model: ReportTable): void {
    const size = 7.5;
    const lineHeight = size * 1.3;
    const total = model.columns.reduce((sum, column) => sum + column.width, 0);
    const widths = model.columns.map((column) => (column.width / total) * WIDTH);
    const drawRow = (cells: string[], header: boolean) => {
      const font = header ? this.bold : this.regular;
      const lines = cells.map((cell, index) => wrap(cell, header || (model.statusColumn === index) ? this.bold : font, size, widths[index] - 6));
      const height = Math.max(...lines.map((entry) => entry.length)) * lineHeight + 6;
      return { lines, height, header };
    };
    const paint = (row: ReturnType<typeof drawRow>) => {
      let x = MARGIN.left;
      row.lines.forEach((lines, index) => {
        const width = widths[index];
        this.page.drawRectangle({ x, y: this.y - row.height, width, height: row.height, color: row.header ? color(HEADER_FILL) : rgb(1, 1, 1), borderColor: color(BORDER), borderWidth: 0.5 });
        const status = !row.header && model.statusColumn === index ? STATUS_COLOR[(lines.join(" ") as Status)] : undefined;
        const align = model.columns[index].align ?? "left";
        const font = row.header || status ? this.bold : this.regular;
        lines.forEach((line, lineIndex) => {
          const textWidth = font.widthOfTextAtSize(line, size);
          const tx = align === "right" ? x + width - 3 - textWidth : align === "center" ? x + (width - textWidth) / 2 : x + 3;
          this.page.drawText(line, { x: tx, y: this.y - 3 - size - lineIndex * lineHeight + 1, size, font, color: color(status ?? INK) });
        });
        x += width;
      });
      this.y -= row.height;
    };
    const header = drawRow(model.columns.map((column) => column.title), true);
    const rows = model.rows.map((cells) => drawRow(cells, false));
    this.ensure(header.height + (rows[0]?.height ?? 0));
    paint(header);
    for (const row of rows) {
      if (this.ensure(row.height)) paint(header);
      paint(row);
    }
    this.y -= 6;
  }
}

/** Letter PDF with the same model and vector charts as the HTML report. */
export async function renderPositioningReportPdf(model: PositioningReportModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(pdfSafe(`${model.title} - ${model.source}`));
  doc.setSubject(pdfSafe(model.verdict));
  doc.setAuthor(pdfSafe(model.vesselName));
  doc.setCreator("RF Monitor");
  doc.setProducer("RF Monitor (pdf-lib)");
  doc.setCreationDate(new Date(model.generatedAt));
  doc.setModificationDate(new Date(model.generatedAt));

  const pages = new Pages(doc, regular, bold);
  const images = new Map<string, PDFImage>();
  for (const spec of model.charts) if (spec.image) images.set(spec.id, await doc.embedPng(Buffer.from(spec.image.pngBase64, "base64")));
  const chart = (id: string, title: boolean) => {
    const spec = model.charts.find((entry) => entry.id === id);
    if (!spec) return;
    const height = WIDTH * (spec.height / spec.width);
    const small = !title && /^(rf|rel)-/.test(spec.id);
    pages.ensure(height + (title ? 14 : small ? 12 : 4));
    if (title || small) pages.text(spec.title, title ? 8.5 : 7.5, { bold: true });
    drawChartPdf(pages.page, spec, MARGIN.left, pages.y, WIDTH, { regular, bold }, images.get(spec.id));
    pages.y -= height + 4;
  };
  const block = (entry: ReportBlock) => {
    if ("table" in entry) {
      const height = pages.tableHeight(model.tables[entry.table]) + (entry.heading ? 24 : 0);
      if (height < PAGE.height - MARGIN.top - MARGIN.bottom - 40) pages.ensure(height);
      if (entry.heading) pages.heading(entry.heading);
      if (model.tables[entry.table].rows.length) pages.table(model.tables[entry.table]);
      else pages.text("None.", 8.5, { color: REPORT_COLORS.muted });
    } else if ("chart" in entry) chart(entry.chart, true);
    else if ("charts" in entry) for (const id of entry.charts) chart(id, false);
    else if ("pair" in entry) {
      const specs = entry.pair.map((id) => model.charts.find((spec) => spec.id === id)).filter((spec) => spec !== undefined);
      const gap = 12;
      const width = (WIDTH - gap) / 2;
      const height = Math.max(...specs.map((spec) => width * (spec.height / spec.width)));
      pages.ensure(height + 34);
      let x = MARGIN.left;
      for (const item of entry.key) {
        const label = pdfSafe(item.name);
        pages.page.drawLine({ start: { x, y: pages.y - 6 }, end: { x: x + 14, y: pages.y - 6 }, thickness: 2, color: color(item.color), ...(item.dash ? { dashArray: [3, 2] } : {}) });
        pages.page.drawText(label, { x: x + 18, y: pages.y - 9, size: 8, font: regular, color: color(INK) });
        x += 18 + regular.widthOfTextAtSize(label, 8) + 14;
      }
      pages.y -= 18;
      specs.forEach((spec, index) => {
        const left = MARGIN.left + index * (width + gap);
        pages.page.drawText(pdfSafe(spec.title), { x: left, y: pages.y - 8.5, size: 8.5, font: bold, color: color(INK) });
        drawChartPdf(pages.page, spec, left, pages.y - 12, width, { regular, bold });
      });
      pages.y -= height + 16;
    }
    else {
      pages.heading(entry.heading);
      for (const line of model.notes) pages.text(`•  ${line}`, 8);
    }
  };

  model.pages.forEach((page, index) => {
    if (page.flow && index > 0 && pages.y - MARGIN.bottom > 260) pages.y -= 14;
    else pages.add();
    if (index === 0) {
      pages.text(model.title, 18, { bold: true });
      pages.text(model.subtitle, 10, { color: REPORT_COLORS.muted });
      const generated = pdfSafe(`Generated: ${model.generatedAtText}`);
      pages.page.drawText(pdfSafe(`Source: ${model.source}`), { x: MARGIN.left, y: pages.y - 9, size: 8.5, font: regular, color: color(INK) });
      pages.page.drawText(generated, { x: PAGE.width - MARGIN.right - regular.widthOfTextAtSize(generated, 8.5), y: pages.y - 9, size: 8.5, font: regular, color: color(INK) });
      pages.y -= 18;
      const badge = model.verdictStatus;
      const badgeWidth = bold.widthOfTextAtSize(badge, 9) + 12;
      pages.page.drawRectangle({ x: MARGIN.left, y: pages.y - 15, width: badgeWidth, height: 15, color: color(STATUS_COLOR[badge]) });
      pages.page.drawText(badge, { x: MARGIN.left + 6, y: pages.y - 11, size: 9, font: bold, color: rgb(1, 1, 1) });
      const verdictLines = wrap(model.verdict, bold, 10, WIDTH - badgeWidth - 8);
      verdictLines.forEach((line, lineIndex) => pages.page.drawText(line, { x: MARGIN.left + badgeWidth + 8, y: pages.y - 11 - lineIndex * 13, size: 10, font: bold, color: color(INK) }));
      pages.y -= Math.max(15, verdictLines.length * 13) + 8;
    } else {
      pages.text(page.title, 13, { bold: true });
      pages.y -= 2;
    }
    page.blocks.forEach(block);
  });

  const total = pages.all.length;
  const header = pdfSafe(`First Obs (UTC): ${model.firstObs}   Last Obs (UTC): ${model.lastObs}`);
  pages.all.forEach((page, index) => {
    page.drawText(header, { x: PAGE.width - MARGIN.right - regular.widthOfTextAtSize(header, 8.5), y: PAGE.height - 30, size: 8.5, font: regular, color: color(INK) });
    if (model.simulatedRf) page.drawText("MOCK-UP: RF lanes simulated", { x: MARGIN.left, y: PAGE.height - 30, size: 8.5, font: bold, color: color(REPORT_COLORS.simulation) });
    const footer = `Page ${index + 1} of ${total}`;
    page.drawText(footer, { x: PAGE.width - MARGIN.right - regular.widthOfTextAtSize(footer, 7.5), y: 24, size: 7.5, font: regular, color: color(REPORT_COLORS.muted) });
    page.drawText(pdfSafe(`${model.vesselName} · ${model.title} · RF data can show interference, not intent.`), { x: MARGIN.left, y: 24, size: 7.5, font: regular, color: color(REPORT_COLORS.muted) });
  });
  return doc.save({ useObjectStreams: true });
}
