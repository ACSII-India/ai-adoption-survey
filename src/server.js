"use strict";
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const config = require("./config");
const bank = require("../data/questions.json");
const Scoring = require("./scoring");
const { createStore } = require("./store");
const { reviewEvidence } = require("./claude");
const mail = require("./mailer");
const auth = require("./auth");
const results = require("./results");
const people = require("./people");
// The assessment engine (same rules as the one-time assessment) builds the
// report shown on the final page.
const assess = require("../assessment/lib.js");
const { renderIndividual } = require("../assessment/individual.js");

const store = createStore();
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { directives: { "script-src": ["'self'"], "img-src": ["'self'", "data:"], "form-action": ["'self'", "https://login.microsoftonline.com"], "upgrade-insecure-requests": config.mock ? null : [] } },
  strictTransportSecurity: !config.mock
}));
app.use(express.json({ limit: "200kb" }));
app.use(session({
  name: "survey.sid",
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: !config.mock, maxAge: 8 * 60 * 60 * 1000 }
}));

/* ---------- helpers ---------- */
const hmac = s => crypto.createHmac("sha256", config.sessionSecret).update(s).digest("base64url");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sha = s => crypto.createHash("sha256").update(String(s || "")).digest("base64url");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domainOk = email => !config.allowedEmailDomains.length || config.allowedEmailDomains.includes(email.split("@")[1].toLowerCase());
const findQuestion = (qset, id) => Scoring.questionsFor(bank, qset).find(q => q.id === id);
const scoreOpts = { threshold: config.levelThreshold, metScore: config.metScore };
const fail = (res, status, error, message) => res.status(status).json({ error, message });

const limiter = (windowMin, limit) => rateLimit({ windowMs: windowMin * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => fail(res, 429, "rate_limited", "Too many requests from this network. Wait a few minutes and try again.") });

// Admin POSTs must come from our own page (custom header + JSON body).
function sameOrigin(req, res, next) {
  if (req.get("X-Requested-With") !== "fetch" || !req.is("application/json")) return fail(res, 403, "bad_request", "Request blocked.");
  next();
}

/* ---------- static ---------- */
app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", extensions: ["html"] }));
app.get("/scoring.js", (req, res) => res.sendFile(path.join(__dirname, "scoring.js")));
app.get("/healthz", (req, res) => res.json({ ok: true }));

/* ---------- participant API (no sign-in) ---------- */
app.get("/api/config", (req, res) => {
  res.json({
    bank, cycle: config.cycleName, requireEmailCode: config.requireEmailCode,
    allowedEmailDomains: config.allowedEmailDomains, resultsEmailEnabled: config.resultsEmailEnabled,
    allowResubmit: config.allowResubmit, surveyOwner: config.surveyOwner, surveyOwnerContact: config.surveyOwnerContact, threshold: config.levelThreshold, metScore: config.metScore
  });
});

// First screen: find the person in the employee list (standard master sheet).
// Exact Employee ID only; people on probation (no ID yet) use their work email.
// The email is shown partly hidden, and lookups are rate-limited.
const notListed = () => `This isn't on the employee list. Please message ${config.surveyOwner} on Microsoft Teams${config.surveyOwnerContact ? ` (${config.surveyOwnerContact})` : ""}.`;
app.post("/api/people/lookup", limiter(10, 30), (req, res) => {
  if (!people.loaded()) return fail(res, 503, "list_not_loaded", "The employee list is being loaded. Please try again in a few minutes.");
  const empId = str(req.body.empId, 40), email = str(req.body.email, 200).toLowerCase();
  let p = null;
  if (empId) p = people.findById(empId);
  else if (email) {
    if (people.hasId(email)) return fail(res, 400, "use_id", "You have an Employee ID: please enter that instead.");
    p = people.findProbation(email);
  }
  if (!p) return fail(res, 404, "not_listed", notListed());
  const pr = people.profileOf(p);
  res.json({ name: pr.name, empId: p.empId, emailShown: people.mask(pr.email), teamRole: pr.teamRole, qset: pr.qset, questionnaire: bank.questionnaires[pr.qset].name, probation: pr.probation });
});
// The person as the server knows them, from what the browser sent.
const personFrom = p => p && (p.probation ? people.findProbation(str(p.lookupEmail, 200)) : people.findById(str(p.empId, 40)));

