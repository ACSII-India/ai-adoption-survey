"use strict";
// Automatic per-submission assessment. Run every 15 minutes by a timer
// (scripts/systemd/ai-survey-auto.*). For each person who submitted since the
// last run it:
//   1. assesses only them with the standard engine (prepare.js, Claude Code
//      headless judges their Level 5-7 examples with the ai-assessment skill,
//      report.js scores them and builds the report);
//   2. puts the confirmed report on the survey page, where the person sees
//      "Your report is ready" with a PDF to download. No email is sent.
//
//   node assessment/auto/run-auto.js [--dry-run] [--in <results file>]
//
// State (who has been handled) is in assessment/auto/state.json. Log: assessment/auto/auto.log.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadResults } = require("../lib.js");

const ROOT = path.join(__dirname, "..", "..");
const HERE = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
if (process.env.SURVEY_URL) cfg.surveyUrl = process.env.SURVEY_URL; // e.g. a local copy for testing
// Run for specific people without putting their addresses in config.json (which is in git):
//   ONLY_EMAILS="a@x.org,b@x.org" assessment/auto/run-auto.sh
if (process.env.ONLY_EMAILS) cfg.onlyEmails = process.env.ONLY_EMAILS.split(/[,;\s]+/).filter(Boolean);
const STATE = path.join(HERE, "state.json");
const LOG = path.join(HERE, "auto.log");
const dryRun = process.argv.includes("--dry-run");
const inArg = process.argv.indexOf("--in") >= 0 ? process.argv[process.argv.indexOf("--in") + 1] : null; // test with another results file

const log = m => { const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${m}`; console.log(line); fs.appendFileSync(LOG, line + "\n"); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const node = process.execPath;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(-600)}`);
  return r.stdout;
}

function claudeBin() {
  if (cfg.claudePath) return cfg.claudePath;
  const next = path.join(path.dirname(node), "claude");
  if (fs.existsSync(next)) return next;
  const w = spawnSync("which", ["claude"], { encoding: "utf8" });
  return w.status === 0 ? w.stdout.trim() : null;
}

