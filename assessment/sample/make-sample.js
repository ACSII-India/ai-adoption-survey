"use strict";
// Builds a sample results workbook for testing the assessment, in exactly the
// format the survey exports. It starts a local copy of the survey (trial mode)
// and submits made-up people through the real API.
//
//   node assessment/sample/make-sample.js
//
// Writes backup/sample_data.xlsx (results) and backup/sample_org.csv (org file).
// Every person is made up. assessment/sample/EXPECTED.md lists the result each one should get.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..", "..");
const bank = require(path.join(ROOT, "data", "questions.json"));
const Scoring = require(path.join(ROOT, "src", "scoring.js"));
// --cycle2 builds the same people one quarter later, to test trends:
// four go up, one goes down, one leaves and one joins.
const CYCLE2 = process.argv.includes("--cycle2");
const OUT = path.join(ROOT, "backup", CYCLE2 ? "sample_data_cycle2.xlsx" : "sample_data.xlsx");
const ORG_OUT = path.join(ROOT, "backup", "sample_org.csv");
const CYCLE_NAME = CYCLE2 ? "Sample cycle 2" : "Sample cycle";
const CYCLE2_ANSWERS = {
  SMP001: "DCBBA BAAB AAAA AAAA AAA  CBBAAAAAAA",   // Level 0 -> 1: now has access
  SMP002: "DCDBA BAAB AAAA AAAA AAA  CCBAAAAAAA",   // Level 1 -> 2
  SMP003: "DBBDC BCBA CBAD ABAA AAA  EBDBCAABBA",   // Level 2 -> 1: uses AI less often
  SMP004: "DDCDE DCDD BDAB AAAA AAA  EDDCCBBCAA",   // Level 3 -> 4: risk records now weekly
  SMP011: "EEDDDBDDDBA DDDA AAAAA  EDDADBDAAA"      // Level 2 -> 5: Level 3-4 gaps closed, Level 5 already proven
};
const CYCLE2_LEFT = ["SMP010"];
const CYCLE2_NEW = [{ id: "SMP016", name: "SDET 2", role: "SDET", a: "DDDDD DDCB BAAA AAAA AAA  DDDCBAAAAA", ex: {} }];
const PORT = 3098;

const P = (s) => s.split("").filter(c => /[A-E]/.test(c)); // "EDE.." -> letters; spaces ignored