// Optional one-time code sent to the participant's work email.
const codes = new Map(); // email -> { hash, expires, tries }
app.post("/api/verify/start", limiter(15, 5), async (req, res) => {
  if (!config.requireEmailCode) return res.json({ ok: true, required: false });
  const known = personFrom(req.body.profile);
  const email = known ? known.email : str(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email) || !domainOk(email)) return fail(res, 400, "bad_email", "Use your work email address.");
  const code = String(crypto.randomInt(100000, 1000000));
  codes.set(email, { hash: sha(code + email), expires: Date.now() + 15 * 60 * 1000, tries: 0 });
  try {
    if (config.mock && !mail.isConfigured()) console.log(`[DEV_MOCK] verification code for ${email}: ${code}`);
    else await mail.sendMail(email, "Your AI adoption check-in code", `<p>Your code is <strong>${code}</strong>. It expires in 15 minutes.</p><p>If you did not ask for this, ignore this email.</p>`);
    res.json({ ok: true, required: true });
  } catch (e) {
    console.error("verification mail failed:", e.message);
    fail(res, 502, "mail_failed", "The code could not be sent. Try again in a few minutes.");
  }
});
app.post("/api/verify/check", limiter(15, 20), (req, res) => {
  const known = personFrom(req.body.profile);
  const email = known ? known.email : str(req.body.email, 200).toLowerCase(), code = str(req.body.code, 10);
  const c = codes.get(email);
  if (!c || c.expires < Date.now()) return fail(res, 400, "code_expired", "The code has expired. Ask for a new one.");
  if (++c.tries > 5) { codes.delete(email); return fail(res, 400, "too_many_tries", "Too many wrong codes. Ask for a new one."); }
  if (!safeEq(sha(code + email), c.hash)) return fail(res, 400, "wrong_code", "That code is not right. Check the email and try again.");
  codes.delete(email);
  const expires = Date.now() + 3 * 60 * 60 * 1000;
  res.json({ ok: true, token: `${expires}.${hmac(`verify|${email}|${expires}`)}` });
});
const verifyTokenOk = (email, token) => {
  const [exp, sig] = String(token || "").split(".");
  return Number(exp) > Date.now() && safeEq(sig || "", hmac(`verify|${email}|${exp}`));
};

// Evidence follow-up and AI rating. The rating is signed so the client cannot alter it.
const reviewSig = (qid, example, followupA, r) => hmac(["review", qid, sha(example), sha(followupA), r.rating, sha(r.summary), sha(r.reason)].join("|"));
app.post("/api/review", limiter(10, 40), async (req, res) => {
  const qset = str(req.body.qset, 10), qid = str(req.body.questionId, 20), answer = str(req.body.answer, 1);
  const q = findQuestion(qset, qid);
  if (!q || !Scoring.needsEvidence(q, answer)) return fail(res, 400, "bad_request", "This question does not need an example.");
  const example = str(req.body.example, 2000), followupQ = str(req.body.followupQ, 300), followupA = str(req.body.followupA, 1000);
  if (example.length < 15) return fail(res, 400, "too_short", "Add a little more detail to your example.");
  const final = req.body.final === true;
  const r = await reviewEvidence({ question: q, levelInfo: bank.levels[q.level - 1], answer, answerText: Scoring.scaleFor(bank, q.level)[Scoring.LETTERS.indexOf(answer)], example, followupQ, followupA, final });
  if (!r) return res.json({ available: false });
  const out = { available: true, ...r };
  if (r.complete) out.signature = reviewSig(qid, example, followupA, r);
  res.json(out);
});

