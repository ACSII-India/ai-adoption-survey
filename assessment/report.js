"use strict";
// Step 3 of the assessment: combine answers, Claude's judgements and the
// optional org file into the final outputs.
//
//   node assessment/report.js --in <results.xlsx> [--org <org.xlsx|org.csv>] [--out assessment/out] [--check]
//
// --check only validates the judgements and prints problems.
//
// Writes to <out>:
//   AI Assessment Report.xlsx      everything for the surveyor and dashboards
//   individual/<EmpID> - <Name>.html   one email-ready report per person
//   Mail merge.xlsx                one row per person for an Outlook mail merge
//
// Org file (optional): one row per employee, header row with "Employee ID" and
// any of: Name, Department, Project team, BU, Director, Manager, Tech lead.
// Several project teams can be separated with ";".

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { bank, rules, LEVELS, CRITERIA_LABELS, loadResults, score, decide, toCount, statusText, median } = require("./lib.js");
const { renderIndividual } = require("./individual.js");
const history = require("./history.js");

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  return o;
}
const norm = s => String(s || "").toLowerCase().replace(/[“”"’']/g, "").replace(/\s+/g, " ").trim();

// ---------- judgements ----------
function loadJudgements(dir) {
  const all = {}, problems = [];
  if (!fs.existsSync(dir)) return { all, problems: [`No judgements folder: ${dir}`] };
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    let list;
    try { list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch (e) { problems.push(`${f}: not valid JSON (${e.message})`); continue; }
    if (!Array.isArray(list)) { problems.push(`${f}: must be a JSON array`); continue; }
    for (const j of list) {
      if (!j || !j.key) { problems.push(`${f}: an item has no "key"`); continue; }
      if (all[j.key]) problems.push(`${f}: ${j.key} judged twice; the later one is used`);
      all[j.key] = j;
    }
  }
  return { all, problems };
}

function validate(batchesDir, judgements) {
  const problems = [];
  if (!fs.existsSync(batchesDir)) return ["No batches found. Run assessment/prepare.js first."];
  for (const f of fs.readdirSync(batchesDir).filter(f => f.endsWith(".json")).sort()) {
    const { items } = JSON.parse(fs.readFileSync(path.join(batchesDir, f), "utf8"));
    for (const it of items) {
      const j = judgements[it.key];
      if (!j) { problems.push(`${f}: ${it.key} has no judgement`); continue; }
      const must = Object.keys(it.criteria);
      for (const c of must) {
        const k = j.criteria && j.criteria[c];
        if (!k || typeof k.met !== "boolean") { problems.push(`${it.key}: criterion ${c} missing or "met" is not true/false`); continue; }
        if (k.met) {
          if (!k.quote) problems.push(`${it.key}: ${c} is met but has no quote`);
          else {
            const text = norm(`${it.example} ${it.followupQuestion} ${it.followupAnswer}`);
            const parts = norm(k.quote).split(/\s*(?:…|\.\.\.)\s*/).filter(Boolean);
            if (!parts.every(p => text.includes(p))) problems.push(`${it.key}: ${c} quote is not in the example text: "${k.quote}"`);
          }
        }
      }
      if (typeof j.lowerLevel !== "boolean") problems.push(`${it.key}: "lowerLevel" must be true or false`);
      if (!j.reason) problems.push(`${it.key}: "reason" is empty`);
      const d = decide(it.level, j);
      if (d.decision !== "Meets" && !j.improve) problems.push(`${it.key}: "improve" is needed when the decision is ${d.decision}`);
    }
  }
  return problems;
}

// ---------- org file ----------
async function loadOrg(file) {
  if (!file) return null;
  let rows = [];
  if (/\.csv$/i.test(file)) {
    const lines = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
    const parse = l => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); };
    const head = parse(lines[0]);
    rows = lines.slice(1).map(l => Object.fromEntries(parse(l).map((v, i) => [head[i], v])));
  } else {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0]; const head = ws.getRow(1).values.map(v => String(v ?? "").trim());
    ws.eachRow((r, i) => { if (i > 1) { const o = {}; head.forEach((h, c) => { if (h) o[h] = String(r.getCell(c).text ?? "").trim(); }); rows.push(o); } });
  }
  const key = Object.keys(rows[0] || {}).find(k => /^employee\s*id$/i.test(k));
  if (!key) throw new Error(`Org file needs an "Employee ID" column: ${file}`);
  const pick = (o, name) => { const k = Object.keys(o).find(x => x.toLowerCase().replace(/\s+/g, "") === name.toLowerCase().replace(/\s+/g, "")); return k ? o[k] : ""; };
  const byId = new Map();
  for (const o of rows) {
    const id = String(o[key] || "").trim().toLowerCase();
    if (!id) continue;
    byId.set(id, {
      name: pick(o, "Name"), department: pick(o, "Department"), bu: pick(o, "BU"), director: pick(o, "Director"),
      manager: pick(o, "Manager"), techLead: pick(o, "Tech lead"),
      projectTeams: pick(o, "Project team").split(";").map(s => s.trim()).filter(Boolean)
    });
  }
  return byId;
}

