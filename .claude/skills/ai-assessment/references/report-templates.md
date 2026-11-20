# Standard report templates

Every assessment cycle produces the same set of reports, in the same format, so results can be compared over time. The scripts produce reports 1 to 3. Claude writes reports 4 to 6 from the Excel report, using the templates below. Never invent a number: every figure comes from `AI Assessment Report.xlsx`.

| # | Report | Audience | Made by | File |
| --- | --- | --- | --- | --- |
| 1 | Individual report | Each participant (email) | `report.js` | `out/individual/<Employee ID> - <Name>.html` |
| 2 | Assessment workbook | Surveyor, dashboard team | `report.js` | `out/AI Assessment Report.xlsx` |
| 3 | Result email + PDF, as Outlook drafts | Each participant (after review) | `report.js` + `create-outlook-drafts.ps1` | `out/pdf/`, `out/emails/`, `out/Send list.csv` |
| 4 | Leadership summary | CTO and senior leadership | Claude | `out/summaries/Leadership summary.md` |
| 5 | BU summary | Each director | Claude | `out/summaries/BU - <BU>.md` |
| 6 | Team summary | Each manager and tech lead | Claude | `out/summaries/Team - <Manager or Tech lead>.md` |

## 1. Individual report (one page, generated)

Fixed sections, in this order. Do not edit the generated HTML by hand; change `assessment/individual.js` instead, and only between cycles.

1. **Header:** cycle, name, team role, department.
2. **Your level:** "Level N – Name", score out of 7, one line on what the level means. When answers alone give a higher level: "From your answers alone you would be Level X. Levels 5–7 count only when an example shows the practice." From the second cycle: "Since <previous cycle>: Level A → Level B (▲ up / ▼ down / no change) · score a → b".
3. **Where you stand:** one row across Levels 1–7: what each level means, needed (x of y), you have, reached.
4. **To reach Level N+1: at least x of these y.** Every practice at that level: ✅/⬜, status, what would make it count. Then "You have: …", "To qualify, also complete at least N of: …", "Closest: …", and "Already in place higher up" when it applies. At Level 7: "You have reached the top level".
5. **Your examples (Levels 5–7):** only when the person claimed a Level 5–7 practice. One line each: ✅ Meets with the reason; ⚠️ Needs more or ❌ Does not meet with what is missing and the improve sentence.
6. **How this was assessed:** one line, and the invitation to reply.

What each level's report looks like (reference examples in `references/sample-reports/`, all people made up):

| Level | Typical content | Reference |
| --- | --- | --- |
| 0 Not started | Ladder all "–"; next level: the 2 Level 1 access practices | (same layout as Level 1) |
| 1 Aware | Next level: 2 of 3 simple-task practices, with the next answer to reach | `level-1.html` |
| 2 Exploring | Next level: 3 of 6 weekly core tasks; examples section only if they claimed Level 5+ | `level-2.html` |
| 3 Practicing | Next level: 3 of 6 weekly complex-work practices; no examples | `level-3.html` |
| 4 Proficient | Next level: Level 5 practices; claimed ones show which check is missing | `level-4.html` |
| 5 Advanced | Next level: 2 of 4 Level 6 practices; examples with Meets and one Needs more | `level-5.html` |
| 6 Multiplier | Next level: 2 of 3 Level 7 practices; all examples proven | `level-6.html` |
| 7 Transformer | "Top level"; examples, including ones that still miss points | `level-7.html` |

`references/sample-reports/AI Level Report Samples.pdf` has all seven on one page each, with the rules page, for reviewers.

## 2. Assessment workbook (generated)

| Sheet | One row per | Use |
| --- | --- | --- |
| Summary | measure | Headline numbers, level spread, comparison with the previous cycle |
| Individuals | person | Confirmed level, score, level from answers, each level x of y, next step, example counts, flags, team, BU, manager |
| Next steps | person × practice at the next level | Coaching lists for managers |
| Evidence | example | Each of the 4 checks with its quote, decision, reason, improve |
| Practices | person × question | Long form for dashboards |
| Groups | group | Organisation, role, team role, department, project team, BU, director, manager, tech lead: level, score, spread, adoption, advanced, multipliers |
| Gap map | question | Share of people for whom each practice counts |
| Trend people | person | Previous and current level and score, Up/Same/Down/New/Not in this cycle, practices gained and lost |
| Trend groups | group | Previous and current level, score, adoption, multipliers |
| Flags, Left out, Method | — | Review lists and the rules used |

