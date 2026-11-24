"use strict";
// Permanently deletes check-ins that are already Inactive or Test: on the
// survey (all tabs and the report) and in the local job files, so the backup
// and assessment jobs do not bring them back.
//
//   node scripts/purge-submissions.js S-XXXXXXXX [S-YYYYYYYY ...]
//
// Order: the IDs go into backup/deleted-submissions.txt first (the backup job
// then never restores them), then the survey deletes them, then the job's saved
// reports and records go. Older timestamped backup copies are left as they are.
// Needs RESULTS_TOKEN (environment or assessment/auto/results-token.txt) and RENDER_URL.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const url = (process.env.RENDER_URL || "https://tech-adoption.onrender.com").replace(/\/$/, "");
const ids = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
if (!ids.length || ids.some(id => !/^S-[A-Z0-9]{6,12}$/.test(id))) { console.log("usage: node scripts/purge-submissions.js S-XXXXXXXX ..."); process.exit(1); }

(async () => {
  let token = process.env.RESULTS_TOKEN || "";
  if (!token) { try { token = fs.readFileSync(path.join(ROOT, "assessment", "auto", "results-token.txt"), "utf8").trim(); } catch (_) {} }
  if (!token) { console.log("no RESULTS_TOKEN"); process.exit(1); }

  const list = path.join(ROOT, "backup", "deleted-submissions.txt");
  const had = fs.existsSync(list) ? fs.readFileSync(list, "utf8").split(/\s+/).filter(Boolean) : [];
  fs.writeFileSync(list, [...new Set([...had, ...ids])].join("\n") + "\n", { mode: 0o600 });

  const r = await fetch(`${url}/api/results/purge`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ submissionIds: ids }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    fs.writeFileSync(list, had.length ? had.join("\n") + "\n" : "", { mode: 0o600 });   // nothing deleted: undo the list
    console.log(`not deleted (HTTP ${r.status}): ${j.message || ""}`); process.exit(1);
  }
  console.log(`deleted on the survey: ${Object.entries(j.removed).map(([t, n]) => `${t} ${n}`).join(", ")}`);

  let files = 0;
  const reports = path.join(ROOT, "assessment", "auto", "reports");
  for (const id of ids) for (const ext of [".html", ".json"]) { const f = path.join(reports, id + ext); if (fs.existsSync(f)) { fs.unlinkSync(f); files++; } }
  const statePath = path.join(ROOT, "assessment", "auto", "state.json");
  let entries = 0;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const cycle of Object.values(state)) for (const [k, v] of Object.entries(cycle || {})) if (v && ids.includes(v.submissionId)) { delete cycle[k]; entries++; }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (_) {}
  console.log(`local: ${files} saved report files and ${entries} job records removed; ${ids.length} IDs listed in backup/deleted-submissions.txt`);
})().catch(e => { console.log(`error: ${e.message}`); process.exit(1); });
