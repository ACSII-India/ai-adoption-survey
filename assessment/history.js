"use strict";
// Cycle history and trends. Each assessment run saves a snapshot of every
// person's result; the next run compares with the latest earlier cycle.
// Snapshots hold personal data: assessment/history/ is kept out of git.

const fs = require("fs");
const path = require("path");
const { rules } = require("./lib.js");

const slug = s => String(s || "cycle").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cycle";

function snapshot(cycle, results) {
  return {
    cycle, rulesVersion: rules.version, generatedAt: new Date().toISOString(),
    people: results.map(({ p, org, r }) => ({
      empId: p.empId, name: p.name, role: p.role, teamRole: p.teamRole, department: p.department,
      projectTeams: org.projectTeams, bu: org.bu, director: org.director, manager: org.manager, techLead: org.techLead,
      level: r.conf.level, score: r.conf.score, selfLevel: r.self.level, crossScore: r.crossScore,
      practices: Object.fromEntries(r.practices.map(x => [x.id, x.confirmed ? 1 : 0]))
    }))
  };
}

function save(dir, snap) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(snap.cycle)}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}

// The snapshot to compare with: --previous <file or cycle name>, otherwise the
// most recent snapshot from a different cycle.
function findPrevious(dir, cycle, previous) {
  if (previous) {
    const f = fs.existsSync(previous) ? previous : path.join(dir, `${slug(previous)}.json`);
    if (!fs.existsSync(f)) throw new Error(`Previous cycle not found: ${previous} (looked for ${f})`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  if (!fs.existsSync(dir)) return null;
  const snaps = fs.readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter(s => s.cycle !== cycle)
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return snaps[0] || null;
}

// Per-person changes: Up, Down, Same, New, Not in this cycle.
function personTrends(results, prev) {
  const before = new Map(prev.people.map(x => [String(x.empId).toLowerCase(), x]));
  const seen = new Set();
  const rows = results.map(({ p, r }) => {
    const id = p.empId.toLowerCase(); seen.add(id);
    const b = before.get(id);
    if (!b) return { empId: p.empId, name: p.name, role: p.role, prevLevel: "", level: r.conf.level, change: "", prevScore: "", score: r.conf.score, scoreChange: "", status: "New", gained: [], lost: [] };
    const cur = Object.fromEntries(r.practices.map(x => [x.id, x.confirmed ? 1 : 0]));
    const names = Object.fromEntries(r.practices.map(x => [x.id, x.useCase]));
    const gained = Object.keys(cur).filter(k => cur[k] && !b.practices[k]).map(k => names[k]);
    const lost = Object.keys(cur).filter(k => !cur[k] && b.practices[k]).map(k => names[k]);
    const change = r.conf.level - b.level;
    return { empId: p.empId, name: p.name, role: p.role, prevLevel: b.level, level: r.conf.level, change,
      prevScore: b.score, score: r.conf.score, scoreChange: Math.round((r.conf.score - b.score) * 10) / 10,
      status: change > 0 ? "Up" : change < 0 ? "Down" : "Same", gained, lost, roleChanged: b.role !== p.role ? b.role : "" };
  });
  for (const [id, b] of before) if (!seen.has(id)) rows.push({ empId: b.empId, name: b.name, role: b.role, prevLevel: b.level, level: "", change: "", prevScore: b.score, score: "", scoreChange: "", status: "Not in this cycle", gained: [], lost: [] });
  return rows;
}

// Members in the shape groupStats() expects, rebuilt from a snapshot.
function membersFromSnapshot(prev) {
  return prev.people.map(x => ({
    p: { role: x.role, teamRole: x.teamRole, department: x.department },
    org: { projectTeams: x.projectTeams || [], bu: x.bu, director: x.director, manager: x.manager, techLead: x.techLead },
    r: { conf: { level: x.level, score: x.score }, crossScore: x.crossScore || 0 }
  }));
}

module.exports = { snapshot, save, findPrevious, personTrends, membersFromSnapshot, slug };