## 3. Result email and Outlook drafts (generated)

Each person gets one email with their one-page PDF attached (`out/pdf/`). The body (`out/emails/`) is generated from `assessment/email.json` and the person's result, in this fixed form:

```
Subject: Your AI adoption check-in result – <cycle>

Hello <first name>,

Thank you for completing the AI adoption check-in. Your result is attached as a one-page PDF.

Your level: Level <N> – <name> (score <s> of 7)
<one line on what the level means>
[From the second cycle: Since <previous cycle>: Level <A> → Level <B> (up / down / no change).]

Your next step: Level <N+1> – <name>
You have: <practices in place at that level>.
To qualify, also complete at least <k> of: <practices not yet in place>.
Closest: <practice> – <what to reach, or "your example needs to show it">.
[Level 7 instead: You have reached the top level. Keep sharing what works so others can follow.]

[Only if an example needs work:] One example to strengthen: <practice>. <improve sentence>

The attached report shows where you stand on every level and how your examples were assessed.

If you think something is missing or wrong, reply to this email with more detail and we will review it.

<closing>
<senderName>
<signatureLines>
```

`Send list.csv` (Email, Name, Subject, Body file, Attachment, From mailbox, Cc) feeds `create-outlook-drafts.ps1`, which saves one Outlook **draft** per person and never sends. `Mail merge.xlsx` holds the same rows for review. Sending happens only on a separate, explicit instruction from the user.

## 4. Leadership summary (Claude writes, about one page)

```markdown
# AI adoption: <cycle>

**<people> people assessed (<coverage> of <headcount>). Organisation level <level> – <name>, score <score>.**
<If a previous cycle exists: "Up from <level> (<score>) in <previous cycle>: <up> people moved up, <down> down.">
<If the rules version changed: say so in one sentence.>

## Where we are
| Measure | <previous cycle> | <cycle> | Change |
| Organisation level | | | |
| Organisation score | | | |
| Adoption (Level 3+) | | | |
| Advanced (Level 5+) | | | |
| Multipliers (Level 6+) | | | |

Level spread: Level 0 <n> · Level 1 <n> · … · Level 7 <n>

## By BU and role
<Table from Groups: BU rows, then role rows: people, level, score, adoption, change. "Not enough responses" where the sheet says so.>

## What is holding us back
<The 3 practices with the lowest "Counts (confirmed)" at Levels 3–5 in the Gap map, one line each with the share.>

## Evidence quality
<Meets / Needs more evidence / Does not meet counts, and one sentence on what most often goes missing (from the Evidence sheet).>

## Recommended actions
<Three actions, each tied to a number above: who, what, by when.>
```

Rules: no individual names except Level 6–7 multipliers, who may be named as people others can learn from. Do not rank individuals.

## 5. BU summary (Claude writes, one per BU)

Same structure as the leadership summary, filtered to the BU: headline, measures with change, project teams in the BU, roles in the BU, top 3 gaps for the BU, multipliers in the BU (named), and 2–3 actions.

## 6. Team summary (Claude writes, one per manager and per tech lead)

```markdown
# <Team or manager>: AI adoption, <cycle>

**<people> of <group size> responded. Team level <level>, score <score>.** <Change since previous cycle.>

| Name | Level | Change | Next level | Closest practice | Examples to improve |
<one row per person, from Individuals and Trend people>

## Closest to the next level
<People whose next level needs only 1 more practice (Next level: complete at least = 1), with that practice.>

## Examples to strengthen
<People with Needs more evidence items: practice and what is missing. These people only need to describe their work better.>

## Team gaps
<The 3 practices fewest people in this team have at their next level.>

## Suggested coaching
<Pair people who have a practice with people who need it, from the Next steps sheet.>
```

## Wording rules (all reports)

- Plain words, short sentences, active voice. Say "practice", "example", "check", not internal names.
- Numbers come only from the workbook. Round scores to one decimal and shares to whole percentages.
- Groups with fewer than 5 people, or below 60% coverage, show "Not enough responses" for their level.
- Trend statements always name both cycles, e.g. "Level 3 in Baseline 2026 → Level 4 in Q1 2027".
- If the rules version differs between cycles, say that changes may come from the rules.
