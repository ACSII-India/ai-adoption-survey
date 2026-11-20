"use strict";
// Automatic per-submission assessment. Run every 15 minutes by a timer
// (scripts/systemd/ai-survey-auto.*). For each person who submitted since the
// last run it:
//   1. assesses only them with the standard engine (prepare.js, Claude Code
//      headless judges their Level 5-7 examples with the ai-assessment skill,
//      report.js scores them and builds the PDF and email);
//   2. applies Option B: send when autoSend is on and the result has no
//      Level 5-7 examples and no flags; otherwise hold as a draft for review;
//   3. puts the report on the survey page and a short "your result is ready"
//      email with the personal link in assessment/outbox/pending/<id>/ for the Windows
//      Outlook task, which moves it to outbox/done/ when drafted or sent.
//
//   node assessment/auto/run-auto.js [--dry-run] [--in <results file>]
//
// State (who has been handled) is in assessment/auto/state.json. Log: assessment/auto/auto.log.
// Nothing here sends email; the Windows task does, and only with -AllowSend.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadResults } = require("../lib.js");

const ROOT = path.join(__dirname, "..", "..");
const HERE = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
if (process.env.SURVEY_URL) cfg.surveyUrl = process.env.SURVEY_URL; // e.g. a local copy for testing
const STATE = path.join(HERE, "state.json");
const LOG = path.join(HERE, "auto.log");
const OUTBOX = path.join(ROOT, "assessment", "outbox");
const dryRun = process.argv.includes("--dry-run");
const inArg = process.argv.indexOf("--in") >= 0 ? process.argv[process.argv.indexOf("--in") + 1] : null; // test with another results file

const log = m => { const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${m}`; console.log(line); fs.appendFileSync(LOG, line + "\n"); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return d; } };
const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    await surveyCall("POST", "/api/results/upload", { submissionId: id, html: fs.readFileSync(path.join(REPORTS, f), "utf8") });
    sent++;
  }
  if (sent) log(`REPORTS uploaded ${sent} to the survey (${local.length} kept here)`);
}

// Pick up receipts from the Windows task (items moved to outbox/done/).
function readReceipts(state) {
  const done = path.join(OUTBOX, "done");
  if (!fs.existsSync(done)) return;
  for (const d of fs.readdirSync(done)) {
    const rec = readJson(path.join(done, d, "receipt.json"), null), item = readJson(path.join(done, d, "item.json"), null);
    if (!rec || !item) continue;
    const s = ((state[item.cycle] = state[item.cycle] || {})[item.empId] = state[item.cycle][item.empId] || {});
    if (s.outlook !== rec.status) { s.outlook = rec.status; s.outlookAt = rec.at; log(`${item.empId}: Outlook ${rec.status} (${rec.at})`); }
  }
}

async function main() {
  const state = readJson(STATE, {});
  readReceipts(state);

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

  // Results per person (level, examples, flags) for Option B routing.
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(out, "AI Assessment Report.xlsx"));
  const ws = wb.getWorksheet("Individuals"), h = ws.getRow(1).values, info = {};
  ws.eachRow((row, i) => { if (i > 1) { const v = row.values, g = k => v[h.indexOf(k)]; info[String(g("Employee ID"))] = { level: g("Confirmed level"), examples: (g("Examples meet") || 0) + (g("Examples need more") || 0) + (g("Examples do not meet") || 0), flags: g("Flags") || "" }; } });
  const emailCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "assessment", "email.json"), "utf8"));
  const { renderNotice } = require("../individual.js");
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.mkdirSync(path.join(OUTBOX, "pending"), { recursive: true });

  for (const p of fresh) {
    const meta = info[p.empId] || {};
    // 1. Keep the confirmed report, and put it on the survey page (returns the personal link).
    const f = fs.readdirSync(path.join(out, "individual")).find(n => n.startsWith(`${p.empId.replace(/[\\/:*?"<>|]+/g, "-")} - `));
    if (!f) { log(`${p.empId}: no report was produced`); continue; }
    const html = fs.readFileSync(path.join(out, "individual", f), "utf8");
    fs.writeFileSync(path.join(REPORTS, `${p.submissionId}.html`), html);
    let link = "";
    if (cfg.uploadReports && cfg.surveyUrl && surveyToken()) {
      try { link = (await surveyCall("POST", "/api/results/upload", { submissionId: p.submissionId, html })).link || ""; log(`REPORT ${p.empId} is on the survey page`); }
      catch (e) { log(`REPORT ${p.empId} upload failed (${e.message}); it will be retried`); }
    }
    seen[p.empId] = { submissionId: p.submissionId, level: meta.level, reportAt: new Date().toISOString(), run: path.relative(ROOT, out) };
    // 2. "Your result is ready" email with the link (Option B routing; drafts while autoSend is off).
    if (!cfg.notifyByEmail) continue; // people see "Your report is ready" on the survey page; no email
    if (!link) { log(`NOTICE ${p.empId} not queued yet: no personal link (report not on the survey page)`); continue; }
    const reasons = [];
    if (!cfg.autoSend) reasons.push("automatic sending is off");
    if (meta.examples > 0) reasons.push("has Level 5-7 examples to review");
    if (meta.flags) reasons.push(`flags: ${meta.flags}`);
    const action = reasons.length ? "draft" : "send";
    const notice = renderNotice(p, { cycle, link, email: emailCfg, level: meta.level });
    const id = `${slug(cycle)}--${slug(p.empId)}--${slug(p.submissionId)}`;
    const dir = path.join(OUTBOX, "pending", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "body.html"), notice.html);
    fs.writeFileSync(path.join(dir, "body.txt"), notice.text);
    fs.writeFileSync(path.join(dir, "item.json"), JSON.stringify({ id, cycle, empId: p.empId, submissionId: p.submissionId, email: p.email, name: p.name,
      subject: notice.subject, attachment: "", fromMailbox: emailCfg.fromMailbox || "", cc: emailCfg.cc || "", action, reason: reasons.join("; "),
      level: meta.level, link, preparedAt: new Date().toISOString() }, null, 2));
    Object.assign(seen[p.empId], { notice: action, reason: reasons.join("; "), queuedAt: new Date().toISOString() });
    log(`QUEUED notice ${p.empId} Level ${meta.level} -> ${action.toUpperCase()}${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  await syncReports();
}

main().catch(e => { log(`ERROR ${e.message}`); process.exit(1); });
