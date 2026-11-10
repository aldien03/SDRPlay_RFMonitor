import { chartToSvg } from "../report/svgChart";
import { escapeHtml as e } from "../report/format";
import { REPORT_COLORS as C, REPORT_FONT_STACK } from "../report/theme";
import type { PositioningReportModel, ReportBlock, ReportTable, Status } from "./reportModel";

const STATUS_COLOR: Record<Status, string> = { PASS: "#1d7f45", FAIL: "#c8102e", ALERT: "#c8102e", CHECK: "#a35f00", INFO: "#4a5b6b" };

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
html{background:#e9edf1}
body{margin:0;color:#111;font-family:${REPORT_FONT_STACK};font-size:13px;line-height:1.4;font-variant-numeric:tabular-nums}
.page{max-width:900px;margin:18px auto;padding:22px 32px 26px;background:#fff;box-shadow:0 1px 10px rgba(11,35,64,.12)}
.obs{display:flex;justify-content:space-between;gap:12px;font-size:12px;margin-bottom:10px}
.obs .sim{color:${C.simulation};font-weight:700}
h1{margin:0;font-size:24px;line-height:1.2}
.sub{margin:2px 0 8px;color:${C.muted}}
.meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 16px;font-size:12px;margin-bottom:10px}
.verdict{display:flex;align-items:center;gap:10px;margin:6px 0 4px;font-weight:700;font-size:14px}
.badge{display:inline-block;padding:2px 8px;color:#fff;font-size:12px;font-weight:700;letter-spacing:.03em}
h2{margin:0 0 8px;font-size:17px}
h3{margin:14px 0 5px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:12px;margin:0 0 6px}
th,td{border:1px solid #9aa5b1;padding:3px 6px;text-align:left;vertical-align:top}
thead th{background:#d6e6f5;font-weight:700}
td.r,th.r{text-align:right;white-space:nowrap}td.c,th.c{text-align:center}
td.status{font-weight:700;text-align:center}
.chart{margin:8px 0}
.chart h4{margin:0 0 2px;font-size:12px}
.chart svg{display:block;width:100%;height:auto}
.stack svg{display:block;width:100%;height:auto;margin-bottom:2px}
.notes{margin:4px 0 0;padding-left:18px;font-size:12px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.key{display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0;font-size:12px}
.key span{display:inline-flex;align-items:center;gap:6px}
.key i{display:inline-block;width:16px;border-top:2px solid}
@media (max-width:640px){.pair{grid-template-columns:1fr}}
.wrap{overflow-x:auto}
footer{max-width:900px;margin:0 auto 24px;color:${C.muted};font-size:11px;text-align:center}
@media print{html{background:#fff}.page{box-shadow:none;margin:0;max-width:none;break-after:page;padding:0}.badge,thead th,td.status{-webkit-print-color-adjust:exact;print-color-adjust:exact}footer{display:none}}
@media (max-width:640px){.page{padding:16px}h1{font-size:20px}}
`;

function table(model: ReportTable): string {
  if (!model.rows.length) return `<p class="sub">None.</p>`;
  const cls = (align?: string) => (align === "right" ? ' class="r"' : align === "center" ? ' class="c"' : "");
  const body = model.rows
    .map((row) => `<tr>${row.map((cell, index) => (index === model.statusColumn ? `<td class="status" style="color:${STATUS_COLOR[cell as Status] ?? "#111"}">${e(cell)}</td>` : `<td${cls(model.columns[index]?.align)}>${e(cell)}</td>`)).join("")}</tr>`)
    .join("");
  return `<div class="wrap"><table><thead><tr>${model.columns.map((column) => `<th scope="col"${cls(column.align)}>${e(column.title)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderPositioningReportHtml(model: PositioningReportModel): string {
  const chart = (id: string, withTitle: boolean) => {
    const spec = model.charts.find((entry) => entry.id === id);
    return spec ? `<div class="chart">${withTitle ? `<h4>${e(spec.title)}</h4>` : ""}${chartToSvg(spec, { idPrefix: id })}</div>` : "";
  };
  const block = (entry: ReportBlock) => {
    if ("table" in entry) return `${entry.heading ? `<h3>${e(entry.heading)}</h3>` : ""}${table(model.tables[entry.table])}`;
    if ("chart" in entry) return chart(entry.chart, true);
    if ("charts" in entry) return `<div class="stack">${entry.charts.map((id) => chart(id, /^(rf|rel)-/.test(id))).join("")}</div>`;
    if ("pair" in entry) return `<div class="key">${entry.key.map((item) => `<span><i style="border-top-color:${item.color};border-top-style:${item.dash ? "dashed" : "solid"}"></i>${e(item.name)}</span>`).join("")}</div><div class="pair">${entry.pair.map((id) => chart(id, true)).join("")}</div>`;
    return `<h3>${e(entry.heading)}</h3><ul class="notes">${model.notes.map((line) => `<li>${e(line)}</li>`).join("")}</ul>`;
  };
  const obs = `<div class="obs"><span class="sim">${model.simulatedRf ? "MOCK-UP: RF lanes simulated" : ""}</span><span>First Obs (UTC): ${e(model.firstObs)} &nbsp; Last Obs (UTC): ${e(model.lastObs)}</span></div>`;
  const pages = model.pages.map((page, index) => {
    const head = index === 0
      ? `<h1>${e(model.title)}</h1><p class="sub">${e(model.subtitle)}</p><div class="meta"><span>Source: ${e(model.source)}</span><span>Generated: ${e(model.generatedAtText)}</span></div><div class="verdict"><span class="badge" style="background:${STATUS_COLOR[model.verdictStatus]}">${e(model.verdictStatus)}</span><span>${e(model.verdict)}</span></div>`
      : `<h2>${e(page.title)}</h2>`;
    return `<section class="page">${obs}${head}${page.blocks.map(block).join("")}</section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="RF Monitor"><title>${e(model.title)} · ${e(model.source)}</title><style>${STYLE}</style></head><body>${pages.join("")}<footer>${e(model.vesselName)} · ${e(model.title)} · RF data can show interference, not intent.</footer></body></html>`;
}
