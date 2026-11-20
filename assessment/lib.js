"use strict";
// Shared logic for the one-time assessment: reading the results workbook,
// the quality filter, scoring (RUBRIC.md Part A), evidence decisions (Part B3)
// and next-level gaps. prepare.js and report.js both use this file.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const Scoring = require("../src/scoring.js");

const ROOT = path.join(__dirname, "..");
const bank = require(path.join(ROOT, "data", "questions.json"));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "rules.json"), "utf8"));
const LETTERS = ["A", "B", "C", "D", "E"];
const LEVELS = [1, 2, 3, 4, 5, 6, 7];

const CRITERIA_LABELS = {
  TASK: "Real task", AGENTIC: "AI did the steps", CHECKED: "Checked the output", REPEATED: "Done regularly",
  REUSABLE: "Reusable command or workflow",
  SHARED: "Shared thing", USERS: "Who uses it", WHERE: "Where it lives", IMPACT: "What changed for others",
  STANDARD: "Adopted as a team standard",
  BEFORE_AFTER: "Before and after", ADOPTED: "Who adopted it", MEASURED: "Measured result", OWNED: "Owner or guardrails",
  BEYOND_TEAM: "Adopted beyond the team"
};
const CRITERIA_HINTS = {
  TASK: "the specific piece of work you did", AGENTIC: "how the AI carried out the steps or used tools and data (agent, MCP, API)",
  CHECKED: "how you checked the output (tests, review, comparing results)", REPEATED: "how often you do it",
  SHARED: "what you shared (guide, library, standard, session)", USERS: "who uses it (at least 2 colleagues or a team)",
  WHERE: "where it lives (repository, wiki, link) or when the session ran", IMPACT: "what changed for the people using it",
  BEFORE_AFTER: "how the process worked before and how it works now", ADOPTED: "who runs the new process",
  MEASURED: "a measured result with a number", OWNED: "who owns it and what guardrails apply"
};

// ---------- reading the results workbook ----------
const clean = v => {
  if (v && typeof v === "object" && !(v instanceof Date)) v = v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join("") : "");
  if (typeof v === "string" && v.startsWith("'")) v = v.slice(1);
  return v ?? "";
};