// ---------- groups ----------
function groupStats(members, size) {
  const n = members.length;
  const levels = members.map(m => m.r.conf.level);
  const enough = n >= rules.groups.minPeopleForGroupLevel && (!size || n / size >= rules.groups.minCoverageForGroupLevel);
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  return {
    people: n, size: size || "", coverage: size ? n / size : "",
    groupLevel: enough ? median(levels) : "Not enough responses",
    groupScore: n ? Math.round(avg(members.map(m => m.r.conf.score)) * 10) / 10 : "",
    spread: [0, ...LEVELS].map(L => levels.filter(l => l === L).length),
    adoption: n ? levels.filter(l => l >= 3).length / n : 0,
    advanced: n ? levels.filter(l => l >= 5).length / n : 0,
    multipliers: levels.filter(l => l >= 6).length,
    cross: n ? avg(members.map(m => m.r.crossScore)) : 0
  };
}

// ---------- Excel helpers ----------
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
function sheet(wb, name, columns, rows, { widths = {}, wrap = [], pct = [] } = {}) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map(c => ({ header: c, key: c, width: widths[c] || Math.min(40, Math.max(10, c.length + 2)) }));
  rows.forEach(r => ws.addRow(r));
  const h = ws.getRow(1); h.font = { bold: true, color: { argb: "FFFFFFFF" } }; h.fill = HEAD_FILL; h.alignment = { vertical: "middle", wrapText: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  wrap.forEach(c => { ws.getColumn(c).alignment = { wrapText: true, vertical: "top" }; });
  pct.forEach(c => { ws.getColumn(c).numFmt = "0%"; });
  return ws;
}
const safeFile = s => String(s).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);

