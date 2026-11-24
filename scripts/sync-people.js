"use strict";
// Sends the employee list (standard master sheet) to the survey, when the
// survey does not have this exact list yet: after a Render restart, a deploy,
// or an edit to the sheet. Called by backup-from-render.sh on every run.
//
//   node scripts/sync-people.js [--check]
//
//   PEOPLE_XLSX  the standard sheet (default ../mis-dashboard/docs/ACSII_Employee_Master_Standard.xlsx)
//   RENDER_URL   survey address (default https://tech-adoption.onrender.com)
//   RESULTS_TOKEN or assessment/auto/results-token.txt
//
// --check only reads the sheet and lists anyone whose role has no questionnaire.
// Exit codes: 0 up to date or sent, 1 error.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "..");
const XLSX = process.env.PEOPLE_XLSX || path.join(ROOT, "..", "mis-dashboard", "docs", "ACSII_Employee_Master_Standard.xlsx");
const url = (process.env.RENDER_URL || "https://tech-adoption.onrender.com").replace(/\/$/, "");
const cellText = v => (v && typeof v === "object" ? (v.text || v.result || (v.richText || []).map(t => t.text).join("") || "") : String(v ?? "")).trim();

async function readSheet() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet("Employees");
  if (!ws) throw new Error(`no "Employees" tab in ${XLSX}`);
  const h = ws.getRow(1).values.map(cellText);
  const col = name => { const i = h.indexOf(name); if (i < 1) throw new Error(`column "${name}" missing in ${XLSX}`); return i; };
  const c = { empId: col("Employee ID"), name: col("Full Name"), email: col("Work Email"), role: col("Role") };
  const rows = [];
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const p = Object.fromEntries(Object.entries(c).map(([k, j]) => [k, cellText(r.getCell(j).value)]));
    if (p.name || p.email) rows.push(p);
  });
  return rows;
}

(async () => {
  const rows = await readSheet();
  // Personal check-in codes (scripts/checkin-codes.js): only a salted fingerprint is sent,
  // and only once codes are switched on (node scripts/checkin-codes.js --on), so the survey
  // asks for them only after people have received them.
  let codes = {};
  const codesOn = process.env.CODES_ON === "1" || fs.existsSync(path.join(ROOT, "backup", "checkin-codes.ON"));   // CODES_ON=1: local tests only
  if (codesOn) try { codes = JSON.parse(fs.readFileSync(process.env.CODES_FILE || path.join(ROOT, "backup", "checkin-codes.json"), "utf8")); } catch (_) {}
  const norm = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const p of rows) {
    const c = codes[String(p.email).toLowerCase()];
    if (c && c.code && c.salt) { p.codeSalt = c.salt; p.codeHash = crypto.createHash("sha256").update(`${c.salt}:${norm(c.code)}`).digest("hex"); }
  }
  if (process.argv.includes("--check")) {
    const bank = require(path.join(ROOT, "data", "questions.json"));
    const qs = {};
    for (const p of rows) {
      const team = (bank.roleAliases || {})[p.role] || p.role, m = bank.roleMap.find(x => x.teamRole === team);
      const k = m ? `${m.questionnaire} (${bank.questionnaires[m.questionnaire].name})` : "NO QUESTIONNAIRE";
      qs[k] = (qs[k] || 0) + 1;
      if (!m) console.log(`  no questionnaire for role "${p.role}": ${p.name}`);
    }
    console.log(`${rows.length} people, ${rows.filter(p => !p.empId).length} without an Employee ID, ${rows.filter(p => p.codeHash).length} with a check-in code`);
    for (const [k, n] of Object.entries(qs)) console.log(`  ${k}: ${n}`);
    return;
  }
  let token = process.env.RESULTS_TOKEN || "";
  if (!token) { try { token = fs.readFileSync(path.join(ROOT, "assessment", "auto", "results-token.txt"), "utf8").trim(); } catch (_) {} }
  if (!token) { console.log("PEOPLE no RESULTS_TOKEN"); process.exit(1); }
  const auth = { Authorization: `Bearer ${token}` };
  const hash = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const st = await fetch(`${url}/api/people/status`, { headers: auth });
  if (st.status === 404) { console.log("PEOPLE skipped: the survey does not have the employee list feature yet"); return; }
  if (!st.ok) { console.log(`PEOPLE status check failed (HTTP ${st.status})`); process.exit(1); }
  const cur = await st.json();
  if (cur.hash === hash) { process.exitCode = 0; return; }
  const r = await fetch(`${url}/api/people/upload`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ people: rows }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.log(`PEOPLE upload failed (HTTP ${r.status}): ${j.message || ""}`); process.exit(1); }
  console.log(`PEOPLE sent ${j.count} people (${rows.filter(p => p.codeHash).length} with a check-in code)${j.problems && j.problems.length ? `; not loaded: ${j.problems.join("; ")}` : ""}`);
})().catch(e => { console.log(`PEOPLE error: ${e.message}`); process.exit(1); });
