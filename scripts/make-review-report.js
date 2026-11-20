"use strict";
// Builds a review workbook from a results workbook (the app's Responses and
// Evidence sheets). Works with the Render backup copy or a download from /admin.
//
//   node scripts/make-review-report.js [results.xlsx] [output.xlsx]
//
// Defaults: backup/render-results-latest.xlsx -> backup/AI Survey Review.xlsx
// Only active submissions are counted (Deleted and Superseded rows are left out).
// Decisions typed into the review file stay in that file; record final
// decisions on the admin page so they are saved with the results.

const path = require("path");
const ExcelJS = require("exceljs");
const bank = require("../data/questions.json");

const root = path.join(__dirname, "..");
const src = path.resolve(process.argv[2] || path.join(root, "backup", "render-results-latest.xlsx"));
const out = path.resolve(process.argv[3] || path.join(root, "backup", "AI Survey Review.xlsx"));

const DECISIONS = ["Accepted", "Needs more evidence", "Rejected"];
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const HEAD_FONT = { bold: true, color: { argb: "FFFFFFFF" } };

// Workbooks written through Graph keep a leading apostrophe on text that
// looks like a number or formula; drop it so values read cleanly.
const clean = v => {
  if (v && typeof v === "object") v = v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join("") : "");
  if (typeof v === "string" && v.startsWith("'")) v = v.slice(1);
  return v ?? "";
};
const num = v => { const n = Number(clean(v)); return Number.isFinite(n) ? n : 0; };