async function main() {
  const o = args();
  if (!o.in) { console.error("Usage: node assessment/report.js --in <results.xlsx> [--org <org file>] [--out assessment/out] [--check]"); process.exit(1); }
  const out = path.resolve(o.out || path.join(__dirname, "out"));
  const { all: judgements, problems: loadProblems } = loadJudgements(path.join(out, "judgements"));
  const problems = [...loadProblems, ...validate(path.join(out, "batches"), judgements)];
  if (problems.length) {
    console.log(`Judgement problems (${problems.length}):`); problems.forEach(p => console.log("  - " + p));
    if (o.check || !o.force) { console.log(o.check ? "" : "Fix these, or run again with --force to report them as Not assessed."); process.exit(o.check ? 0 : 1); }
  } else console.log("Judgements: all present and valid.");
  if (o.check) return;

  const { people, skipped, cycle } = await loadResults(path.resolve(o.in));
  const org = await loadOrg(o.org ? path.resolve(o.org) : null);
  const notInOrg = [];
  const results = people.map(p => {
    const m = org ? org.get(p.empId.trim().toLowerCase()) : null;
    if (org && !m) notInOrg.push(p);
    const info = m || { department: "", bu: "", director: "", manager: "", techLead: "", projectTeams: [] };
    if (info.department) p.department = info.department;
    return { p, org: info, r: score(p, judgements) };
  });

  // Trend against the previous cycle (history/ snapshots)
  const histDir = path.resolve(o["history-dir"] || path.join(__dirname, "history"));
  const prev = o["no-trend"] ? null : history.findPrevious(histDir, cycle, o.previous);
  const trends = prev ? history.personTrends(results, prev) : [];
  const trendById = new Map(trends.map(t => [String(t.empId).toLowerCase(), t]));
  const rulesNote = prev && prev.rulesVersion !== rules.version
    ? `Rules changed from version ${prev.rulesVersion} to ${rules.version}: some change may come from the rules, not from people.` : "";

  fs.mkdirSync(path.join(out, "individual"), { recursive: true });
  const wb = new ExcelJS.Workbook(); wb.creator = "AI adoption assessment";
  const levelName = l => rules.levelNames[l];

  // Summary
  const orgStats = groupStats(results, org ? org.size : 0);
  const evAll = results.flatMap(x => x.r.practices.filter(p => p.needsProof && p.claimed));
  const dec = d => evAll.filter(p => (p.decision ? p.decision.decision : "Not assessed") === d).length;
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ width: 40 }, { width: 18 }, { width: 12 }];
  const t = sum.addRow(["AI adoption assessment"]); t.font = { bold: true, size: 16, color: { argb: "FF1F3864" } };
  [["Cycle", cycle], ["Generated", new Date().toLocaleString()], ["Source file", path.resolve(o.in)], ["Org file", o.org ? path.resolve(o.org) : "Not provided"],
   ["People assessed", results.length], ["Left out (deleted, superseded, test)", skipped.length], ["Org headcount", org ? org.size : "—"],
   ["Coverage", org ? orgStats.coverage : "—"], ["Organisation level (median)", orgStats.groupLevel], ["Organisation score (average)", orgStats.groupScore],
   ["Adoption (Level 3+)", orgStats.adoption], ["Advanced (Level 5+)", orgStats.advanced], ["Multipliers (Level 6+)", orgStats.multipliers],
   ["Cross-role score (10 common questions)", orgStats.cross], ["Examples: Meets", dec("Meets")], ["Examples: Needs more evidence", dec("Needs more evidence")],
   ["Examples: Does not meet", dec("Does not meet")], ["Examples: Not assessed", dec("Not assessed")],
   ["People with flags", results.filter(x => x.r.flags.length).length], ["Respondents not in the org file", org ? notInOrg.length : "—"],
   ["Rules version", rules.version],
   ["Compared with cycle", prev ? `${prev.cycle} (rules ${prev.rulesVersion})` : "No earlier cycle found"],
   ...(prev ? [["Organisation level then → now", `${groupStats(history.membersFromSnapshot(prev), 0).groupLevel} → ${orgStats.groupLevel}`],
     ["Organisation score then → now", `${groupStats(history.membersFromSnapshot(prev), 0).groupScore} → ${orgStats.groupScore}`],
     ["People up / same / down", `${trends.filter(t => t.status === "Up").length} / ${trends.filter(t => t.status === "Same").length} / ${trends.filter(t => t.status === "Down").length}`],
     ["New this cycle / not in this cycle", `${trends.filter(t => t.status === "New").length} / ${trends.filter(t => t.status === "Not in this cycle").length}`]] : []),
   ...(rulesNote ? [["Note", rulesNote]] : [])]
    .forEach(([k, v]) => { const r = sum.addRow([k, v]); r.getCell(1).font = { bold: true }; if (typeof v === "number" && v > 0 && v < 1) r.getCell(2).numFmt = "0%"; });
  sum.addRow([]);
  const sh = sum.addRow(["Level", "People", "Share"]); sh.font = { bold: true };
  [0, ...LEVELS].forEach((L, i) => { const r = sum.addRow([`${L} ${levelName(L)}`, orgStats.spread[i], results.length ? orgStats.spread[i] / results.length : 0]); r.getCell(3).numFmt = "0%"; });

  // Individuals
  const indiv = results.map(({ p, org: g, r }) => {
    const nl = r.nextLevel, evs = r.practices.filter(x => x.needsProof && x.claimed);
    const row = {
      "Employee ID": p.empId, Name: p.name, Email: p.email, "Team role": p.teamRole, Role: p.role, Department: p.department,
      "Project team": g.projectTeams.join("; "), BU: g.bu, Director: g.director, Manager: g.manager, "Tech lead": g.techLead,
      "Confirmed level": r.conf.level, "Level name": levelName(r.conf.level), Score: r.conf.score,
      "Level from answers": r.self.level, "Next level": nl ? nl.level : "Top",
      "Next level: you have": nl ? nl.have.map(x => x.useCase).join("; ") : "",
      "Next level: complete at least": nl ? nl.stillNeeded : "",
      "Next level: from": nl ? nl.missing.map(x => x.useCase).join("; ") : "",
      Closest: nl && nl.missing[0] ? nl.missing[0].useCase : "",
      "Examples meet": evs.filter(x => x.decision && x.decision.decision === "Meets").length,
      "Examples need more": evs.filter(x => x.decision && x.decision.decision === "Needs more evidence").length,
      "Examples do not meet": evs.filter(x => x.decision && x.decision.decision === "Does not meet").length,
      Flags: r.flags.join("; "), "Cross-role score": r.crossScore, "Submission ID": p.submissionId, "Submitted at (UTC)": p.submittedAt
    };
    r.conf.per.forEach(x => { row[`L${x.level} (needs ${x.needed} of ${x.total})`] = x.count; });
    return row;
  });
  const lvCols = LEVELS.map(L => { const x = results[0] && results[0].r.conf.per[L - 1]; return `L${L} (needs ${x ? x.needed : "?"} of ${x ? x.total : "?"})`; });
  sheet(wb, "Individuals", ["Employee ID", "Name", "Email", "Team role", "Role", "Department", "Project team", "BU", "Director", "Manager", "Tech lead",
    "Confirmed level", "Level name", "Score", "Level from answers", ...lvCols, "Next level", "Next level: you have", "Next level: complete at least", "Next level: from", "Closest",
    "Examples meet", "Examples need more", "Examples do not meet", "Flags", "Cross-role score", "Submission ID", "Submitted at (UTC)"], indiv,
    { widths: { Name: 24, Email: 30, "Team role": 22, Role: 22, "Next level: you have": 40, "Next level: from": 50 }, pct: ["Cross-role score"] });

  // Next steps (one row per missing practice at the next level)
  sheet(wb, "Next steps", ["Employee ID", "Name", "Role", "Next level", "Practice", "Status", "What would make it count"],
    results.flatMap(({ p, r }) => r.nextLevel ? [...r.nextLevel.have, ...r.nextLevel.missing].map(x => ({
      "Employee ID": p.empId, Name: p.name, Role: p.role, "Next level": `${r.nextLevel.level} ${r.nextLevel.name}`, Practice: x.useCase,
      Status: x.confirmed ? "In place" : statusText(x), "What would make it count": toCount(x)
    })) : []), { widths: { Name: 24, Practice: 34, Status: 44, "What would make it count": 70 }, wrap: ["Status", "What would make it count"] });

  // Evidence
  const evRows = results.flatMap(({ p, r }) => r.practices.filter(x => x.needsProof && x.claimed).map(x => {
    const j = x.judgement || {}, crit = rules.evidenceCriteria[x.level];
    const row = { "Employee ID": p.empId, Name: p.name, Role: p.role, "Question ID": x.id, Level: x.level, Practice: x.useCase, Answer: x.answer,
      Decision: x.decision ? x.decision.decision : "Not assessed", "Lower-level use": j.qualityRejected ? "" : j.lowerLevel ? "Yes" : "",
      Reason: j.reason || "", "To improve": j.improve || "", Example: x.evidence ? x.evidence.example : "",
      "Follow-up answer": x.evidence ? x.evidence.followupA : "" };
    crit.forEach((c, i) => { const k = (j.criteria || {})[c] || {}; row[`Check ${i + 1}`] = `${k.met ? "✓" : "✗"} ${CRITERIA_LABELS[c]}${k.met && k.quote ? `: “${k.quote}”` : ""}`; });
    const ex = rules.evidenceExtraForE[x.level]; const ek = (j.extra || {})[ex];
    row["Extra for E"] = x.answer === "E" ? `${ek && ek.met ? "✓" : "✗"} ${CRITERIA_LABELS[ex]}${ek && ek.met && ek.quote ? `: “${ek.quote}”` : ""}` : "";
    return row;
  }));
  sheet(wb, "Evidence", ["Employee ID", "Name", "Role", "Question ID", "Level", "Practice", "Answer", "Decision", "Check 1", "Check 2", "Check 3", "Check 4", "Extra for E",
    "Lower-level use", "Reason", "To improve", "Example", "Follow-up answer"], evRows,
    { widths: { Name: 22, Practice: 28, "Check 1": 36, "Check 2": 36, "Check 3": 36, "Check 4": 36, "Extra for E": 30, Reason: 50, "To improve": 50, Example: 70, "Follow-up answer": 40 },
      wrap: ["Check 1", "Check 2", "Check 3", "Check 4", "Extra for E", "Reason", "To improve", "Example", "Follow-up answer"] });

  // Practices (long form, for dashboards)
  sheet(wb, "Practices", ["Employee ID", "Name", "Role", "Question ID", "Level", "Practice", "Answer", "Answer text", "Counts (answers)", "Counts (confirmed)"],
    results.flatMap(({ p, r }) => r.practices.map(x => ({ "Employee ID": p.empId, Name: p.name, Role: p.role, "Question ID": x.id, Level: x.level, Practice: x.useCase,
      Answer: x.answer, "Answer text": x.answerText, "Counts (answers)": x.claimed ? 1 : 0, "Counts (confirmed)": x.confirmed ? 1 : 0 }))),
    { widths: { Name: 22, Practice: 34, "Answer text": 44 } });

  // Groups
  const groupDefs = [
    ["Organisation", () => ["All"]], ["Role", x => [x.p.role]], ["Team role", x => [x.p.teamRole]], ["Department", x => [x.p.department]],
    ["Project team", x => x.org.projectTeams], ["BU", x => [x.org.bu]], ["Director", x => [x.org.director]], ["Manager", x => [x.org.manager]], ["Tech lead", x => [x.org.techLead]]
  ];
  const orgSizes = {};
  if (org) for (const [type, fn] of groupDefs) {
    orgSizes[type] = {};
    for (const [, m] of org) {
      const fake = { p: { role: "", teamRole: "", department: m.department }, org: m };
      const keys = type === "Organisation" ? ["All"] : ["Role", "Team role"].includes(type) ? [] : fn(fake);
      keys.filter(Boolean).forEach(k => { orgSizes[type][k] = (orgSizes[type][k] || 0) + 1; });
    }
  }
  const groupRows = [];
  for (const [type, fn] of groupDefs) {
    const map = new Map();
    results.forEach(x => fn(x).filter(Boolean).forEach(k => { if (!map.has(k)) map.set(k, []); map.get(k).push(x); }));
    for (const [k, members] of [...map].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      const s = groupStats(members, (orgSizes[type] || {})[k] || 0);
      const row = { "Group type": type, Group: k, People: s.people, "Group size": s.size, Coverage: s.coverage, "Group level": s.groupLevel,
        "Level name": typeof s.groupLevel === "number" ? levelName(s.groupLevel) : "", "Group score": s.groupScore,
        "Adoption (L3+)": s.adoption, "Advanced (L5+)": s.advanced, "Multipliers (L6+)": s.multipliers, "Cross-role score": s.cross };
      [0, ...LEVELS].forEach((L, i) => { row[`L${L}`] = s.spread[i]; });
      groupRows.push(row);
    }
  }
  sheet(wb, "Groups", ["Group type", "Group", "People", "Group size", "Coverage", "Group level", "Level name", "Group score", "Adoption (L3+)", "Advanced (L5+)",
    "Multipliers (L6+)", "Cross-role score", "L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"], groupRows,
    { widths: { Group: 30, "Group level": 20 }, pct: ["Coverage", "Adoption (L3+)", "Advanced (L5+)", "Cross-role score"] });

  // Gap map: share of people for whom each practice counts
  const gap = new Map();
  results.forEach(({ r }) => r.practices.forEach(x => {
    const k = x.id; if (!gap.has(k)) gap.set(k, { "Question ID": x.id, Level: x.level, Practice: x.useCase, Role: x.id.startsWith("CR-") ? "All roles" : bank.questionnaires[x.id.split("-")[0]] ? bank.questionnaires[x.id.split("-")[0]].name : "", n: 0, a: 0, c: 0 });
    const g = gap.get(k); g.n++; g.a += x.claimed ? 1 : 0; g.c += x.confirmed ? 1 : 0;
  }));
  sheet(wb, "Gap map", ["Role", "Level", "Question ID", "Practice", "People asked", "Counts (answers)", "Counts (confirmed)"],
    [...gap.values()].sort((a, b) => a.Role.localeCompare(b.Role) || a.Level - b.Level).map(g => ({ ...g, "People asked": g.n, "Counts (answers)": g.n ? g.a / g.n : 0, "Counts (confirmed)": g.n ? g.c / g.n : 0 })),
    { widths: { Role: 24, Practice: 40 }, pct: ["Counts (answers)", "Counts (confirmed)"] });

  // Flags, left out, method
  sheet(wb, "Flags", ["Employee ID", "Name", "Role", "Flags", "Confirmed level", "Level from answers"],
    results.filter(x => x.r.flags.length).map(({ p, r }) => ({ "Employee ID": p.empId, Name: p.name, Role: p.role, Flags: r.flags.join("; "), "Confirmed level": r.conf.level, "Level from answers": r.self.level })),
    { widths: { Name: 24, Flags: 40 } });
  sheet(wb, "Left out", ["Name", "Reason"], [...skipped.map(s => ({ Name: s.name, Reason: s.reason })), ...notInOrg.map(p => ({ Name: p.name, Reason: `Assessed, but employee ID ${p.empId} is not in the org file (no team, BU or manager)` }))], { widths: { Name: 30, Reason: 70 } });
  // Trend sheets (only when an earlier cycle exists)
  if (prev) {
    sheet(wb, "Trend people", ["Employee ID", "Name", "Role", `Level ${prev.cycle}`, `Level ${cycle}`, "Change", `Score ${prev.cycle}`, `Score ${cycle}`, "Score change", "Status", "Practices gained", "Practices lost", "Role changed from"],
      trends.map(t => ({ "Employee ID": t.empId, Name: t.name, Role: t.role, [`Level ${prev.cycle}`]: t.prevLevel, [`Level ${cycle}`]: t.level, Change: t.change,
        [`Score ${prev.cycle}`]: t.prevScore, [`Score ${cycle}`]: t.score, "Score change": t.scoreChange, Status: t.status,
        "Practices gained": t.gained.join("; "), "Practices lost": t.lost.join("; "), "Role changed from": t.roleChanged || "" })),
      { widths: { Name: 24, Role: 22, "Practices gained": 50, "Practices lost": 50 }, wrap: ["Practices gained", "Practices lost"] });
    const before = history.membersFromSnapshot(prev);
    const tRows = [];
    for (const [type, fn] of groupDefs) {
      const now = new Map(), then = new Map();
      results.forEach(x => fn(x).filter(Boolean).forEach(k => { if (!now.has(k)) now.set(k, []); now.get(k).push(x); }));
      before.forEach(x => fn(x).filter(Boolean).forEach(k => { if (!then.has(k)) then.set(k, []); then.get(k).push(x); }));
      for (const k of [...new Set([...now.keys(), ...then.keys()])].sort()) {
        const a = then.has(k) ? groupStats(then.get(k), 0) : null, b = now.has(k) ? groupStats(now.get(k), 0) : null;
        const num = v => (typeof v === "number" ? v : null);
        tRows.push({ "Group type": type, Group: k,
          [`People ${prev.cycle}`]: a ? a.people : 0, [`People ${cycle}`]: b ? b.people : 0,
          [`Level ${prev.cycle}`]: a ? a.groupLevel : "", [`Level ${cycle}`]: b ? b.groupLevel : "",
          "Level change": a && b && num(a.groupLevel) !== null && num(b.groupLevel) !== null ? b.groupLevel - a.groupLevel : "",
          [`Score ${prev.cycle}`]: a ? a.groupScore : "", [`Score ${cycle}`]: b ? b.groupScore : "",
          "Score change": a && b && a.people && b.people ? Math.round((b.groupScore - a.groupScore) * 10) / 10 : "",
          [`Adoption ${prev.cycle}`]: a ? a.adoption : "", [`Adoption ${cycle}`]: b ? b.adoption : "",
          [`Multipliers ${prev.cycle}`]: a ? a.multipliers : "", [`Multipliers ${cycle}`]: b ? b.multipliers : "" });
      }
    }
    sheet(wb, "Trend groups", Object.keys(tRows[0] || { "Group type": 1 }), tRows,
      { widths: { Group: 30 }, pct: [`Adoption ${prev.cycle}`, `Adoption ${cycle}`] });
  }

  const method = wb.addWorksheet("Method"); method.getColumn(1).width = 120;
  ["How levels are decided (full rules in assessment/RUBRIC.md)",
   "A practice counts at C or higher for Levels 1–2 and D or higher for Levels 3–7.",
   "A level is reached when at least half of its practices count: 1 of 2, 2 of 3, 3 of 6, 2 of 4. A person's level is the highest level reached without skipping a step.",
   "At Levels 5–7 a practice counts for the confirmed level only when its example meets all 4 checks for its level. 3 of 4 = Needs more evidence (not counted).",
   "Score = level + share of the next level's practices already in place.",
   "Group level = the level at least half the group has reached (median). Shown only with at least 5 people and, when group sizes are known, 60% coverage."]
    .forEach((s, i) => { const r = method.addRow([s]); if (i === 0) r.font = { bold: true }; r.alignment = { wrapText: true }; });

  await wb.xlsx.writeFile(path.join(out, "AI Assessment Report.xlsx"));

  // Individual reports and mail merge
  const mm = [];
  for (const { p, r } of results) {
    const file = `${safeFile(p.empId)} - ${safeFile(p.name)}.html`;
    const tr = trendById.get(p.empId.toLowerCase());
    const trend = tr && tr.status !== "New" ? { cycle: prev.cycle, prevLevel: tr.prevLevel, change: tr.change, prevScore: tr.prevScore } : null;
    fs.writeFileSync(path.join(out, "individual", file), renderIndividual(p, r, { cycle, contact: true, trend }));
    const nl = r.nextLevel;
    mm.push({
      Email: p.email, Name: p.name, Subject: `Your AI adoption check-in result – ${cycle}`, Level: `Level ${r.conf.level} – ${levelName(r.conf.level)}`, Score: r.conf.score,
      "Next step": nl ? `To reach Level ${nl.level} – ${nl.name}, complete at least ${nl.stillNeeded} of: ${nl.missing.map(x => x.useCase).join("; ")}.` : "You have reached the top level.",
      "Report file": path.join(out, "individual", file)
    });
  }
  const mwb = new ExcelJS.Workbook();
  sheet(mwb, "Mail merge", ["Email", "Name", "Subject", "Level", "Score", "Next step", "Report file"], mm, { widths: { Email: 30, Name: 24, Subject: 44, Level: 24, "Next step": 80, "Report file": 70 }, wrap: ["Next step"] });
  await mwb.xlsx.writeFile(path.join(out, "Mail merge.xlsx"));

  console.log(`People assessed: ${results.length} (left out ${skipped.length})`);
  console.log(`Levels: ${[0, ...LEVELS].map((L, i) => `L${L} ${orgStats.spread[i]}`).join(" · ")}`);
  console.log(`Examples: Meets ${dec("Meets")}, Needs more evidence ${dec("Needs more evidence")}, Does not meet ${dec("Does not meet")}, Not assessed ${dec("Not assessed")}`);
  if (org) console.log(`Not in org file: ${notInOrg.length}`);
  console.log(`Wrote: ${path.join(out, "AI Assessment Report.xlsx")}`);
  console.log(`Wrote: ${results.length} reports in ${path.join(out, "individual")}`);
  console.log(`Wrote: ${path.join(out, "Mail merge.xlsx")}`);
  if (prev) console.log(`Trend vs ${prev.cycle}: up ${trends.filter(t => t.status === "Up").length}, same ${trends.filter(t => t.status === "Same").length}, down ${trends.filter(t => t.status === "Down").length}, new ${trends.filter(t => t.status === "New").length}, not in this cycle ${trends.filter(t => t.status === "Not in this cycle").length}${rulesNote ? ". " + rulesNote : ""}`);
  else console.log("Trend: no earlier cycle in history yet; this run becomes the baseline.");
  if (!o["no-save"]) console.log(`Saved this cycle for future trends: ${history.save(histDir, history.snapshot(cycle, results))}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