// Answers are R01..R20 then C01..C10 (see the question order in data/questions.json).
const PEOPLE = [
  { id: "SMP001", name: "Service Desk Analyst 1", role: "Service Desk (L2)",
    a: "BAAAA AAAA AAAA AAAA AAA  BAAAAAAAAA", ex: {} },
  { id: "SMP002", name: "Business Analyst 1", role: "Analyst",
    a: "DCBBA BAAB AAAA AAAA AAA  CBBAAAAAAA", ex: {} },
  { id: "SMP003", name: "QA Engineer 1", role: "QA",
    a: "DCDDC BCBA CBAD ABAA AAA  ECDBCAABBA",
    ex: { "QA-R13": ["When our Selenium tests break because a locator changed, I paste the error into Copilot chat and it suggests a new locator that I copy in.", "How often does this happen, and how do you check the fix?", "Sometimes, maybe once or twice a month."] } },
  { id: "SMP004", name: "Delivery Lead 1", role: "Delivery Lead",
    a: "DDCDE DCCD BDAB AAAA AAA  EDDCCBBCAA", ex: {} },
  { id: "SMP005", name: "Tech Lead 1", role: "Tech Lead",
    a: "EEDDD EDDD CDDC DBBA BAA  EDDDDCCBBA",
    ex: {
      "TL-R12": ["Each sprint I split our backlog so that well-scoped tickets (test backfill, small API changes) go to Devin and the rest to the team. I review every Devin PR with the owning developer before it merges; about 8 tickets a sprint now go to agents."],
      "TL-R14": ["I connected Claude to our Jira project so it drafts sprint goals and flags stories with missing acceptance criteria before planning."] } },
  { id: "SMP006", name: "Developer 1", role: "Developer",
    a: "EDEDD EDDE DCDD EDCD BAB  EDDCDBCBCA",
    ex: {
      "DEV-R12": ["Each sprint I hand two or three scoped Jira tickets to Devin. I review its pull request line by line and run the integration tests before merging."],
      "DEV-R13": ["Used Claude Code to move our logging to the new library across 14 services in one change; checked it with the full test suite and a staging run. Done for two migrations so far."],
      "DEV-R14": ["I created /review-pr and /gen-tests commands in Claude Code for our repo.", "How often do you use them and how do you check the output?", "Quite often."],
      "DEV-R15": ["Our Claude Code is connected to Jira and Confluence through MCP. Every sprint I use it to pull acceptance criteria into the task and update the ticket, and I check the ticket before saving."],
      "DEV-R17": ["I keep a prompt and context-file library in the team repo (docs/ai-prompts). Four colleagues use it for code reviews and onboarding, and new joiners now start from it."] } },
  { id: "SMP007", name: "Data Engineer 1", role: "Data Engineer",
    a: "EEEED DEED DCDE DCDE BCB  EDEDDDCDCB",
    ex: {
      "DE-R12": ["For the warehouse migration I had a Claude Code agent rewrite 40 dbt models from the old schema to the new one in one branch. I reviewed the diff and compared row counts and checksums for every model in staging. I use the same approach for each schema change."],
      "DE-R13": ["Claude is connected to our data catalog and Snowflake through MCP. Every day I use it to look up lineage and draft queries; it runs them on a read-only role and I check the results against the catalog definitions. I have a saved command for the daily lineage check."],
      "DE-R14": ["An AI triage job reads failed data quality checks each night, groups them by likely cause and posts a summary to our Teams channel. I review the grouping each morning and fix or reassign; it has run nightly since March."],
      "CR-C08": ["I use Claude with Confluence and Jira through the approved connectors to write data incident reports from the ticket history every week, and I correct the timeline before publishing."],
      "DE-R16": ["I wrote the team's standard for AI-generated SQL and dbt code (naming, tests required, review steps). It is in our data engineering Confluence space, all 7 engineers follow it in code review, and failed reviews dropped since it started."],
      "DE-R17": ["I built the ingestion and embedding pipeline for the policy documents RAG assistant. The Service Desk team and the HR chatbot both use it; it lives in the data-platform repo and refreshes nightly, and answers now cite the current policy version."] } },
  { id: "SMP008", name: "Enterprise Architect 1", role: "Enterprise Architect",
    a: "EEDED EDED DCDD ECDE CDE  EEEDEDDCDC",
    ex: {
      "ARC-R12": ["Every design document in our Confluence space goes through a Claude workflow that checks it against our 18 architecture principles and flags violations. I review each finding before the design board; it runs on every submission, about 12 a month."],
      "ARC-R13": ["For the payments platform upgrade I had a Claude Code agent scan 23 repositories for every caller of the old settlement API and map the impact. I validated the list against our service catalog and found it complete. I now do this for every major interface change."],
      "ARC-R14": ["Our EA tool is connected to Claude through an MCP server I set up. Each week I use it to keep application landscape entries in sync with Confluence decisions, and I review the proposed updates before they are saved. A saved command runs the sync."],
      "CR-C07": ["I chain Claude steps to go from an architecture decision record to a draft target-state diagram and a migration plan."],
      "ARC-R16": ["I published reference architectures for RAG and agent-based solutions on the EA Confluence space. Five project teams, including SKP and Billing, used them in their designs this year, and design reviews now check against them."],
      "ARC-R17": ["I wrote the guardrails standard for AI in solutions (data classes allowed, human review points, logging). It is in the architecture handbook, every new project must follow it at design review, and 9 projects have passed it so far."],
      "CR-C09": ["I run a monthly AI architecture clinic for the teams."],
      "ARC-R19": ["We moved from a design process where each team drew integrations by hand to an AI-assisted target architecture: designs start from AI-generated options based on the reference architectures, checked by the conformance workflow. The architecture team owns it, with human sign-off at the design board. Design lead time dropped from 6 weeks to 2 across 14 designs, against last year's baseline."],
      "ARC-R20": ["Before, AI use cases were approved case by case by email with security and legal. I shaped the organisation's AI governance: an AI review board I chair, a risk tiering for AI use cases, and approval rules. It was adopted organisation-wide in April; 31 use cases have been reviewed, and approval time fell from 5 weeks to 8 days. Exceptions go to the CTO."] } },
  // Edge cases
  { id: "SMP009", name: "Product Engineer 1", role: "Product Engineer",
    a: "EDDDD DDDD DDDD AAAA AAA  EDDDDDAAAA",
    ex: { "DEV-R12": ["sdfsdfsdffdaDVX ZX", "Which tool did you use?", "DEVIN - AI assistant tool"], "DEV-R13": ["lasfhaka,dakjbd qwe", "", ""] } },
  { id: "SMP010", name: "Solution Architect 1", role: "Solution Architect",
    a: "EEEEE EEEE EEEE EEEE EEE  EEEEEEEEEE", exAll: "I use AI tools and agents for all of my architecture work every day." },
  { id: "SMP011", name: "Data Engineer 2", role: "Data Engineer",
    a: "EEDDB ABAB BA DDDA AAAAA  EDBACBDAAA",
    ex: {
      "DE-R12": ["I had a Claude Code agent refactor our 12 Airflow DAGs to the new operator library in one change. I reviewed the diff and ran each DAG in the test environment before release, and I use it for every library upgrade."],
      "DE-R13": ["Claude is connected to our warehouse through an MCP server on a read-only role. Each week I use it to profile new source tables, and I check its profile numbers against a sample query before using them."],
      "DE-R14": ["An AI job checks yesterday's loads every morning and opens a ticket for each anomaly with a likely cause. I review each ticket before it goes to the owner; it has run daily since June."],
      "CR-C07": ["I chain Claude steps to go from a failed job log to a root-cause summary, a fix proposal and a draft incident note. I verify the fix in test before applying it, and do this for every production failure."] } },
  { id: "SMP012", name: "Central Function Associate 1", role: "Central Function (CF)",
    a: "DDCDE DDCC BDAB AAAA AAA  EDDDCBBCAA", ex: {} },
  { id: "SMP014", name: "QA Lead 1", role: "QA Lead",
    a: "EEDEDDEEDDC DECD CDB BA  EDEDDCDCCA",
    ex: {
      "QA-R12": ["For every pull request in the payments service, a Claude Code agent reads the diff and adds or updates the API tests. I review the generated tests in the PR and run them in CI before approving."],
      "QA-R13": ["Our Playwright suite uses an AI healer that updates broken locators during nightly runs and commits the changes to a branch. I review its changes every morning before merging; it is set up as a shared fixture in our test framework."],
      "QA-R15": ["Claude is connected to Jira and Xray through MCP. After each regression run I use it to create defects from failed tests with steps and logs attached, and I review each defect before it is filed. I do this every sprint."],
      "CR-C07": ["Every sprint I chain Claude steps from user stories to test scenarios, then to Xray test cases and test data."],
      "QA-R17": ["I created a prompt pack for writing test cases, test data and defect reports. It is stored in the QA Confluence space and has made our test cases more consistent."] } },
  { id: "SMP015", name: "Central Function Manager 1", role: "Manager - Central Function",
    a: "EEEEDED DEDD DCED DEC DB  EEDDDCCDCB",
    ex: {
      "PM-R12": ["Every Monday a Claude workflow pulls open incidents and SLA breaches from ServiceNow and the Jira change board into our weekly service report. I check the totals against the ServiceNow dashboard before it goes to the leadership team."],
      "PM-R14": ["I run a saved Claude project with templates for onboarding requests: it drafts the access checklist and welcome email from the HR ticket. I use it for every new joiner, about 10 a month, and review each draft before sending."],
      "PM-R15": ["A Copilot Studio agent answers first-line password and VPN questions in our Teams support channel and hands anything else to the service desk. I review a sample of 20 conversations every week and update its answers."],
      "CR-C08": ["I use Claude with Confluence and Jira through the approved connectors to prepare the monthly central function risk review from open risks and actions. I check every item against the risk register before the meeting."],
      "PM-R16": ["I built an AI-ready knowledge base of 120 service desk articles in our Confluence space, written so the Teams agent can use them. The 9 service desk analysts use it daily, and repeat tickets fell from 30% to 18%."],
      "PM-R17": ["I built the AI-generated weekly status pack that the PMO and three delivery teams now use instead of writing their own. It lives in the PMO SharePoint, runs every Friday, and saves each lead about two hours a week."],
      "PM-R19": ["We redesigned new-joiner onboarding around AI: instead of manual tickets to five teams, an agent now creates all access requests from the HR record and tracks them to completion. The central function team runs it, with my approval for admin rights."] } },
  { id: "SMP017", name: "Developer (Doc Auth) 1", role: "Developer, Doc Auth", a: "DDDDD DDCB BAAA AAAA AAA  DDDCBAAAAA", ex: {} },  // L3
  { id: "SMP018", name: "DevOps Engineer 1", role: "DevOps", a: "EEDDD DDDD DCAA AAAA AAA  EDDDDCAAAA", ex: {} },  // L4
  { id: "SMP019", name: "DevOps CF Engineer 1", role: "DevOps, Central Function (CF)", a: "DCDBA BAAB AAAA AAAA AAA  CCBAAAAAAA", ex: {} },  // L2
  { id: "SMP020", name: "Domain QA 1", role: "Domain QA", a: "DDDDD DDCB BAAA AAAA AAA  DDDCBAAAAA", ex: {} },  // L3
  { id: "SMP021", name: "SDET 1", role: "SDET", a: "EEDDD DDDD DCAA AAAA AAA  EDDDDCAAAA", ex: {} },  // L4
  { id: "SMP022", name: "Competency Lead 1", role: "Competency Lead", a: "EEDDD DDDD DCAA AAAA AAA  EDDDDCAAAA", ex: {} },  // L4
  { id: "SMP023", name: "Data Architect 1", role: "Data Architect", a: "DDDDD DDCB BAAA AAAA AAA  DDDCBAAAAA", ex: {} },  // L3
  { id: "SMP024", name: "Architecture Manager 1", role: "Manager - Architecture", a: "EEDDD DDDD DCAA AAAA AAA  EDDDDCAAAA", ex: {} },  // L4
  { id: "SMP025", name: "Information Security Analyst 1", role: "Information Security", a: "DCDBA BAAB AAAA AAAA AAA  CCBAAAAAAA", ex: {} },  // L2
  { id: "SMP026", name: "Technology Services Manager 1", role: "Manager - Technology Services", a: "DDDDD DDCB BAAA AAAA AAA  DDDCBAAAAA", ex: {} },  // L3
  { id: "SMP027", name: "Workplace Technology Manager 1", role: "Manager - Workplace Technology", a: "DCBBA BAAB AAAA AAAA AAA  CBBAAAAAAA", ex: {} },  // L1
  { id: "SMP013", name: "TEST - QA Engineer", role: "QA",
    a: "DDDDD DDDD DDAA AAAA AAA  DDDDDDAAAA", ex: {} }
];

