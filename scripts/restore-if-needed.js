"use strict";
// Called by backup-from-render.sh on every download. If submissions that were
// in the previous download are missing now, Render restarted and lost its
// results file: send the previous copy back so Render can merge it with
// anything submitted since the restart.
//
//   node scripts/restore-if-needed.js <new download.xlsx> <previous copy.xlsx>
//
// Exit codes: 0 nothing to do, 10 restored (do not keep this download), 1 error.
// Needs RESULTS_TOKEN (environment or assessment/auto/results-token.txt) and RENDER_URL.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const [fresh, prev] = process.argv.slice(2);
const ROOT = path.join(__dirname, "..");
const url = (process.env.RENDER_URL || "https://tech-adoption.onrender.com").replace(/\/$/, "");

async function ids(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet("Responses");
  if (!ws) return new Set();
  const h = ws.getRow(1).values.map(v => String(v ?? ""));
  const col = h.indexOf("Submission ID");
  const out = new Set();
  ws.eachRow((r, i) => { if (i > 1 && col > 0) { const v = String(r.getCell(col).value ?? "").replace(/^'/, ""); if (v) out.add(v); } });
  return out;
}

(async () => {
  if (!prev || !fs.existsSync(prev)) process.exit(0);
  const now = await ids(fresh), before = await ids(prev);
  // Check-ins the surveyor deleted on purpose (scripts/purge-submissions.js) are not restored.
  let deleted = new Set();
  try { deleted = new Set(fs.readFileSync(path.join(path.dirname(prev), "deleted-submissions.txt"), "utf8").split(/\s+/).filter(Boolean)); } catch (_) {}
  const missing = [...before].filter(id => !now.has(id) && !deleted.has(id));
  if (!missing.length) process.exit(0);
  let token = process.env.RESULTS_TOKEN || "";
  if (!token) { try { token = fs.readFileSync(path.join(ROOT, "assessment", "auto", "results-token.txt"), "utf8").trim(); } catch (_) {} }
  if (!token) { console.log(`RESTORE needed (${missing.length} submissions missing on Render) but no RESULTS_TOKEN`); process.exit(1); }
  const r = await fetch(`${url}/api/results/restore-workbook`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: fs.readFileSync(prev), signal: AbortSignal.timeout(120000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.log(`RESTORE failed: HTTP ${r.status} ${j.message || ""}`); process.exit(1); }
  console.log(`RESTORED ${missing.length} missing submissions from the backup (Render now has ${j.responses} responses; ${j.added} rows kept from after the restart)`);
  process.exit(10);
})().catch(e => { console.log(`RESTORE error: ${e.message}`); process.exit(1); });