function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Sheet "${name}" not found in ${src}. Is this a results workbook?`);
  const head = ws.getRow(1).values.map(clean);
  const rows = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const o = {};
    head.forEach((h, c) => { if (h) o[h] = clean(row.getCell(c).value); });
    if (Object.values(o).some(v => v !== "")) rows.push(o);
  });
  return rows;
}

function table(ws, columns, rows, { widths = {}, wrap = [] } = {}) {
  ws.columns = columns.map(c => ({ header: c, key: c, width: widths[c] || Math.max(12, c.length + 2) }));
  rows.forEach(r => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = HEAD_FONT; head.fill = HEAD_FILL; head.alignment = { vertical: "middle", wrapText: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  wrap.forEach(c => { ws.getColumn(c).alignment = { wrapText: true, vertical: "top" }; });
}

function section(ws, title) {
  if (ws.rowCount) ws.addRow([]);
  const r = ws.addRow([title]);
  r.font = { bold: true, size: 13, color: { argb: "FF1F3864" } };
}

function headerRow(ws, cells) {
  const r = ws.addRow(cells);
  r.eachCell(c => { c.font = HEAD_FONT; c.fill = HEAD_FILL; });
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(src);
  const responses = readSheet(wb, "Responses");
  const evidence = readSheet(wb, "Evidence");

  // Group departments that differ only in case, spacing or trailing
  // punctuation ("Central Function." = "central  function"). Names from the
  // department list win; otherwise the first spelling seen is used.
  const deptKey = d => String(d).toLowerCase().replace(/[\s.,;:\-_]+$/g, "").replace(/\s+/g, " ").trim();
  const canon = new Map((bank.departments || []).map(d => [deptKey(d), d]));
  responses.forEach(r => {
    const k = deptKey(r.Department || "");
    if (!k) return;
    if (!canon.has(k)) canon.set(k, String(r.Department).trim().replace(/[\s.,;:\-_]+$/g, ""));
    r.Department = canon.get(k);
  });
  evidence.forEach(e => { const k = deptKey(e.Department || ""); if (canon.has(k)) e.Department = canon.get(k); });

  const active = responses.filter(r => !["Deleted", "Superseded"].includes(r.Status));
  const activeIds = new Set(active.map(r => r["Submission ID"]));
  const ev = evidence.filter(e => activeIds.has(e["Submission ID"]));
  const pending = ev.filter(e => !e["Reviewer decision"]);
  const levelName = Object.fromEntries(bank.levels.map(l => [l.level, l.name]));
  const avg = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10 : "";
  const pct = (n, d) => d ? n / d : 0;

  const rep = new ExcelJS.Workbook();
  rep.creator = "AI adoption survey";

  // ---- Summary
  const sum = rep.addWorksheet("Summary");
  sum.columns = [{ width: 34 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  const t = sum.addRow(["AI adoption check-in: review report"]);
  t.font = { bold: true, size: 16, color: { argb: "FF1F3864" } };
  const cycles = [...new Set(active.map(r => r.Cycle).filter(Boolean))].join(", ") || "-";
  [["Generated", new Date().toLocaleString()], ["Source file", src], ["Cycle", cycles],
   ["Submissions (active)", active.length], ["Removed (deleted or superseded)", responses.length - active.length],
   ["Average score %", avg(active.map(r => num(r["Score %"])))], ["Average level", avg(active.map(r => num(r["Current level"])))],
   ["Evidence examples", ev.length], ["Examples awaiting review", pending.length]]
    .forEach(([k, v]) => { const r = sum.addRow([k, v]); r.getCell(1).font = { bold: true }; });

  section(sum, "Level distribution");
  headerRow(sum, ["Level", "People", "Share"]);
  bank.levels.forEach(l => {
    const n = active.filter(r => num(r["Current level"]) === l.level).length;
    const r = sum.addRow([`${l.level} ${l.name}`, n, pct(n, active.length)]);
    r.getCell(3).numFmt = "0%";
  });

  const groupBy = (key, title) => {
    section(sum, title);
    headerRow(sum, [key, "People", "Avg level", "Avg score %", ...bank.levels.map(l => `L${l.level}`)]);
    const groups = [...new Set(active.map(r => r[key] || "(blank)"))].sort();
    groups.forEach(g => {
      const rs = active.filter(r => (r[key] || "(blank)") === g);
      sum.addRow([g, rs.length, avg(rs.map(r => num(r["Current level"]))), avg(rs.map(r => num(r["Score %"]))),
        ...bank.levels.map(l => rs.filter(r => num(r["Current level"]) === l.level).length)]);
    });
    if (!groups.length) sum.addRow(["No submissions yet"]);
  };
  groupBy("Department", "By department");
  groupBy("Role", "By role questionnaire");

  section(sum, "Evidence review status");
  headerRow(sum, ["Status", "Examples"]);
  [["Awaiting review", pending.length], ...DECISIONS.map(d => [d, ev.filter(e => e["Reviewer decision"] === d).length])]
    .forEach(r => sum.addRow(r));
  section(sum, "AI rating of examples (a guide for reviewers, not a decision)");
  headerRow(sum, ["AI rating", "Examples"]);
  const ratings = [...new Set(ev.map(e => e["AI rating"] || "Not assessed"))].sort();
  ratings.forEach(x => sum.addRow([x, ev.filter(e => (e["AI rating"] || "Not assessed") === x).length]));
  if (!ratings.length) sum.addRow(["No examples yet"]);

  // ---- People
  const people = active
    .map(r => ({ ...r, "Level name": r["Level name"] || levelName[num(r["Current level"])] || "" }))
    .sort((a, b) => String(a.Department).localeCompare(String(b.Department)) || String(a.Name).localeCompare(String(b.Name)));
  table(rep.addWorksheet("People"),
    ["Employee ID", "Name", "Email", "Department", "Team role", "Role", "Current level", "Level name", "Score %",
     "Provisional tier", "Examples", "Examples accepted", "Examples to review", "Submitted at (UTC)", "Submission ID"],
    people.map(r => ({ ...r, "Employee ID": String(r["Respondent ID (Employee ID)"] ?? "") })),
    { widths: { Name: 24, Email: 30, Department: 18, "Team role": 22, Role: 22, "Submitted at (UTC)": 22 } });

  // ---- Review queue
  const qws = rep.addWorksheet("Review queue");
  const qcols = ["Submission ID", "Name", "Department", "Questionnaire", "Question ID", "Level", "Use case", "Answer",
    "Example", "Follow-up question", "Follow-up answer", "Link", "AI rating", "AI summary", "AI reason",
    "Reviewer decision", "Reviewer notes"];
  table(qws, qcols, pending.sort((a, b) => num(b.Level) - num(a.Level)), {
    widths: { Name: 22, "Use case": 30, Example: 60, "Follow-up question": 36, "Follow-up answer": 50, "AI summary": 40,
      "AI reason": 36, "Reviewer decision": 20, "Reviewer notes": 36, Link: 30 },
    wrap: ["Use case", "Example", "Follow-up question", "Follow-up answer", "AI summary", "AI reason", "Reviewer notes"]
  });
  const dcol = qcols.indexOf("Reviewer decision") + 1;
  for (let r = 2; r <= pending.length + 1; r++) {
    qws.getRow(r).getCell(dcol).dataValidation = { type: "list", allowBlank: true, formulae: [`"${DECISIONS.join(",")}"`] };
  }

  // ---- All evidence (including reviewed)
  table(rep.addWorksheet("All evidence"),
    ["Submission ID", "Name", "Department", "Question ID", "Level", "Use case", "Answer", "Example", "AI rating",
     "Reviewer decision", "Reviewer notes", "Reviewed by", "Reviewed on (UTC)"],
    ev, { widths: { Name: 22, "Use case": 30, Example: 60, "Reviewer notes": 36 }, wrap: ["Use case", "Example", "Reviewer notes"] });

  await rep.xlsx.writeFile(out);
  console.log(`Review report: ${out}`);
  console.log(`  ${active.length} submission(s), ${ev.length} example(s), ${pending.length} awaiting review`);
}

main().catch(e => {
  console.error(e.code === "ENOENT" || /File not found/.test(e.message) ? `Results file not found: ${src}` : e.message);
  process.exit(1);
});