// ---------- confirmed reports back to the survey page ----------
// The survey keeps reports in a temp file, which Render's Free plan loses on
// restart. Copies are kept in assessment/auto/reports/ and uploaded again
// whenever the survey says it does not have them.
const REPORTS = path.join(HERE, "reports");
function surveyToken() {
  if (process.env.RESULTS_TOKEN) return process.env.RESULTS_TOKEN;
  try { return fs.readFileSync(path.join(HERE, "results-token.txt"), "utf8").trim(); } catch (_) { return ""; }
}
async function surveyCall(method, route, body) {
  const r = await fetch(`${cfg.surveyUrl.replace(/\/$/, "")}${route}`, {
    method, headers: { Authorization: `Bearer ${surveyToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
  return r.json();
}
async function syncReports() {
  if (!cfg.uploadReports || !cfg.surveyUrl) return;
  if (!surveyToken()) { log("REPORTS skipped: no RESULTS_TOKEN (set it here and on Render)"); return; }
  if (!fs.existsSync(REPORTS)) return;
  const have = new Set((await surveyCall("GET", "/api/results/ready")).ready);
  const local = fs.readdirSync(REPORTS).filter(f => f.endsWith(".html"));
  let sent = 0;
  for (const f of local) {
    const id = f.replace(/\.html$/, "");
    if (have.has(id)) continue;
    // Resend the report and, when kept, its Assessment rows (the workbook may be new after a restart).
    const kept = readJson(path.join(REPORTS, `${id}.json`), null);
    await surveyCall("POST", "/api/results/upload", kept || { submissionId: id, html: fs.readFileSync(path.join(REPORTS, f), "utf8") });
    sent++;
  }
  if (sent) log(`REPORTS uploaded ${sent} to the survey (${local.length} kept here)`);
}

async function main() {
  const state = readJson(STATE, {});

  const results = path.resolve(ROOT, inArg || cfg.resultsFile);
  if (!fs.existsSync(results)) { log(`SKIP no results file at ${results}`); return fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); }
  const loaded = await loadResults(results);
  const allow = (cfg.onlyEmails || []).map(e => e.toLowerCase());
  const people = allow.length ? loaded.people.filter(p => allow.includes(p.email.toLowerCase())) : loaded.people;
  const { cycle } = loaded;
  const seen = (state[cycle] = state[cycle] || {});
  // New = not handled in this cycle yet, or resubmitted (new submission ID).
  const fresh = people.filter(p => !seen[p.empId] || seen[p.empId].submissionId !== p.submissionId).slice(0, cfg.maxPeoplePerRun);
  if (!fresh.length) { log(`OK no new submissions (${people.length} in ${cycle || "no cycle yet"})`); fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); await syncReports(); return; }
  const ids = fresh.map(p => p.empId);
  log(`NEW ${fresh.length}: ${ids.join(", ")}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return;

  const out = path.join(ROOT, "assessment", "out-auto", new Date().toISOString().replace(/[:.]/g, "-"));
  run(node, ["assessment/prepare.js", "--in", results, "--out", out, "--only", ids.join(",")]);
  const batches = fs.readdirSync(path.join(out, "batches")).filter(f => f.endsWith(".json"));

  if (batches.length) {
    const claude = claudeBin();
    if (!claude) throw new Error("Claude Code not found; set claudePath in assessment/auto/config.json");
    const rel = path.relative(ROOT, out);
    const prompt = [
      "Use the ai-assessment skill (.claude/skills/ai-assessment/SKILL.md), step 3 only, with assessment/RUBRIC.md Part B including B5.",
      `Judge every item in ${rel}/batches/*.json and write each result file to ${rel}/judgements/<same batch name>.json exactly as step 3 describes.`,
      `Then run: node assessment/report.js --in ${path.relative(ROOT, results)} --out ${rel} --only ${ids.join(",")} --check`,
      "and fix the judgement files until it reports that the judgements are valid. Do not run any other step, do not send email, and do not change any other file."
    ].join("\n");
    log(`JUDGE ${batches.length} batch(es) with Claude Code`);
    const r = spawnSync(claude, ["-p", prompt, "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep",
      `Bash(node assessment/report.js:*)`, "--max-turns", "60"],
      { cwd: ROOT, encoding: "utf8", timeout: cfg.claudeTimeoutMinutes * 60000, env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH}` } });
    fs.writeFileSync(path.join(out, "claude.log"), `${r.stdout || ""}\n${r.stderr || ""}`);
    if (r.status !== 0) throw new Error(`Claude Code failed (see ${path.join(out, "claude.log")})`);
  }
  // Validate independently of what Claude reported.
  const check = spawnSync(node, ["assessment/report.js", "--in", results, "--out", out, "--only", ids.join(","), "--check"], { cwd: ROOT, encoding: "utf8" });
  if (!/all present and valid/.test(check.stdout)) throw new Error(`Judgements not valid; nothing queued. ${check.stdout.slice(0, 800)}`);

  const args = ["assessment/report.js", "--in", results, "--out", out, "--only", ids.join(","), "--no-save", "--history-dir", "assessment/history"];
  if (cfg.orgFile) args.push("--org", path.resolve(ROOT, cfg.orgFile));
  run(node, args);

  // The assessment rows per person ("Individuals" and "Evidence" of this run),
  // with each example's judgement, for the "Assessment" tabs of the results workbook.
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(out, "AI Assessment Report.xlsx"));
  const table = name => {
    const ws = wb.getWorksheet(name), cols = ws.getRow(1).values.slice(1).map(String), rows = [];
    ws.eachRow((row, i) => { if (i > 1) rows.push(Object.fromEntries(cols.map((c, j) => [c, row.getCell(j + 1).value ?? ""]))); });
    return { cols, rows };
  };
  const ind = table("Individuals"), evd = table("Evidence");
  const judgements = {};
  for (const f of fs.readdirSync(path.join(out, "judgements")).filter(n => n.endsWith(".json")))
    for (const j of readJson(path.join(out, "judgements", f), [])) if (j && j.key) judgements[j.key] = j;
  fs.mkdirSync(REPORTS, { recursive: true });

  // Keep each confirmed report and its rows, and put them on the survey page
  // (report) and in the results workbook (Assessment tabs).
  for (const p of fresh) {
    const f = fs.readdirSync(path.join(out, "individual")).find(n => n.startsWith(`${p.empId.replace(/[\\/:*?"<>|]+/g, "-")} - `));
    if (!f) { log(`${p.empId}: no report was produced`); continue; }
    const html = fs.readFileSync(path.join(out, "individual", f), "utf8");
    const row = ind.rows.find(r => String(r["Employee ID"]) === p.empId) || {};
    const exRows = evd.rows.filter(r => String(r["Employee ID"]) === p.empId).map(r => ({
      "Submission ID": p.submissionId, ...r, Judgement: JSON.stringify(judgements[`${p.empId}|${r["Question ID"]}`] || null) }));
    const payload = { submissionId: p.submissionId, html,
      assessment: { columns: ind.cols, row },
      evidence: { columns: ["Submission ID", ...evd.cols, "Judgement"], rows: exRows } };
    fs.writeFileSync(path.join(REPORTS, `${p.submissionId}.html`), html);
    fs.writeFileSync(path.join(REPORTS, `${p.submissionId}.json`), JSON.stringify(payload));
    if (cfg.uploadReports && cfg.surveyUrl && surveyToken()) {
      try {
        const r = await surveyCall("POST", "/api/results/upload", payload);
        log(`REPORT ${p.empId} Level ${row["Confirmed level"]} is on the survey page${r.savedToWorkbook ? " and in the results workbook (Assessment tabs)" : " (workbook tabs not saved)"}`);
      } catch (e) { log(`REPORT ${p.empId} upload failed (${e.message}); it will be retried`); }
    }
    seen[p.empId] = { submissionId: p.submissionId, level: row["Confirmed level"], reportAt: new Date().toISOString(), run: path.relative(ROOT, out) };
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  await syncReports();
}

main().catch(e => { log(`ERROR ${e.message}`); process.exit(1); });