app.post("/api/submit", limiter(60, 10), async (req, res) => {
  // Name, Employee ID, email and role come from the employee list, never from
  // the browser. Department comes from the HR/org file at assessment time (the
  // column stays in the workbook, empty, so its layout is unchanged).
  if (!people.loaded()) return fail(res, 503, "list_not_loaded", "The employee list is being loaded. Keep this page open and try Submit again in a few minutes.");
  const known = personFrom(req.body.profile);
  if (!known) return fail(res, 400, "not_listed", notListed());
  const pr = people.profileOf(known);
  const profile = { name: pr.name, empId: pr.empId, email: pr.email, dept: "", teamRole: pr.teamRole };
  if (config.requireEmailCode && !verifyTokenOk(profile.email, req.body.verifyToken)) return fail(res, 401, "verify_required", "Confirm your email with the code we sent you.");
  const role = bank.roleMap.find(r => r.teamRole === profile.teamRole);
  const qset = role.questionnaire, qs = Scoring.questionsFor(bank, qset);

  const answers = {};
  for (const q of qs) {
    const a = str((req.body.answers || {})[q.id], 1).toUpperCase();
    if (!Scoring.LETTERS.includes(a)) return fail(res, 400, "incomplete", `Question ${q.id} is not answered.`);
    answers[q.id] = a;
  }

  const now = new Date().toISOString();
  const submissionId = "S-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  const evidenceRows = [];
  for (const q of qs) {
    if (!Scoring.needsEvidence(q, answers[q.id])) continue;
    const e = (req.body.evidence || {})[q.id] || {};
    const example = str(e.example, 2000), followupQ = str(e.followupQ, 300), followupA = str(e.followupA, 1000);
    let link = str(e.link, 500);
    if (example.length < 15) return fail(res, 400, "evidence_missing", `Add an example for ${q.id} or change that answer.`);
    if (link && !/^https?:\/\/\S+$/i.test(link)) link = "";
    const ai = { rating: str(e.rating, 40), summary: str(e.summary, 400), reason: str(e.reason, 300) };
    const signed = e.signature && safeEq(e.signature, reviewSig(q.id, example, followupA, ai));
    evidenceRows.push({
      "Submission ID": submissionId, Cycle: config.cycleName, "Employee ID": profile.empId, Name: profile.name, Email: profile.email,
      Department: profile.dept, "Team role": profile.teamRole, Questionnaire: bank.questionnaires[qset].name, "Question ID": q.id,
      Level: q.level, "Use case": q.useCase, Answer: answers[q.id], Example: example, "Follow-up question": followupQ,
      "Follow-up answer": followupA, Link: link, "AI rating": signed ? ai.rating : "Not assessed",
      "AI summary": signed ? ai.summary : "", "AI reason": signed ? ai.reason : "", "Reviewer decision": "", "Reviewer notes": "", "Reviewed by": "", "Reviewed on (UTC)": ""
    });
  }

  const s = Scoring.score(bank, qset, answers, scoreOpts);
  const row = {
    "Respondent ID (Employee ID)": profile.empId, Name: profile.name, Department: profile.dept, Role: bank.questionnaires[qset].name, Date: now.slice(0, 10),
    Email: profile.email, "Team role": profile.teamRole, Status: "Submitted", Answered: s.answered, "Total score": s.total,
    "Score %": Math.round(s.pct * 1000) / 10, "Current level": s.level, "Level name": s.levelName, "Level score": s.levelScore,
    "Provisional tier": s.tier, Examples: evidenceRows.length, "Examples accepted": 0, "Examples to review": evidenceRows.length,
    Cycle: config.cycleName, "Submission ID": submissionId, "Submitted at (UTC)": now
  };
  qs.forEach((q, i) => { row[i < 20 ? "R" + String(i + 1).padStart(2, "0") : "C" + String(i - 19).padStart(2, "0")] = answers[q.id]; });

  try {
    await store.addSubmission(row, evidenceRows);
  } catch (e) {
    if (e.message === "already_submitted") {
      // Record the request on the earlier check-in (Responses sheet), so the surveyor sees it on
      // the admin page and in the Excel file. Approving it is the surveyor's decision.
      let noted = false;
      try { if (e.submissionId) { await store.setStatus(e.submissionId, "Submitted", { "New check-in requested (UTC)": now.slice(0, 16).replace("T", " ") }); noted = true; } }
      catch (err) { console.error("request note failed:", err.message); }
      return fail(res, 409, "already_submitted", `You already submitted a check-in for ${config.cycleName} on ${String(e.submittedAt).slice(0, 10)}. ${noted
        ? `Your request for a new one has been sent to ${config.surveyOwner} for approval.`
        : `To send a new one, ask ${config.surveyOwner} to approve it.`} To follow up, message ${config.surveyOwner} on Microsoft Teams${config.surveyOwnerContact ? ` (${config.surveyOwnerContact})` : ""}. Once approved, click Submit my check-in again: keep this page open, your answers stay here.`);
    }
    console.error("submit failed:", e.message);
    return fail(res, 502, "save_failed", "Your answers could not be saved right now. Keep this page open and try Submit again in a minute.");
  }
  // Result report with the assessment rules. Level 5-7 examples need the
  // Claude check first, so those reports arrive later from the assessment job.
  let report = { pending: true, html: null };
  try {
    const person = { submissionId, empId: profile.empId, name: profile.name, email: profile.email, department: "", teamRole: profile.teamRole,
      qset, role: bank.questionnaires[qset].name, cycle: config.cycleName, questions: qs, answers,
      evidence: evidenceRows.map(e => ({ key: `${profile.empId}|${e["Question ID"]}`, questionId: e["Question ID"], level: e.Level, useCase: e["Use case"],
        question: (qs.find(q => q.id === e["Question ID"]) || {}).text, answer: e.Answer, example: e.Example, followupQ: e["Follow-up question"], followupA: e["Follow-up answer"] })) };
    const ar = assess.score(person, {});
    if (ar.practices.some(p => p.needsProof && p.claimed)) results.setPending(submissionId);
    else { report = { pending: false, html: renderIndividual(person, ar, { cycle: config.cycleName, contact: false }) }; results.setReady(submissionId, report.html, "survey"); }
  } catch (e) { console.error("report failed:", e.message); results.setPending(submissionId); }
  res.json({ submissionId, receipt: hmac(`receipt|${submissionId}`), report, result: s, questionnaire: bank.questionnaires[qset].name, examples: evidenceRows.map(e => ({ questionId: e["Question ID"], useCase: e["Use case"], rating: e["AI rating"], summary: e["AI summary"] })) });
});

