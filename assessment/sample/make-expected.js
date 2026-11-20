"use strict";
// Writes assessment/sample/EXPECTED.md from a reference run of both sample cycles.
//   node assessment/sample/make-expected.js <cycle-1 report.xlsx> <cycle-2 report.xlsx>
// (the reports come from running report.js with reference-judgements.json).

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const NOTE = {
  SMP001: "No access yet (Level 0)", SMP002: "Has access; only 1 of 3 simple tasks",
  SMP003: "Level 5 claim with a chat-only example: lower-level use, Does not meet",
  SMP004: "Weekly on core tasks; 2 of 6 complex", SMP005: "One proven Level 5 practice; second example misses \"checked\" and \"regularly\"",
  SMP006: "3 proven Level 5; 1 of 4 Level 6; one example missing \"checked\"",
  SMP007: "4 proven Level 5, 2 proven Level 6; E answer without a team standard",
  SMP008: "Level 7 proven twice; two lower examples miss points; one 10-word example rejected by the quality filter",
  SMP009: "Placeholder text rejected by the quality filter",
  SMP010: "Same vague sentence for 13 questions: claims Level 7, confirmed Level 4; flags",
  SMP011: "Proven Level 5 but Level 3 not reached: ladder jump flag",
  SMP012: "Central Function on the Delivery/Project Manager questions",
  SMP014: "Level 6 prompt pack missing \"who uses it\"",
  SMP015: "Saved chat project only drafts text (not \"AI did the steps\"); Level 7 redesign missing a measured result"
};

async function rows(file, sheet) {
  const w = new ExcelJS.Workbook(); await w.xlsx.readFile(file);
  const ws = w.getWorksheet(sheet), h = ws.getRow(1).values, out = [];
  ws.eachRow((r, i) => { if (i > 1) { const o = {}; h.forEach((k, j) => { if (k) o[k] = r.values[j]; }); out.push(o); } });
  return out;
}

(async () => {
  const [c1, c2] = process.argv.slice(2);
  const ind = await rows(c1, "Individuals"), tr = await rows(c2, "Trend people"), sum = await rows(c1, "Individuals");
  const ev = (await rows(c1, "Evidence")).reduce((a, r) => { a[r.Decision] = (a[r.Decision] || 0) + 1; return a; }, {});
  let md = `# Expected results for the sample data\n\nAll people are made up and named after their team role. Use this to check an assessment run on \`backup/sample_data.xlsx\` (cycle "Sample cycle") and \`backup/sample_data_cycle2.xlsx\` (cycle "Sample cycle 2"). Confirmed levels assume judgements that match \`reference-judgements.json\`; \`compare.js\` shows where a run differs.\n\nThe sample covers all 24 team roles and all 6 role questionnaires. \`TEST - QA Engineer\` must be left out as a test entry.\n\n## Sample cycle\n\n| Employee ID | Name | Team role | Confirmed level | Score | Level from answers | Examples meet / need more / do not meet | Flags | What it tests |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const r of ind) md += `| ${r["Employee ID"]} | ${r.Name} | ${r["Team role"]} | ${r["Confirmed level"]} ${r["Level name"]} | ${r.Score} | ${r["Level from answers"]} | ${r["Examples meet"]} / ${r["Examples need more"]} / ${r["Examples do not meet"]} | ${r.Flags || ""} | ${NOTE[r["Employee ID"]] || `Level ${r["Confirmed level"]} profile`} |\n`;
  const lv = {}; sum.forEach(r => { lv[r["Confirmed level"]] = (lv[r["Confirmed level"]] || 0) + 1; });
  md += `\nLevel spread: ${[0, 1, 2, 3, 4, 5, 6, 7].map(l => `Level ${l}: ${lv[l] || 0}`).join(" · ")}. Examples: Meets ${ev.Meets || 0}, Needs more evidence ${ev["Needs more evidence"] || 0}, Does not meet ${ev["Does not meet"] || 0} (3 of them by the quality filter).\n\n## Sample cycle 2 (trend)\n\nExpected: ${["Up", "Same", "Down", "New", "Not in this cycle"].map(s => `${s.toLowerCase()} ${tr.filter(r => r.Status === s).length}`).join(", ")}.\n\n| Employee ID | Name | Sample cycle | Sample cycle 2 | Status |\n| --- | --- | --- | --- | --- |\n`;
  for (const r of tr.filter(r => r.Status !== "Same")) md += `| ${r["Employee ID"]} | ${r.Name} | ${r["Level Sample cycle"] ?? ""} | ${r["Level Sample cycle 2"] ?? ""} | ${r.Status} |\n`;
  fs.writeFileSync(path.join(__dirname, "EXPECTED.md"), md);
  console.log("Wrote", path.join(__dirname, "EXPECTED.md"));
})().catch(e => { console.error(e.message); process.exit(1); });
