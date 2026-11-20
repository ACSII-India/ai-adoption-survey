"use strict";
// Step 1 of the assessment: read the results workbook, apply the quality
// filter (RUBRIC.md Part C) and write the examples Claude must judge into
// batch files.
//
//   node assessment/prepare.js --in <results.xlsx> [--out assessment/out] [--batch 20]
//
// Writes:
//   <out>/batches/batch-NN.json       examples for Claude to judge (no names or emails)
//   <out>/judgements/quality-filter.json  examples rejected automatically
//   <out>/manifest.json               counts and the list of batch files

const fs = require("fs");
const path = require("path");
const Scoring = require("../src/scoring.js");
const { bank, rules, LETTERS, CRITERIA_LABELS, loadResults, lookForLines, qualityCheck } = require("./lib.js");

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  return o;
}

const CRITERIA_TEXT = {
  TASK: "A specific piece of real work (what was done, on what), not a general statement",
  AGENTIC: "The AI carried out several steps or acted through tools, systems or data (agent, MCP, API, integration, pipeline), not only chat questions and answers",
  CHECKED: "How the person checked the output (tests, code review, diff review, comparing to source data, rules or validation, sign-off)",
  REPEATED: "Done more than once or ongoing (regularly, for every ticket, several times, each sprint, nightly)",
  REUSABLE: "A named reusable command, hook, template, workflow, connector or agent (only for answer E)",
  SHARED: "A named thing others can use: library, standard, checklist, playbook, guide, template, demo, training session, community",
  USERS: "Who uses it or attended: at least 2 colleagues, a named team, or a number of people",
  WHERE: "Where it lives or how it was delivered: repository, wiki or Confluence page, link, channel, session date or series",
  IMPACT: "What changed for others: adopted in reviews, fewer defects, faster onboarding, people now doing it themselves",
  STANDARD: "Adopted as a team standard: documented, required in reviews or onboarding, part of the definition of done (only for answer E)",
  BEFORE_AFTER: "How the process worked before and how it works now with AI, end to end, not one step sped up",
  ADOPTED: "Who runs the new process: the person's team or wider",
  MEASURED: "A measured result with a number (time, cost, volume, quality), ideally against a baseline",
  OWNED: "Who owns it, or the guardrails (approvals, monitoring, human review, policy)",
  BEYOND_TEAM: "Adopted beyond the team or across the organization (only for answer E)"
};

async function main() {
  const o = args();
  if (!o.in) { console.error("Usage: node assessment/prepare.js --in <results.xlsx> [--out assessment/out] [--batch 20]"); process.exit(1); }
  const out = path.resolve(o.out || path.join(__dirname, "out"));
  const size = Math.max(1, Number(o.batch) || 20);
  const loaded = await loadResults(path.resolve(o.in));
  // --only <id,id,...>: assess just these employee IDs (used by the automatic job).
  const only = o.only ? new Set(String(o.only).split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) : null;
  const people = only ? loaded.people.filter(p => only.has(p.empId.toLowerCase())) : loaded.people;
  const { skipped, cycle } = loaded;
  const lookFor = lookForLines();

  fs.rmSync(path.join(out, "batches"), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "batches"), { recursive: true });
  fs.mkdirSync(path.join(out, "judgements"), { recursive: true });

  const toJudge = [], rejected = [];
  for (const p of people) {
    for (const e of p.evidence) {
      // Only examples for answers that would count (D or E) can change a level.
      if (LETTERS.indexOf(e.answer) < LETTERS.indexOf(rules.practiceCountsAt[e.level])) continue;
      const q = qualityCheck(e);
      if (!q.ok) { rejected.push({ key: e.key, qualityRejected: true, reason: q.reason }); continue; }
      const must = rules.evidenceCriteria[e.level];
      const extra = e.answer === "E" ? rules.evidenceExtraForE[e.level] : null;
      toJudge.push({
        key: e.key, role: p.role, questionId: e.questionId, level: e.level,
        levelName: rules.levelNames[e.level], useCase: e.useCase, question: e.question,
        answer: e.answer, answerText: Scoring.scaleFor(bank, e.level)[LETTERS.indexOf(e.answer)],
        whatGoodLooksLike: lookFor[e.questionId] || "",
        criteria: Object.fromEntries(must.map(c => [c, `${CRITERIA_LABELS[c]}: ${CRITERIA_TEXT[c]}`])),
        extraForE: extra ? { [extra]: `${CRITERIA_LABELS[extra]}: ${CRITERIA_TEXT[extra]}` } : null,
        example: e.example, followupQuestion: e.followupQ, followupAnswer: e.followupA, link: e.link
      });
    }
  }

  const batches = [];
  for (let i = 0; i < toJudge.length; i += size) {
    const name = `batch-${String(batches.length + 1).padStart(2, "0")}`;
    fs.writeFileSync(path.join(out, "batches", name + ".json"), JSON.stringify({
      instructions: "Judge each item with assessment/RUBRIC.md Part B. Write the result to assessment/out/judgements/" + name + ".json as described in .claude/skills/ai-assessment/SKILL.md.",
      items: toJudge.slice(i, i + size)
    }, null, 2));
    batches.push(name);
  }
  fs.writeFileSync(path.join(out, "judgements", "quality-filter.json"), JSON.stringify(rejected, null, 2));
  const manifest = {
    preparedAt: new Date().toISOString(), source: path.resolve(o.in), cycle,
    people: people.length, skipped, examplesToJudge: toJudge.length, rejectedByQualityFilter: rejected.length, batches
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`People: ${people.length} (skipped ${skipped.length}: ${skipped.map(s => `${s.name} – ${s.reason}`).join("; ") || "none"})`);
  console.log(`Examples to judge: ${toJudge.length} in ${batches.length} batch(es): ${batches.join(", ") || "none"}`);
  console.log(`Rejected by the quality filter: ${rejected.length}`);
  console.log(`Next: judge each batch into ${path.join(out, "judgements")}/<batch>.json, then run assessment/report.js`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