const ORG = [
  // Employee ID, Name, Department, Project team, BU, Director, Manager, Tech lead
  ["SMP001", "Service Desk Analyst 1", "Workplace Technology", "Service Desk", "Services BU", "Director - Services BU", "Service Manager 1", ""],
  ["SMP002", "Business Analyst 1", "Workplace Technology", "Service Desk", "Services BU", "Director - Services BU", "Service Manager 1", ""],
  ["SMP003", "QA Engineer 1", "Quality", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP004", "Delivery Lead 1", "Delivery", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", ""],
  ["SMP005", "Tech Lead 1", "Engineering", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", ""],
  ["SMP006", "Developer 1", "Engineering", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP007", "Data Engineer 1", "Data", "SKP;Billing", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP008", "Enterprise Architect 1", "Architecture", "Architecture Office", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP009", "Product Engineer 1", "Engineering", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP010", "Solution Architect 1", "Architecture", "Billing", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP011", "Data Engineer 2", "Data", "Billing", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP012", "Central Function Associate 1", "Central Function", "Central Function", "Services BU", "Director - Services BU", "Service Manager 1", ""],
  ["SMP014", "QA Lead 1", "Quality", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP015", "Central Function Manager 1", "Central Function", "Central Function", "Services BU", "Director - Services BU", "Director - Services BU", ""],
  ["SMP016", "SDET 2", "Quality", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP017", "Developer (Doc Auth) 1", "Engineering", "Doc Auth", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP018", "DevOps Engineer 1", "Engineering", "Platform Ops", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP019", "DevOps CF Engineer 1", "Central Function", "Central Function", "Services BU", "Director - Services BU", "Service Manager 1", ""],
  ["SMP020", "Domain QA 1", "Quality", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP021", "SDET 1", "Quality", "Billing", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP022", "Competency Lead 1", "Engineering", "Competency Centre", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP023", "Data Architect 1", "Architecture", "Architecture Office", "Platform BU", "Director - Platform BU", "Engineering Manager 2", ""],
  ["SMP024", "Architecture Manager 1", "Architecture", "Architecture Office", "Platform BU", "Director - Platform BU", "Director - Platform BU", ""],
  ["SMP025", "Information Security Analyst 1", "Information Security", "Security", "Services BU", "Director - Services BU", "Service Manager 1", ""],
  ["SMP026", "Technology Services Manager 1", "Technology Services", "Technology Services", "Services BU", "Director - Services BU", "Director - Services BU", ""],
  ["SMP027", "Workplace Technology Manager 1", "Workplace Technology", "Service Desk", "Services BU", "Director - Services BU", "Director - Services BU", ""],
  // In the org but did not respond (shows coverage)
  ["SMP101", "Developer 2", "Engineering", "SKP", "Platform BU", "Director - Platform BU", "Engineering Manager 1", "Tech Lead 1"],
  ["SMP102", "Service Desk Analyst 2", "Workplace Technology", "Service Desk", "Services BU", "Director - Services BU", "Service Manager 1", ""]
];

// Each made-up person gets their own client address so the survey rate limit
// (10 submissions per hour per address) does not stop the local run.
async function post(p, body, n = 1) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-Forwarded-For": `10.0.0.${n}` }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status} ${j.message || ""}`);
  return j;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(OUT, { force: true });
  fs.rmSync(OUT.replace(/\.xlsx$/, " - snapshot.xlsx"), { force: true });
  const env = { ...process.env, PORT: String(PORT), DEV_MOCK: "true", NODE_ENV: "development", EXCEL_LOCAL_PATH: OUT, MAIL_METHOD: "console",
    REQUIRE_EMAIL_CODE: "false", ALLOWED_EMAIL_DOMAINS: "", ALLOW_RESUBMIT: "false", CYCLE_NAME, ANTHROPIC_API_KEY: "" };
  const srv = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
    const people = CYCLE2
      ? [...PEOPLE.filter(p => !CYCLE2_LEFT.includes(p.id)).map(p => CYCLE2_ANSWERS[p.id] ? { ...p, a: CYCLE2_ANSWERS[p.id] } : p), ...CYCLE2_NEW]
      : PEOPLE;
    for (const p of people) {
      const map = bank.roleMap.find(m => m.teamRole === p.role);
      const qs = Scoring.questionsFor(bank, map.questionnaire);
      const letters = P(p.a);
      if (letters.length !== qs.length) throw new Error(`${p.name}: ${letters.length} answers for ${qs.length} questions`);
      const answers = Object.fromEntries(qs.map((q, i) => [q.id, letters[i]]));
      const evidence = {};
      for (const q of qs) {
        if (!Scoring.needsEvidence(q, answers[q.id])) continue;
        const e = p.exAll ? [p.exAll] : p.ex[q.id];
        if (!e) throw new Error(`${p.name}: ${q.id} answered ${answers[q.id]} needs an example`);
        evidence[q.id] = { example: e[0], followupQ: e[1] || "", followupA: e[2] || "" };
      }
      const r = await post("/api/submit", { profile: { name: p.name, empId: p.id, email: `${p.id.toLowerCase()}@example.org`, teamRole: p.role }, answers, evidence }, people.indexOf(p) + 1);
      console.log(`${p.id} ${p.name.padEnd(20)} ${p.role.padEnd(22)} survey shows L${r.result.level}, ${Object.keys(evidence).length} example(s)`);
    }
  } finally { srv.kill(); }
  fs.rmSync(OUT.replace(/\.xlsx$/, " - snapshot.xlsx"), { force: true });
  const q = s => /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  fs.writeFileSync(ORG_OUT,
    ["Employee ID,Name,Department,Project team,BU,Director,Manager,Tech lead", ...ORG.map(r => r.map(q).join(","))].join("\n") + "\n");
  console.log(`Wrote ${OUT}\nWrote ${ORG_OUT}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
