"use strict";
// Personal check-in codes: one random code per person on the standard master
// sheet, so only that person can take the check-in as themselves.
//
//   node scripts/checkin-codes.js                 give a code to everyone who has none, and build the send files
//   node scripts/checkin-codes.js --new ACSIT-014 a new code for one person (Employee ID, number or work email);
//                                                 the old one stops working at the next sync (within 10 minutes)
//   node scripts/checkin-codes.js --on | --off    start or stop asking for codes on the survey (after the codes
//                                                 are sent); takes effect at the next sync
//   node scripts/checkin-codes.js --on ACSIT-014  codes for the named people only (a test); everyone else
//                                                 continues without a code
//
// Codes live only in backup/checkin-codes.json (not in git, readable only by
// you). The survey receives a salted fingerprint of each code through
// scripts/sync-people.js, never the code itself.
// Send files go to "backup/check-in codes/": a mail merge (Excel + Word) for
// Outlook, and the individual messages (per person and per manager) for Teams.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "..");
const XLSX = process.env.PEOPLE_XLSX || path.join(ROOT, "..", "mis-dashboard", "docs", "ACSII_Employee_Master_Standard.xlsx");
const CODES = path.join(ROOT, "backup", "checkin-codes.json");
const OUT = path.join(ROOT, "backup", "check-in codes");
const SITE = "https://tech-adoption.onrender.com";
const OWNER = process.env.SURVEY_OWNER || "Satish Javalekar";
// Who signs the message and whom to contact for a lost code.
const TEAM = process.env.CODES_TEAM || "Central Function team";
// The mailbox the mail merge is sent from (shown under the sign-off).
const FROM = process.env.CODES_FROM || "asktech@acsi-india.org";
// No 0/O, 1/I/L: easy to read and type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => { let c = ""; for (let i = 0; i < 6; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)]; return c.slice(0, 3) + "-" + c.slice(3); };
const cellText = v => (v && typeof v === "object" ? (v.text || v.result || (v.richText || []).map(t => t.text).join("") || "") : String(v ?? "")).trim();
// "Patil, Mahesh N" -> "Mahesh"; "Deepak, O M" -> "Deepak"
function firstName(full) {
  const [last, given = ""] = String(full).split(",").map(s => s.trim());
  const g = given.split(/\s+/)[0] || "";
  return g.length > 1 ? g : last;
}

async function people() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet("Employees");
  const h = ws.getRow(1).values.map(cellText);
  const col = n => h.indexOf(n);
  const out = [];
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const v = n => cellText(r.getCell(col(n)).value);
    const p = { empId: v("Employee ID"), name: v("Full Name"), email: v("Work Email").toLowerCase(), role: v("Role"), manager: col("Reporting Manager") > 0 ? v("Reporting Manager") : "" };
    if (p.name && p.email) out.push(p);
  });
  return out;
}

