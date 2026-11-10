import type { IncidentReportModel, ReportFact } from "./reportModel";
import { chartToSvg } from "./svgChart";
import { escapeHtml as e } from "./format";
import { REPORT_COLORS, REPORT_FONT_STACK } from "./theme";

const C = REPORT_COLORS;

export const REPORT_STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
html{background:#e7ecf0}
body{margin:0;color:${C.ink};font-family:${REPORT_FONT_STACK};font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.paper{max-width:900px;margin:24px auto;background:#fff;box-shadow:0 2px 18px rgba(11,35,64,.12)}
.cover{padding:36px 44px 30px;color:#fff;background:${C.navy}}
.cover-brand{display:flex;align-items:center;gap:16px;min-height:48px}
.cover-brand img{max-height:52px;max-width:200px;object-fit:contain;padding:6px;border-radius:4px;background:#fff}
.cover-brand strong{font-size:17px;letter-spacing:.01em}
.cover h1{margin:28px 0 4px;font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#c9d6e3}
.cover .verdict{margin:0;font-size:32px;line-height:1.15;font-weight:800}
.cover .ref{margin:8px 0 0;font-size:14px;color:#c9d6e3}
.cover-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 22px;margin:26px 0 0;padding:18px 0 0;border-top:1px solid rgba(255,255,255,.22)}
.cover-grid div{min-width:0}
.cover-grid dt{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9fb3c8}
.cover-grid dd{margin:2px 0 0;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.chip{display:inline-block;padding:3px 10px;border:1px solid rgba(255,255,255,.55);border-radius:999px;font-size:12px;font-weight:700}
.chip.medium{background:#1d7f45;border-color:#1d7f45}.chip.low{background:#a35f00;border-color:#a35f00}.chip.test{background:${C.simulation};border-color:${C.simulation}}
main{padding:12px 44px 36px}
section{padding-top:22px}
h2{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid ${C.navy};color:${C.navy};font-size:20px;line-height:1.25;break-after:avoid}
h2 span{color:${C.accent};font-size:15px}
h3{margin:18px 0 8px;color:${C.navy};font-size:15px;break-after:avoid}
p{margin:0 0 10px}
.lead{font-size:16px}
.facts{display:grid;grid-template-columns:minmax(150px,32%) 1fr;margin:0;border-top:1px solid ${C.rule}}
.facts dt,.facts dd{margin:0;padding:7px 10px;border-bottom:1px solid ${C.rule}}
.facts dt{color:${C.muted};font-weight:600;background:${C.panel}}
.facts dd{font-weight:600;overflow-wrap:anywhere}
.facts small{display:block;color:${C.muted};font-weight:400}
.callout{margin:14px 0;padding:12px 14px;border-left:4px solid ${C.accent};background:#eef5fc}
.callout.warn{border-color:${C.alertLevel};background:#fff6e5}
.callout strong{display:block;margin-bottom:4px}
.callout ul{margin:4px 0 0;padding-left:18px}
table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-size:14px}
th,td{padding:7px 10px;border-bottom:1px solid ${C.rule};text-align:left;vertical-align:top}
thead th{color:${C.muted};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:${C.panel}}
tbody tr:nth-child(even) td,tbody tr:nth-child(even) th{background:#fafbfc}
td.met{color:${C.anomaly};font-weight:700}
td.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
figure{margin:16px 0 22px;break-inside:avoid}
figure svg,figure img{display:block;width:100%;height:auto;border:1px solid ${C.rule}}
figcaption{margin-top:6px;color:${C.muted};font-size:13px;line-height:1.45}
figcaption strong{color:${C.ink}}
.timeline td:first-child{white-space:nowrap;color:${C.muted};font-size:13px}
.notes li{margin:0 0 8px;padding:8px 12px;border-left:3px solid ${C.accent};background:${C.panel};list-style:none;white-space:pre-wrap}
.notes{margin:0;padding:0}
.notes time{display:block;color:${C.muted};font-size:12px}
.muted{color:${C.muted}}
footer.report-footer{padding:16px 44px 26px;border-top:1px solid ${C.rule};color:${C.muted};font-size:12px}
.test-banner{padding:8px 44px;color:#fff;background:${C.simulation};font-weight:700;letter-spacing:.04em}
@page{size:A4;margin:14mm 13mm 16mm}
@media print{
  html{background:#fff}
  body{font-size:10.5pt}
  .paper{max-width:none;margin:0;box-shadow:none}
  .cover{min-height:auto;break-after:page;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .chip,.test-banner{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  main{padding:0 2mm}
  section{break-inside:auto}
  h2{break-after:avoid}
  table,figure,.callout{break-inside:avoid}
  a{color:inherit;text-decoration:none}
}
@media (max-width:720px){
  .cover,main,footer.report-footer{padding-left:18px;padding-right:18px}
  .cover-grid,.cols{grid-template-columns:1fr}
  .facts{grid-template-columns:1fr}
}
`;

function facts(rows: ReportFact[]): string {
  if (!rows.length) return "";
  return `<dl class="facts">${rows.map((row) => `<dt>${e(row.label)}</dt><dd>${e(row.value)}${row.note ? `<small>${e(row.note)}</small>` : ""}</dd>`).join("")}</dl>`;
}

function section(number: number, id: string, title: string, body: string): string {
  return `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title"><span>${number}</span>${e(title)}</h2>${body}</section>`;
}

/** Self-contained, print-ready HTML. Identical content to the PDF; opens without network access. */
export function renderIncidentReportHtml(model: IncidentReportModel): string {
  const identity = model.identity;
  const cover = [
    `<header class="cover" role="banner">`,
    `<div class="cover-brand">${identity.logo?.dataUri ? `<img src="${e(identity.logo.dataUri)}" alt="${e(identity.companyName ?? "Company")} logo">` : ""}<strong>${e(identity.companyName ?? identity.siteName)}</strong></div>`,
    `<h1>${e(model.title)}</h1>`,
    `<p class="verdict">${e(model.incident.verdict)}</p>`,
    `<p class="ref">${e(model.reference)} · ${e(model.incident.affected)}</p>`,
    `<div class="chips"><span class="chip">${e(model.incident.status)}</span><span class="chip ${model.incident.evidenceStrength.toLowerCase()}">${e(model.incident.evidenceStrength)} evidence</span>${model.incident.ruleLabel ? `<span class="chip">${e(model.incident.ruleLabel)}</span>` : ""}${model.dataDomain === "test" ? '<span class="chip test">Simulation / Test data</span>' : ""}</div>`,
    `<dl class="cover-grid">`,
    ...[
      identity.clientName ? ["Client", identity.clientName] : undefined,
      identity.vesselName ? ["Vessel or platform", identity.vesselName] : undefined,
      identity.projectReference ? ["Project", identity.projectReference] : undefined,
      ["Site", `${identity.siteName}${identity.deploymentId ? ` (${identity.deploymentId})` : ""}`],
      ["Started", model.incident.startedAt],
      [model.incident.endedAt ? "Ended" : "Status", model.incident.endedAt ?? model.incident.status],
      ["Disturbed frequencies", model.incident.disturbed],
      ["Report generated", model.generatedAtText],
      ["Record", model.scope === "evidence-package" ? "Evidence package" : "Live report"],
    ].filter((pair): pair is string[] => Boolean(pair)).map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`),
    `</dl></header>`,
    model.dataDomain === "test" ? `<div class="test-banner">SIMULATION / TEST DATA — not field evidence</div>` : "",
  ].join("");

  let figureNumber = 0;
  const figure = (chartId: string) => {
    const spec = model.charts.find((chart) => chart.id === chartId);
    if (!spec) return "";
    figureNumber += 1;
    return `<figure>${chartToSvg(spec, { idPrefix: `fig${figureNumber}` })}<figcaption><strong>Figure ${figureNumber}. ${e(spec.title)}.</strong> ${e(spec.caption)}</figcaption></figure>`;
  };

  const sections: string[] = [];
  let index = 0;
  sections.push(section(++index, "summary", "Summary", [
    `<p class="lead">${e(model.summary.paragraph)}</p>`,
    facts(model.summary.facts),
    `<div class="callout"><strong>What this report shows</strong><ul><li>When and where raised RF energy was recorded, and how it compared with the learned usual level.</li><li>Why the monitoring rules raised an alert, with the values in force at the time.</li><li>The recorded evidence and how to check that it has not changed.</li></ul></div>`,
    `<div class="callout warn"><strong>What it does not show</strong><ul>${model.limitations.slice(0, 3).map((line) => `<li>${e(line)}</li>`).join("")}</ul></div>`,
  ].join("")));

  if (model.why) {
    sections.push(section(++index, "why", "Why the alert was raised", [
      `<p class="lead">${e(model.why.sentence)}</p>`,
      `<table><thead><tr><th scope="col">Rule</th><th scope="col">Measured</th><th scope="col">Alert level</th><th scope="col">Met</th></tr></thead><tbody>${model.why.rules.map((rule) => `<tr><th scope="row">${e(rule.label)}</th><td>${e(rule.measured)}</td><td>${e(rule.threshold)}</td><td class="${rule.met ? "met" : ""}">${rule.met ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table>`,
      `<p class="muted">${e(model.why.persistence)}</p>`,
      `<div class="cols"><div><h3>Alert sensitivity: ${e(model.why.sensitivity.label)}</h3><p class="muted">${e(model.why.sensitivity.source)}</p>${facts(model.why.sensitivity.rules)}</div><div><h3>Reference used</h3>${facts(model.why.reference)}</div></div>`,
    ].join("")));
  } else {
    sections.push(section(++index, "why", "Why the alert was raised", `<p>${e(model.incident.observed)}</p><p class="muted">This record was made before trigger details were stored, so the exact values compared are not available.</p>`));
  }

  const evidenceFigures = ["trigger-snapshot", "spectrum-overview", "waterfall"].map(figure).join("");
  sections.push(section(++index, "recorded", "What the receiver recorded", evidenceFigures || `<p class="muted">No recorded frames were available to draw for this record.</p>`));

  sections.push(section(++index, "timeline", "Timeline", `<table class="timeline"><thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Detail</th></tr></thead><tbody>${model.timeline.map((row) => `<tr><td>${e(row.atText)}</td><th scope="row">${e(row.label)}</th><td>${e(row.detail ?? "")}</td></tr>`).join("")}</tbody></table>`));

  sections.push(section(++index, "analysis", "Analysis of the recorded frames", [
    `<ul>${model.findings.map((finding) => `<li>${e(finding)}</li>`).join("")}</ul>`,
    model.keyNumbers.length ? `<h3>Key numbers</h3>${facts(model.keyNumbers)}` : "",
    ["level-over-time", "excess-over-time", "strongest-frequency", "above-normal-by-frequency"].map(figure).join(""),
  ].join("")));

  sections.push(section(++index, "receiver", "Receiver and configuration", `${facts(model.receiver)}<h3>Software</h3>${facts(model.software)}`));

  sections.push(section(++index, "notes", "Operator notes", model.notes.length
    ? `<ul class="notes">${model.notes.map((note) => `<li><time>${e(note.atText)}</time>${e(note.text)}</li>`).join("")}</ul>`
    : `<p class="muted">No notes were added to this incident.</p>`));

  sections.push(section(++index, "integrity", "Evidence integrity", [
    ...model.integrity.statements.map((line) => `<p>${e(line)}</p>`),
    `<h3>Completeness</h3><ul>${model.completeness.statements.map((line) => `<li>${e(line)}</li>`).join("")}</ul>`,
    `<h3>How to check the files</h3><table><thead><tr><th scope="col">Computer</th><th scope="col">Command, run inside the extracted folder</th></tr></thead><tbody>${model.integrity.verify.map((row) => `<tr><th scope="row">${e(row.platform)}</th><td class="mono">${e(row.command)}</td></tr>`).join("")}</tbody></table>`,
    model.integrity.files.length ? `<h3>Key evidence files</h3><table><thead><tr><th scope="col">File</th><th scope="col">Size</th><th scope="col">SHA-256</th></tr></thead><tbody>${model.integrity.files.map((file) => `<tr><td class="mono">${e(file.path)}</td><td>${e(file.bytes.toLocaleString("en-GB"))} B</td><td class="mono">${e(file.sha256)}</td></tr>`).join("")}</tbody></table>` : "",
  ].join("")));

  sections.push(section(++index, "terms", "Limitations and terms", `<ul>${model.limitations.map((line) => `<li>${e(line)}</li>`).join("")}</ul><h3>Terms used</h3>${facts(model.glossary)}`));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="RF Monitor"><title>${e(model.title)} · ${e(model.reference)}</title><style>${REPORT_STYLE}</style></head><body><article class="paper">${cover}<main>${sections.join("")}</main><footer class="report-footer">${e(model.reference)} · generated ${e(model.generatedAtText)} · RF data can show interference, not intent. Relative, uncalibrated levels.</footer></article></body></html>`;
}