function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Sheet "${name}" not found. Is this the results workbook from the survey?`);
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

const qsetByName = Object.fromEntries(Object.entries(bank.questionnaires).map(([k, v]) => [v.name, k]));
const deptKey = d => String(d).toLowerCase().replace(/[\s.,;:\-_]+$/g, "").replace(/\s+/g, " ").trim();

// People with their answers and evidence, active submissions only.
async function loadResults(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const responses = readSheet(wb, "Responses");
  const evidence = readSheet(wb, "Evidence");

  const canonDept = new Map((bank.departments || []).map(d => [deptKey(d), d]));
  const people = [];
  const skipped = [];
  for (const r of responses) {
    const name = String(r.Name || "");
    if (rules.excludeStatuses.includes(r.Status)) { skipped.push({ name, reason: r.Status }); continue; }
    if (rules.excludeNamePrefixes.some(p => name.startsWith(p))) { skipped.push({ name, reason: "Test entry" }); continue; }
    const qset = qsetByName[r.Role] || (bank.roleMap.find(m => m.teamRole === r["Team role"]) || {}).questionnaire;
    if (!qset) { skipped.push({ name, reason: `Unknown role "${r.Role}"` }); continue; }
    const qs = Scoring.questionsFor(bank, qset);
    const answers = {};
    qs.forEach((q, i) => {
      const col = i < 20 ? "R" + String(i + 1).padStart(2, "0") : "C" + String(i - 19).padStart(2, "0");
      const a = String(r[col] || "").toUpperCase();
      answers[q.id] = LETTERS.includes(a) ? a : "";
    });
    const k = deptKey(r.Department || "");
    if (k && !canonDept.has(k)) canonDept.set(k, String(r.Department).trim().replace(/[\s.,;:\-_]+$/g, ""));
    people.push({
      submissionId: String(r["Submission ID"]), empId: String(r["Respondent ID (Employee ID)"] ?? ""), name,
      email: String(r.Email || ""), department: canonDept.get(k) || "", teamRole: String(r["Team role"] || ""),
      qset, role: bank.questionnaires[qset].name, cycle: String(r.Cycle || ""), submittedAt: String(r["Submitted at (UTC)"] || ""),
      questions: qs, answers, evidence: []
    });
  }
  const byId = new Map(people.map(p => [p.submissionId, p]));
  for (const e of evidence) {
    const p = byId.get(String(e["Submission ID"]));
    if (!p) continue;
    const q = p.questions.find(x => x.id === e["Question ID"]);
    if (!q) continue;
    p.evidence.push({
      // Employee ID + question: stable across exports and readable. Only one
      // active submission per person is counted (earlier ones are Superseded).
      key: `${p.empId}|${q.id}`, questionId: q.id, level: q.level, useCase: q.useCase, question: q.text,
      answer: String(e.Answer || p.answers[q.id] || ""), example: String(e.Example || ""),
      followupQ: String(e["Follow-up question"] || ""), followupA: String(e["Follow-up answer"] || ""), link: String(e.Link || "")
    });
  }
  return { people, skipped, cycle: [...new Set(people.map(p => p.cycle).filter(Boolean))].join(", ") };
}

// ---------- rubric text per question (RUBRIC.md Part E) ----------
function lookForLines() {
  const text = fs.readFileSync(path.join(__dirname, "RUBRIC.md"), "utf8");
  const out = {};
  for (const m of text.matchAll(/^- \*\*([A-Z]+-[RC]\d+) [^*]+\*\* (.+)$/gm)) out[m[1]] = m[2].trim();
  return out;
}

// ---------- Part C: quality filter ----------
function qualityCheck(ev) {
  const text = `${ev.example} ${ev.followupA}`.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const real = w => {
    const s = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!s) return false;
    if (/^\d+[.)]?$/.test(s) || /^[A-Z0-9]{2,6}$/.test(s)) return true; // numbers, acronyms (MCP, PR, CI)
    if (!/^[A-Za-z][A-Za-z'’\-]*$/.test(s) || s.length > 20) return false;
    if (!/[aeiouy]/i.test(s) || /[bcdfghjklmnpqrstvwxz]{5,}/i.test(s)) return false;
    if (/(.{2,4})\1\1/i.test(s)) return false; // "sdfsdfsdf"
    return true;
  };
  const realCount = words.filter(real).length;
  const junkShare = words.length ? 1 - realCount / words.length : 1;
  if (realCount < rules.qualityFilter.minRealWords)
    return { ok: false, reason: `Too little to assess: ${realCount} real words (at least ${rules.qualityFilter.minRealWords} needed).` };
  if (junkShare > rules.qualityFilter.maxShareOfJunkWords)
    return { ok: false, reason: `Mostly placeholder or random text (${Math.round(junkShare * 100)}% of words).` };
  return { ok: true };
}

// ---------- Part B3: decision from criteria ----------
function decide(level, judgement) {
  if (!judgement) return { decision: "Not assessed", missing: [], shown: [] };
  if (judgement.qualityRejected) return { decision: "Does not meet", missing: rules.evidenceCriteria[level], shown: [] };
  const must = rules.evidenceCriteria[level];
  const shown = must.filter(c => judgement.criteria && judgement.criteria[c] && judgement.criteria[c].met === true);
  const missing = must.filter(c => !shown.includes(c));
  let decision = missing.length === 0 ? "Meets" : missing.length === 1 ? "Needs more evidence" : "Does not meet";
  if (judgement.lowerLevel === true) decision = "Does not meet";
  return { decision, missing, shown };
}

// ---------- Part A: scoring ----------
const need = n => Math.ceil(n / 2);

function score(person, judgements) {
  const evByQ = Object.fromEntries(person.evidence.map(e => [e.questionId, e]));
  const practices = person.questions.map(q => {
    const a = person.answers[q.id];
    const barLetter = rules.practiceCountsAt[q.level];
    const claimed = LETTERS.indexOf(a) >= LETTERS.indexOf(barLetter);
    const needsProof = rules.evidenceLevels.includes(q.level);
    const ev = evByQ[q.id];
    const j = ev ? judgements[ev.key] : null;
    const d = needsProof && claimed ? decide(q.level, j) : null;
    const confirmed = claimed && (!needsProof || (d && d.decision === "Meets"));
    return {
      id: q.id, level: q.level, useCase: q.useCase, answer: a, answerText: a ? Scoring.scaleFor(bank, q.level)[LETTERS.indexOf(a)] : "Not answered",
      barLetter, barText: Scoring.scaleFor(bank, q.level)[LETTERS.indexOf(barLetter)], claimed, confirmed, needsProof,
      evidence: ev || null, judgement: j || null, decision: d
    };
  });

  const ladder = mode => {
    const per = LEVELS.map(L => {
      const ps = practices.filter(p => p.level === L);
      const count = ps.filter(p => (mode === "self" ? p.claimed : p.confirmed)).length;
      return { level: L, total: ps.length, count, needed: need(ps.length), reached: count >= need(ps.length) };
    });
    let level = 0;
    for (const p of per) { if (p.reached) level = p.level; else break; }
    const next = per[level]; // undefined at Level 7
    const s = level === 7 ? 7 : level + (next && next.total ? next.count / next.total : 0);
    return { per, level, score: Math.round(s * 10) / 10 };
  };
  const self = ladder("self"), conf = ladder("confirmed");

  // Next-level gap (confirmed view)
  let nextLevel = null;
  if (conf.level < 7) {
    const L = conf.level + 1, row = conf.per[L - 1];
    const ps = practices.filter(p => p.level === L);
    const have = ps.filter(p => p.confirmed);
    const missing = ps.filter(p => !p.confirmed);
    // Closest first: claimed but not proven, then by answer, highest first
    const rank = p => (p.claimed ? 10 : LETTERS.indexOf(p.answer));
    missing.sort((a, b) => rank(b) - rank(a));
    nextLevel = { level: L, name: rules.levelNames[L], needed: row.needed, total: row.total, have, missing, stillNeeded: Math.max(0, row.needed - have.length) };
  }
  const aboveNext = practices.filter(p => p.confirmed && p.level > conf.level + 1);

  // Flags (Part C)
  const letters = Object.values(person.answers).filter(Boolean);
  const top = Math.max(0, ...LETTERS.map(l => letters.filter(x => x === l).length));
  const flags = [];
  if (letters.length && top / letters.length >= rules.flags.sameAnswerShare) flags.push("Same answer everywhere");
  const highClaims = practices.filter(p => p.level >= 5 && p.claimed).length;
  if (highClaims >= rules.flags.ladderJumpMinHighClaims && !self.per[2].reached) flags.push("Ladder jump");
  const texts = person.evidence.map(e => e.example.trim().toLowerCase()).filter(t => t.length > 0);
  if (new Set(texts).size < texts.length) flags.push("Reused example");
  const crossTotal = practices.filter(p => p.id.startsWith("CR-")).length;
  const crossCount = practices.filter(p => p.id.startsWith("CR-") && p.confirmed).length;

  return { practices, self, conf, nextLevel, aboveNext, flags, crossScore: crossTotal ? crossCount / crossTotal : 0 };
}

// What would make a practice count, in plain words.
function toCount(p) {
  if (p.confirmed) return "";
  if (p.claimed && p.needsProof) {
    if (p.judgement && p.judgement.improve) return p.judgement.improve;
    if (p.decision && p.decision.decision === "Not assessed") return "Your example has not been assessed yet.";
    const miss = (p.decision ? p.decision.missing : rules.evidenceCriteria[p.level]).map(c => CRITERIA_HINTS[c]).filter(Boolean);
    return `Describe ${miss.join("; ")}.`;
  }
  const extra = p.needsProof
    ? ` Then describe it with an example showing ${rules.evidenceCriteria[p.level].map(c => CRITERIA_LABELS[c].toLowerCase()).join(", ")}.`
    : "";
  return `Reach "${p.barText}".${extra}`;
}

function statusText(p) {
  if (p.confirmed) return p.needsProof ? "In place, and your example shows it" : `In place: ${p.answerText}`;
  if (p.claimed && p.needsProof) {
    const d = p.decision ? p.decision.decision : "Not assessed";
    if (d === "Not assessed") return `You answered "${p.answerText}"; example not assessed yet`;
    return `You answered "${p.answerText}", but your example ${d === "Needs more evidence" ? "is missing one point" : "does not show it yet"}`;
  }
  return `Not yet: ${p.answerText}`;
}

function median(nums) {
  const s = [...nums].sort((a, b) => b - a);
  return s.length ? s[Math.ceil(s.length / 2) - 1] : null; // level at least half have reached
}

module.exports = {
  bank, rules, LETTERS, LEVELS, CRITERIA_LABELS, CRITERIA_HINTS, ROOT,
  loadResults, lookForLines, qualityCheck, decide, score, toCount, statusText, median
};