const readCodes = () => { try { return JSON.parse(fs.readFileSync(CODES, "utf8")); } catch (_) { return {}; } };
const writeCodes = c => { fs.mkdirSync(path.dirname(CODES), { recursive: true }); fs.writeFileSync(CODES, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.chmodSync(CODES, 0o600); };

const signIn = p => p.empId
  ? `Enter your Employee ID (${p.empId}) and this code, then click Find me.`
  : `Click "I don't have an Employee ID yet", enter your work email (${p.email}) and this code, then click Find me.`;
const message = (p, code) => `Hi ${firstName(p.name)},

You're invited to the AI adoption check-in. It takes about 12 minutes.

Your personal check-in code is: ${code}

1. Open ${SITE}
2. ${signIn(p)}
3. Check your details and answer the questions.

Please keep this code to yourself: it makes sure only you can take the check-in as you. If you lose it, message the ${TEAM} on Microsoft Teams for a new one.

Thank you,
${TEAM}
${FROM}`;

async function buildFiles(list, codes) {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const rows = list.map(p => ({ ...p, code: codes[p.email].code, first: firstName(p.name) }));

  // 1. Mail merge data (Word reads the first sheet; column names without spaces work best).
  const mm = new ExcelJS.Workbook();
  const s1 = mm.addWorksheet("Mail merge");
  s1.columns = [
    { header: "Email", key: "email", width: 34 }, { header: "FirstName", key: "first", width: 14 }, { header: "FullName", key: "name", width: 28 },
    { header: "EmployeeID", key: "empId", width: 13 }, { header: "Code", key: "code", width: 10 }, { header: "SignIn", key: "signIn", width: 90 }, { header: "Manager", key: "manager", width: 24 }
  ];
  rows.forEach(r => s1.addRow({ ...r, empId: r.empId || "(on probation)", signIn: signIn(r) }));
  s1.getRow(1).font = { bold: true }; s1.views = [{ state: "frozen", ySplit: 1 }];
  await mm.xlsx.writeFile(path.join(OUT, "Check-in codes - mail merge data.xlsx"));

  // 2. Individual messages, for Teams: one per person, and the same codes by manager.
  const im = new ExcelJS.Workbook();
  const s2 = im.addWorksheet("Messages");
  s2.columns = [{ header: "Name", key: "name", width: 26 }, { header: "Employee ID", key: "empId", width: 13 }, { header: "Email", key: "email", width: 32 },
    { header: "Manager", key: "manager", width: 22 }, { header: "Code", key: "code", width: 10 }, { header: "Message (copy into Teams)", key: "msg", width: 100 }, { header: "Sent", key: "sent", width: 8 }];
  rows.forEach(r => { const row = s2.addRow({ ...r, empId: r.empId || "(on probation)", msg: message(r, r.code) }); row.getCell("msg").alignment = { wrapText: true, vertical: "top" }; row.alignment = { vertical: "top" }; });
  s2.getRow(1).font = { bold: true }; s2.views = [{ state: "frozen", ySplit: 1 }];
  const s3 = im.addWorksheet("By manager");
  s3.columns = [{ header: "Manager", key: "manager", width: 24 }, { header: "Name", key: "name", width: 26 }, { header: "Employee ID", key: "empId", width: 13 }, { header: "Email", key: "email", width: 32 }, { header: "Code", key: "code", width: 10 }];
  [...rows].sort((a, b) => (a.manager || "~").localeCompare(b.manager || "~") || a.name.localeCompare(b.name))
    .forEach(r => s3.addRow({ ...r, manager: r.manager || "(no manager on the sheet)", empId: r.empId || "(on probation)" }));
  s3.getRow(1).font = { bold: true }; s3.views = [{ state: "frozen", ySplit: 1 }];
  await im.xlsx.writeFile(path.join(OUT, "Check-in codes - individual messages.xlsx"));

  // 3. The Word mail-merge letter (python-docx), with merge fields for the Excel columns above.
  execFileSync("python3", [path.join(__dirname, "checkin-codes-docx.py"), path.join(OUT, "Check-in code email - Word mail merge.docx"), SITE, TEAM, FROM], { stdio: "inherit" });
  for (const f of fs.readdirSync(OUT)) fs.chmodSync(path.join(OUT, f), 0o600);
  return rows.length;
}

(async () => {
  const flag = path.join(ROOT, "backup", "checkin-codes.ON");
  if (process.argv.includes("--on")) {
    // --on            everyone
    // --on ACSIT-014  only the people named (Employee IDs or emails), for a test
    const who = process.argv.slice(process.argv.indexOf("--on") + 1).filter(x => !x.startsWith("--"))
      .map(v => { const m = /^(?:ACSIT[-\s]?)?(\d{1,4})$/i.exec(v.trim()); return m ? "ACSIT-" + m[1].padStart(3, "0") : v.trim(); });
    fs.writeFileSync(flag, (who.length ? who.join("\n") : "all") + "\n", { mode: 0o600 });
    console.log(`Check-in codes switched ON for ${who.length ? who.join(", ") + " only" : "everyone"}: the survey asks for them after the next sync (run scripts/backup-from-render.sh to do it now).`);
    return;
  }
  if (process.argv.includes("--off")) { try { fs.unlinkSync(flag); } catch (_) {} console.log("Check-in codes switched OFF: the survey stops asking for them after the next sync."); return; }
  const list = await people();
  const codes = readCodes();
  const i = process.argv.indexOf("--new");
  if (i >= 0) {
    const want = String(process.argv[i + 1] || "").trim();
    const norm = v => { const u = v.toUpperCase(), m = /^(?:ACSIT[-\s]?)?(\d{1,4})$/.exec(u); return m ? "ACSIT-" + m[1].padStart(3, "0") : u; };
    const p = list.find(x => x.email === want.toLowerCase() || (x.empId && x.empId.toUpperCase() === norm(want)));
    if (!p) { console.log(`${want} is not on the standard master sheet`); process.exit(1); }
    const code = newCode();
    codes[p.email] = { code, salt: crypto.randomBytes(12).toString("hex"), issued: new Date().toISOString(), replaced: (codes[p.email] || {}).code ? true : undefined };
    writeCodes(codes);
    await buildFiles(list, codes);
    console.log(`New code for ${p.name} (${p.empId || p.email}). It works after the next sync (within 10 minutes, or run scripts/backup-from-render.sh now).\n\n--- message to send on Teams ---\n${message(p, code)}`);
    return;
  }
  let added = 0;
  for (const p of list) if (!codes[p.email]) { codes[p.email] = { code: newCode(), salt: crypto.randomBytes(12).toString("hex"), issued: new Date().toISOString() }; added++; }
  writeCodes(codes);
  const n = await buildFiles(list, codes);
  console.log(`${added} new codes (${n} people in total). Files in backup/check-in codes/:`);
  for (const f of fs.readdirSync(OUT).sort()) console.log("  " + f);
})().catch(e => { console.log(`error: ${e.message}`); process.exit(1); });
