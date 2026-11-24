"use strict";
// Employee list for the first screen: a person enters their Employee ID (or,
// on probation without one, their work email) and their name, email and role
// come from here. Source: the standard master sheet
// (mis-dashboard/docs/ACSII_Employee_Master_Standard.xlsx), sent by the backup
// job (scripts/sync-people.js) and kept in PEOPLE_PATH.

const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");
const bank = require("../data/questions.json");

let list = [], byId = new Map(), byEmail = new Map(), hash = "";

const ID_RE = /^[A-Za-z0-9._-]{2,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Master sheet role -> survey team role -> questionnaire.
function roleFor(masterRole) {
  const r = String(masterRole || "").trim();
  const teamRole = (bank.roleAliases || {})[r] || r;
  const m = bank.roleMap.find(x => x.teamRole === teamRole);
  return m ? { teamRole: m.teamRole, qset: m.questionnaire } : null;
}

// People on probation have no Employee ID yet: their results are recorded
// under a stand-in ID made from their email, the same every time.
const probationId = email => "PROB-" + email.split("@")[0].replace(/[^A-Za-z0-9._-]/g, "").slice(0, 34);

function load(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error("a list of people is required");
  const out = [], ids = new Map(), emails = new Map(), problems = [];
  for (const r of rows) {
    const p = {
      empId: String(r.empId || "").trim(), name: String(r.name || "").trim().slice(0, 100),
      email: String(r.email || "").trim().toLowerCase().slice(0, 200), role: String(r.role || "").trim().slice(0, 80),
      // Personal check-in code: only a salted fingerprint is kept here (scripts/checkin-codes.js).
      codeSalt: String(r.codeSalt || "").slice(0, 64), codeHash: String(r.codeHash || "").slice(0, 128)
    };
    if (!p.name || !EMAIL_RE.test(p.email)) { problems.push(`${p.name || "?"}: name or email missing`); continue; }
    if (p.empId && !ID_RE.test(p.empId)) { problems.push(`${p.name}: Employee ID "${p.empId}" not valid`); continue; }
    const role = roleFor(p.role);
    if (!role) { problems.push(`${p.name}: role "${p.role}" has no questionnaire`); continue; }
    Object.assign(p, role);
    if (p.empId) ids.set(p.empId.toUpperCase(), p);
    emails.set(p.email, p);
    out.push(p);
  }
  list = out; byId = ids; byEmail = emails;
  hash = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return { count: out.length, problems };
}

function save(rows) {
  const r = load(rows);
  try { fs.writeFileSync(config.peoplePath, JSON.stringify(rows), { mode: 0o600 }); } catch (e) { console.error("people list not saved:", e.message); }
  return r;
}

try {
  if (fs.existsSync(config.peoplePath)) { const r = load(JSON.parse(fs.readFileSync(config.peoplePath, "utf8"))); console.log(`employee list loaded: ${r.count} people`); }
} catch (e) { console.error("employee list could not be read:", e.message); }

// Masks the email for the screen: ych•••@acsi-india.org
const mask = email => { const [u, d] = email.split("@"); return `${u.slice(0, 3)}•••@${d}`; };

// "14", "014", "ACSIT14" and "ACSIT-014" all mean ACSIT-014: a number on its own gets the ACSIT- prefix.
const normId = id => { const v = String(id || "").trim().toUpperCase(), m = /^(?:ACSIT[-\s]?)?(\d{1,4})$/.exec(v); return m ? "ACSIT-" + m[1].padStart(3, "0") : v; };
const findById = id => byId.get(normId(id)) || null;
// Email lookup is only for people without an Employee ID.
const findProbation = email => { const p = byEmail.get(String(email || "").trim().toLowerCase()); return p && !p.empId ? p : null; };
const hasId = email => { const p = byEmail.get(String(email || "").trim().toLowerCase()); return !!(p && p.empId); };

// Check-in codes: required as soon as any person on the list has one.
// Codes are typed without the dash and in any case: "k7q4mx" = "K7Q-4MX".
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const codeFingerprint = (salt, code) => crypto.createHash("sha256").update(`${salt}:${normCode(code)}`).digest("hex");
const requiresCode = () => list.some(p => p.codeHash);
function codeOk(p, code) {
  if (!p.codeHash) return false;
  const a = Buffer.from(codeFingerprint(p.codeSalt, code)), b = Buffer.from(p.codeHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// What the server records for this person (never what the browser sent).
const profileOf = p => ({ name: p.name, empId: p.empId || probationId(p.email), email: p.email, teamRole: p.teamRole, qset: p.qset, probation: !p.empId });

module.exports = { load: save, loaded: () => list.length > 0, status: () => ({ count: list.length, hash, withCode: list.filter(p => p.codeHash).length }), findById, findProbation, hasId, profileOf, mask, requiresCode, codeOk, codeFingerprint, normCode };