function resultsEmail(r) {
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#051C2C">
<h2 style="color:#0032A0;margin:0 0 12px">Your AI adoption check-in results</h2>
<p>Hi ${esc(r.Name)}, thank you for completing the ${esc(r.Cycle)} check-in.</p>
<table cellpadding="6" style="border-collapse:collapse">
<tr><td>Overall score</td><td><strong>${esc(r["Score %"])}%</strong> (${esc(r["Total score"])} of 120)</td></tr>
<tr><td>Current level</td><td><strong>Level ${esc(r["Current level"])} ${esc(r["Level name"])}</strong> (level score ${esc(r["Level score"])})</td></tr>
<tr><td>Provisional tier</td><td><strong>${esc(r["Provisional tier"])}</strong></td></tr>
<tr><td>Questionnaire</td><td>${esc(r.Role)} (team role: ${esc(r["Team role"])})</td></tr>
<tr><td>Examples given</td><td>${esc(r.Examples)}</td></tr></table>
${Number(r["Current level"]) >= 5 ? "<p>Level 5 and above stays provisional until a reviewer validates your examples.</p>" : ""}
<p style="color:#45525C">Submission ${esc(r["Submission ID"])}, submitted ${esc(String(r["Submitted at (UTC)"]).slice(0, 10))}.</p></div>`;
}

// Participant: is my report ready? (receipt from the submit response or the personal link)
app.get("/api/result", limiter(10, 120), async (req, res) => {
  const id = str(req.query.id, 20), r = str(req.query.r, 100);
  if (!id || !safeEq(r, hmac(`receipt|${id}`))) return fail(res, 403, "bad_receipt", "This results link is not valid.");
  // Built from the results workbook (answers + the job's judgements in the
  // "Assessment evidence" tab); the stored copy is only a fallback.
  try {
    const b = await reportFromWorkbook(id);
    if (b && b.status === "withdrawn") return res.json(b);
    if (b && b.status === "ready") { results.setReady(id, b.html, "workbook"); return res.json(b); }
    if (b && b.status === "pending") { const e = results.get(id); return res.json(e && e.status === "ready" && e.source === "assessment" ? { status: "ready", html: e.html } : { status: "pending" }); }
  } catch (err) { console.error("report from workbook failed:", err.message); }
  const e = results.get(id);
  res.json(e && e.status === "ready" ? { status: "ready", html: e.html } : { status: "pending" });
});

// One person's report, rebuilt from the workbook with the assessment rules.
// Returns { status: "ready", html } or { status: "pending" } (Level 5-7
// examples not judged yet), or null when the submission is not in the workbook.
async function reportFromWorkbook(id) {
  const row = await store.getSubmission(id);
  if (!row) return null;
  // Inactive (formerly "Deleted"), test entries and check-ins replaced by an approved new one no longer have a report.
  if (["Inactive", "Deleted", "Test", "Reopened", "Superseded"].includes(row.Status)) return { status: "withdrawn" };
  const t = v => String(v ?? "").replace(/^'/, "");
  const qset = Object.keys(bank.questionnaires).find(k => bank.questionnaires[k].name === t(row.Role))
    || (bank.roleMap.find(m => m.teamRole === t(row["Team role"])) || {}).questionnaire;
  if (!qset) return null;
  const qs = Scoring.questionsFor(bank, qset);
  const answers = {};
  qs.forEach((q, i) => { answers[q.id] = t(row[i < 20 ? "R" + String(i + 1).padStart(2, "0") : "C" + String(i - 19).padStart(2, "0")]).toUpperCase(); });
  const empId = t(row["Respondent ID (Employee ID)"]);
  const ev = (await store.listEvidence()).filter(e => t(e["Submission ID"]) === id);
  const person = { submissionId: id, empId, name: t(row.Name), email: t(row.Email), department: t(row.Department), teamRole: t(row["Team role"]),
    qset, role: bank.questionnaires[qset].name, cycle: t(row.Cycle) || config.cycleName, questions: qs, answers,
    evidence: ev.map(e => ({ key: `${empId}|${t(e["Question ID"])}`, questionId: t(e["Question ID"]), level: Number(t(e.Level)), useCase: t(e["Use case"]),
      question: (qs.find(q => q.id === t(e["Question ID"])) || {}).text, answer: t(e.Answer), example: t(e.Example), followupQ: t(e["Follow-up question"]), followupA: t(e["Follow-up answer"]) })) };
  const judgements = {};
  for (const a of await store.listAssessmentEvidence(id)) { try { judgements[`${empId}|${t(a["Question ID"])}`] = JSON.parse(t(a.Judgement)); } catch (_) {} }
  const ar = assess.score(person, judgements);
  const claimed = ar.practices.filter(p => p.needsProof && p.claimed);
  if (claimed.some(p => !judgements[`${empId}|${p.id}`])) return { status: "pending" };
  const nl = ar.nextLevel;
  const summary = { level: ar.conf.level, levelName: assess.rules.levelNames[ar.conf.level], score: ar.conf.score,
    next: nl ? { level: nl.level, name: nl.name, have: nl.have.map(p => p.useCase), stillNeeded: nl.stillNeeded, from: nl.missing.map(p => p.useCase) } : null };
  return { status: "ready", html: renderIndividual(person, ar, { cycle: person.cycle, contact: false }), summary };
}

// Assessment job: upload confirmed reports, and list which ones Render already has.
// Needs RESULTS_TOKEN on the server; without it these routes are switched off.
function jobAuth(req, res, next) {
  const t = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!config.resultsToken || !safeEq(t, config.resultsToken)) return fail(res, 401, "unauthorized", "Not allowed.");
  next();
}
// Backup job: the employee list (scripts/sync-people.js).
app.get("/api/people/status", jobAuth, (req, res) => res.json(people.status()));
app.post("/api/people/upload", jobAuth, express.json({ limit: "1mb" }), (req, res) => {
  try { const r = people.load(req.body.people); console.log(`employee list updated: ${r.count} people`); res.json({ ok: true, ...r }); }
  catch (e) { fail(res, 400, "bad_request", e.message); }
});
app.get("/api/results/ready", jobAuth, (req, res) => res.json({ ready: results.readyIds() }));
app.post("/api/results/upload", jobAuth, async (req, res) => {
  const id = str(req.body.submissionId, 20), html = typeof req.body.html === "string" ? req.body.html : "";
  if (!/^S-[A-Z0-9]{6,12}$/.test(id) || !html || html.length > 150000) return fail(res, 400, "bad_request", "submissionId and html are required.");
  results.setReady(id, html, "assessment");
  // The assessment rows, saved in the results workbook ("Assessment" tabs).
  let saved = false;
  const a = req.body.assessment, e = req.body.evidence;
  const okTable = t => t && Array.isArray(t.columns) && t.columns.length <= 80 && t.columns.every(c => typeof c === "string");
  if (okTable(a) && a.row && typeof a.row === "object" && okTable(e) && Array.isArray(e.rows) && e.rows.length <= 40) {
    const clean = row => Object.fromEntries(Object.entries(row).filter(([k]) => typeof k === "string").map(([k, v]) => [k.slice(0, 80), typeof v === "number" ? v : str(String(v ?? ""), 4000)]));
    try { saved = await store.saveAssessment(id, { columns: a.columns, row: clean(a.row) }, { columns: e.columns, rows: e.rows.map(clean) }); }
    catch (err) { console.error("assessment save failed:", err.message); }
  }
  res.json({ ok: true, link: resultLinkFor(id), savedToWorkbook: saved });
});

// Backup job: put the results workbook back after a restart lost it. The
// backup copy is merged with anything submitted since the restart.
app.post("/api/results/restore-workbook", jobAuth, express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.subarray(0, 2).toString() !== "PK")
    return fail(res, 400, "bad_request", "An .xlsx file is required.");
  try {
    const r = await store.mergeFrom(req.body);
    if (r === false) return fail(res, 501, "not_supported", "Restoring is only needed for the local results file.");
    console.log(`results workbook restored from backup: ${r.responses} responses, ${r.added} rows kept from after the restart`);
    res.json({ ok: true, ...r });
  } catch (e) { console.error("restore failed:", e.message); fail(res, 500, "restore_failed", "The backup could not be restored."); }
});

// Personal result link (same one the participant sees after submitting).
function resultLinkFor(id) { return `${config.baseUrl}/?result=${id}.${hmac(`receipt|${id}`)}`; }

// Admin and reviewers: report status and the personal link, to send to someone who lost it.
app.get("/admin/api/result-link", auth.requireReviewer, (req, res) => {
  const id = str(req.query.id, 20);
  if (!/^S-[A-Z0-9]{6,12}$/.test(id)) return fail(res, 400, "bad_request", "Unknown submission.");
  const e = results.get(id);
  res.json({ status: e && e.status === "ready" ? "ready" : "pending", link: resultLinkFor(id) });
});

app.post("/api/email-results", limiter(60, 5), async (req, res) => {
  if (!config.resultsEmailEnabled) return fail(res, 400, "disabled", "Results email is turned off.");
  const submissionId = str(req.body.submissionId, 20);
  if (!safeEq(str(req.body.receipt, 100), hmac(`receipt|${submissionId}`))) return fail(res, 403, "bad_receipt", "This results link is not valid.");
  try {
    const r = await store.getSubmission(submissionId);
    if (!r) return fail(res, 404, "not_found", "Submission not found.");
    if (config.mock && !mail.isConfigured()) console.log(`[DEV_MOCK] results email to ${r.Email}`);
    else await mail.sendMail(r.Email, "Your AI adoption check-in results", resultsEmail(r));
    res.json({ ok: true, sentTo: r.Email });
  } catch (e) {
    console.error("results mail failed:", e.message);
    fail(res, 502, "mail_failed", "The email could not be sent. Try again in a few minutes.");
  }
});

/* ---------- admin and reviewer ---------- */
app.get("/auth/signin", auth.signIn);
app.post("/auth/signin", limiter(15, 10), express.urlencoded({ extended: false, limit: "2kb" }), auth.signInWithPasscode);
app.get("/auth/redirect", auth.redirect);
app.post("/auth/signout", auth.signOut);

app.get("/admin/api/me", auth.requireReviewer, (req, res) => {
  const u = req.session.user;
  res.json({ name: u.name, email: u.email, role: u.isAdmin ? "admin" : "reviewer", cycle: config.cycleName, mock: config.mock });
});

app.get("/admin/api/data", auth.requireReviewer, async (req, res) => {
  try {
    const [responses, evidence] = await Promise.all([store.listResponses(), store.listEvidence()]);
    const strip = r => { const o = Object.assign({}, r); delete o._index; return o; };
    res.json({ responses: responses.map(strip), evidence: evidence.map(strip) });
  } catch (e) {
    console.error("load failed:", e.message);
    fail(res, 502, "load_failed", "The workbook could not be read. Check that the Excel file still exists and the app still has access.");
  }
});

app.post("/admin/api/review", auth.requireReviewer, sameOrigin, async (req, res) => {
  const decision = str(req.body.decision, 40);
  if (!["", "Accepted", "Needs more evidence", "Rejected"].includes(decision)) return fail(res, 400, "bad_decision", "Unknown decision.");
  try {
    await store.saveReview(str(req.body.submissionId, 20), str(req.body.questionId, 20), {
      "Reviewer decision": decision, "Reviewer notes": str(req.body.notes, 500),
      "Reviewed by": decision ? (req.session.user.name || req.session.user.email) : "", "Reviewed on (UTC)": decision ? new Date().toISOString().slice(0, 16).replace("T", " ") : ""
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("review failed:", e.message);
    fail(res, e.message === "evidence_not_found" ? 404 : 502, "save_failed", "The review could not be saved. Reload and try again.");
  }
});

app.post("/admin/api/status", auth.requireReviewer, auth.requireAdmin, sameOrigin, (req, res) => changeStatus(req, res, null));
// The surveyor's helper jobs change a status with RESULTS_TOKEN (no passcode stored on any machine).
app.post("/api/results/status", jobAuth, (req, res) => changeStatus(req, res, config.surveyOwner + " (job)"));
async function changeStatus(req, res, jobBy) {
  // Submitted: counts. Inactive: no longer counts (rows marked "Deleted" earlier mean the same). Test: a trial entry. Reopened: the surveyor approved a
  // new check-in for this person. Only "Submitted" blocks a new check-in, and only it is assessed.
  const status = str(req.body.status, 20), id = str(req.body.submissionId, 20);
  if (!["Submitted", "Inactive", "Test", "Reopened"].includes(status)) return fail(res, 400, "bad_status", "Unknown status.");
  try {
    if (status === "Submitted") {
      const all = await store.listResponses(), r = all.find(x => x["Submission ID"] === id);
      const other = r && all.find(x => x !== r && x.Status === "Submitted" && x.Cycle === r.Cycle
        && String(x["Respondent ID (Employee ID)"]).trim().toLowerCase() === String(r["Respondent ID (Employee ID)"]).trim().toLowerCase());
      if (other) return fail(res, 409, "newer_exists", `This person has a newer check-in (${String(other["Submitted at (UTC)"]).slice(0, 10)}). Only one can count.`);
    }
    // The approval is recorded in the results Excel itself (Responses sheet), next to Status.
    const u = req.session.user || {};
    const by = jobBy || (config.mock && process.env.SURVEY_OWNER ? config.surveyOwner : (u.name || u.email || "admin"));
    await store.setStatus(id, status, {
      "New check-in approved": status === "Reopened" ? "Yes" : "",
      "Status changed by": by, "Status changed on (UTC)": new Date().toISOString().slice(0, 16).replace("T", " ")
    });
    res.json({ ok: true });
  }
  catch (e) { console.error("status failed:", e.message); fail(res, 502, "save_failed", "The change could not be saved."); }
}

// The backup job downloads the workbook with RESULTS_TOKEN instead of signing in.
app.get("/api/results/download", jobAuth, (req, res) => downloadWorkbook(req, res));
app.get("/admin/api/download", auth.requireReviewer, (req, res) => downloadWorkbook(req, res));
async function downloadWorkbook(req, res) {
  if (config.mock && !config.localExcelPath) return res.status(501).send("Download needs the real Excel file; it is not available with DEV_MOCK.");
  try {
    const r = await store.download();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="ai-adoption-responses-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    // A read error mid-stream must not crash the server (unhandled 'error').
    Readable.fromWeb(r.body)
      .on("error", e => { console.error("download failed:", e.message); res.destroy(e); })
      .pipe(res);
  } catch (e) {
    console.error("download failed:", e.message);
    res.status(502).send("The Excel file could not be downloaded right now.");
  }
}

app.get("/admin/api/file-link", auth.requireReviewer, async (req, res) => {
  try { res.json({ webUrl: await store.webUrl() }); }
  catch (e) { fail(res, 502, "load_failed", "The file link could not be read."); }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  fail(res, 500, "server_error", "Something went wrong on the server.");
});

app.listen(config.port, () => {
  console.log(`AI adoption survey listening on ${config.baseUrl} (port ${config.port})${config.mock ? " in DEV_MOCK mode" : ""}`);
  const lanIps = Object.values(require("os").networkInterfaces()).flat()
    .filter(n => n && n.family === "IPv4" && !n.internal).map(n => n.address);
  if (lanIps.length) console.log(`reachable from the network at: ${lanIps.map(ip => `http://${ip}:${config.port}`).join(", ")}`);
});
