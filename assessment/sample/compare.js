"use strict";
// Compares a run's judgements with the reference judgements for the sample
// data: agreement per check, per decision and per final level.
//
//   node assessment/sample/compare.js --out <run out dir> --in backup/sample_data.xlsx [--reference assessment/sample/reference-judgements.json]

const fs = require("fs");
const path = require("path");
const { rules, CRITERIA_LABELS, loadResults, score, decide } = require("../lib.js");

const a = process.argv.slice(2), o = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1];
if (!o.out || !o.in) { console.error("Usage: node assessment/sample/compare.js --out <run out dir> --in <results file>"); process.exit(1); }

const load = dir => Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith(".json"))
  .flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).map(j => [j.key, j]));
const run = load(path.resolve(o.out, "judgements"));
const ref = Object.fromEntries(JSON.parse(fs.readFileSync(path.resolve(o.reference || path.join(__dirname, "reference-judgements.json")), "utf8")).map(j => [j.key, j]));
const quality = JSON.parse(fs.readFileSync(path.resolve(o.out, "judgements", "quality-filter.json"), "utf8")).map(j => j.key);

(async () => {
  const { people } = await loadResults(path.resolve(o.in));
  const items = people.flatMap(p => p.evidence.map(e => ({ p, e }))).filter(({ e }) => ref[e.key] && !quality.includes(e.key));
  let checks = 0, checksSame = 0, decSame = 0, lowerSame = 0;
  const perCrit = {}, diffs = [];
  for (const { e } of items) {
    const r = ref[e.key], m = run[e.key];
    if (!m) { diffs.push(`${e.key}: not judged in this run`); continue; }
    for (const c of rules.evidenceCriteria[e.level]) {
      const rv = !!(r.criteria[c] && r.criteria[c].met), mv = !!(m.criteria && m.criteria[c] && m.criteria[c].met);
      checks++; perCrit[c] = perCrit[c] || { n: 0, same: 0 }; perCrit[c].n++;
      if (rv === mv) { checksSame++; perCrit[c].same++; } else diffs.push(`${e.key} ${CRITERIA_LABELS[c]}: reference ${rv ? "✓" : "✗"}, run ${mv ? "✓" : "✗"}${m.criteria && m.criteria[c] && m.criteria[c].quote ? ` (quote: "${m.criteria[c].quote}")` : ""}`);
    }
    if (!!r.lowerLevel === !!m.lowerLevel) lowerSame++; else diffs.push(`${e.key} lower-level use: reference ${!!r.lowerLevel}, run ${!!m.lowerLevel}`);
    const dr = decide(e.level, r).decision, dm = decide(e.level, m).decision;
    if (dr === dm) decSame++; else diffs.push(`${e.key} DECISION: reference ${dr}, run ${dm}`);
  }
  const qualityRows = JSON.parse(fs.readFileSync(path.resolve(o.out, "judgements", "quality-filter.json"), "utf8"));
  const allRef = { ...ref }; qualityRows.forEach(q => { allRef[q.key] = q; });
  const allRun = { ...run }; qualityRows.forEach(q => { allRun[q.key] = q; });
  let levelSame = 0; const levelDiffs = [];
  for (const p of people) {
    const lr = score(p, allRef).conf.level, lm = score(p, allRun).conf.level;
    if (lr === lm) levelSame++; else levelDiffs.push(`${p.empId} ${p.name}: reference Level ${lr}, run Level ${lm}`);
  }
  const pct = (x, n) => n ? `${Math.round(100 * x / n)}% (${x} of ${n})` : "—";
  console.log(`Examples compared: ${items.length} (plus ${quality.length} rejected by the quality filter, same in both)`);
  console.log(`Checks agree:      ${pct(checksSame, checks)}`);
  Object.entries(perCrit).forEach(([c, v]) => console.log(`  ${CRITERIA_LABELS[c].padEnd(26)} ${pct(v.same, v.n)}`));
  console.log(`Lower-level agree: ${pct(lowerSame, items.length)}`);
  console.log(`Decisions agree:   ${pct(decSame, items.length)}`);
  console.log(`Final levels agree: ${pct(levelSame, people.length)}`);
  if (levelDiffs.length) { console.log("Level differences:"); levelDiffs.forEach(d => console.log("  - " + d)); }
  if (diffs.length) { console.log("Judgement differences:"); diffs.forEach(d => console.log("  - " + d)); }
})().catch(e => { console.error(e.message); process.exit(1); });
