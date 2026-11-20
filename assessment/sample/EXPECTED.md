# Expected results for the sample data

All people are made up and named after their team role. Use this to check an assessment run on `backup/sample_data.xlsx` (cycle "Sample cycle") and `backup/sample_data_cycle2.xlsx` (cycle "Sample cycle 2"). Confirmed levels assume judgements that match `reference-judgements.json`; `compare.js` shows where a run differs.

The sample covers all 24 team roles and all 6 role questionnaires. `TEST - QA Engineer` must be left out as a test entry.

## Sample cycle

| Employee ID | Name | Team role | Confirmed level | Score | Level from answers | Examples meet / need more / do not meet | Flags | What it tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SMP001 | Service Desk Analyst 1 | Service Desk (L2) | 0 Not started | 0 | 0 | 0 / 0 / 0 | Same answer everywhere | No access yet (Level 0) |
| SMP002 | Business Analyst 1 | Analyst | 1 Aware | 1.3 | 1 | 0 / 0 / 0 |  | Has access; only 1 of 3 simple tasks |
| SMP003 | QA Engineer 1 | QA | 2 Exploring | 2.3 | 2 | 0 / 0 / 1 |  | Level 5 claim with a chat-only example: lower-level use, Does not meet |
| SMP004 | Delivery Lead 1 | Delivery Lead | 3 Practicing | 3.3 | 3 | 0 / 0 / 0 |  | Weekly on core tasks; 2 of 6 complex |
| SMP005 | Tech Lead 1 | Tech Lead | 4 Proficient | 4.2 | 4 | 1 / 0 / 1 |  | One proven Level 5 practice; second example misses "checked" and "regularly" |
| SMP006 | Developer 1 | Developer | 5 Advanced | 5.3 | 5 | 4 / 0 / 1 |  | 3 proven Level 5; 1 of 4 Level 6; one example missing "checked" |
| SMP007 | Data Engineer 1 | Data Engineer | 6 Multiplier | 6 | 6 | 6 / 0 / 0 |  | 4 proven Level 5, 2 proven Level 6; E answer without a team standard |
| SMP008 | Enterprise Architect 1 | Enterprise Architect | 7 Transformer | 7 | 7 | 7 / 0 / 2 |  | Level 7 proven twice; two lower examples miss points; one 10-word example rejected by the quality filter |
| SMP009 | Product Engineer 1 | Product Engineer | 4 Proficient | 4 | 4 | 0 / 0 / 2 |  | Placeholder text rejected by the quality filter |
| SMP010 | Solution Architect 1 | Solution Architect | 4 Proficient | 4 | 7 | 0 / 0 / 13 | Same answer everywhere; Reused example | Same vague sentence for 13 questions: claims Level 7, confirmed Level 4; flags |
| SMP011 | Data Engineer 2 | Data Engineer | 2 Exploring | 2.2 | 2 | 4 / 0 / 0 | Ladder jump | Proven Level 5 but Level 3 not reached: ladder jump flag |
| SMP012 | Central Function Associate 1 | Central Function (CF) | 3 Practicing | 3.2 | 3 | 0 / 0 / 0 |  | Central Function on the Delivery/Project Manager questions |
| SMP014 | QA Lead 1 | QA Lead | 5 Advanced | 5 | 5 | 3 / 2 / 0 |  | Level 6 prompt pack missing "who uses it" |
| SMP015 | Central Function Manager 1 | Manager - Central Function | 6 Multiplier | 6 | 6 | 5 / 2 / 0 |  | Saved chat project only drafts text (not "AI did the steps"); Level 7 redesign missing a measured result |
| SMP017 | Developer (Doc Auth) 1 | Developer, Doc Auth | 3 Practicing | 3 | 3 | 0 / 0 / 0 |  | Level 3 profile |
| SMP018 | DevOps Engineer 1 | DevOps | 4 Proficient | 4 | 4 | 0 / 0 / 0 |  | Level 4 profile |
| SMP019 | DevOps CF Engineer 1 | DevOps, Central Function (CF) | 2 Exploring | 2 | 2 | 0 / 0 / 0 |  | Level 2 profile |
| SMP020 | Domain QA 1 | Domain QA | 3 Practicing | 3 | 3 | 0 / 0 / 0 |  | Level 3 profile |
| SMP021 | SDET 1 | SDET | 4 Proficient | 4 | 4 | 0 / 0 / 0 |  | Level 4 profile |
| SMP022 | Competency Lead 1 | Competency Lead | 4 Proficient | 4 | 4 | 0 / 0 / 0 |  | Level 4 profile |
| SMP023 | Data Architect 1 | Data Architect | 3 Practicing | 3 | 3 | 0 / 0 / 0 |  | Level 3 profile |
| SMP024 | Architecture Manager 1 | Manager - Architecture | 4 Proficient | 4 | 4 | 0 / 0 / 0 |  | Level 4 profile |
| SMP025 | Information Security Analyst 1 | Information Security | 2 Exploring | 2 | 2 | 0 / 0 / 0 |  | Level 2 profile |
| SMP026 | Technology Services Manager 1 | Manager - Technology Services | 3 Practicing | 3 | 3 | 0 / 0 / 0 |  | Level 3 profile |
| SMP027 | Workplace Technology Manager 1 | Manager - Workplace Technology | 1 Aware | 1.3 | 1 | 0 / 0 / 0 |  | Level 1 profile |

Level spread: Level 0: 1 · Level 1: 2 · Level 2: 4 · Level 3: 6 · Level 4: 7 · Level 5: 2 · Level 6: 2 · Level 7: 1. Examples: Meets 30, Needs more evidence 4, Does not meet 20 (3 of them by the quality filter).

## Sample cycle 2 (trend)

Expected: up 4, same 19, down 1, new 1, not in this cycle 1.

| Employee ID | Name | Sample cycle | Sample cycle 2 | Status |
| --- | --- | --- | --- | --- |
| SMP001 | Service Desk Analyst 1 | 0 | 1 | Up |
| SMP002 | Business Analyst 1 | 1 | 2 | Up |
| SMP003 | QA Engineer 1 | 2 | 1 | Down |
| SMP004 | Delivery Lead 1 | 3 | 4 | Up |
| SMP011 | Data Engineer 2 | 2 | 5 | Up |
| SMP016 | SDET 2 |  | 3 | New |
| SMP010 | Solution Architect 1 | 4 |  | Not in this cycle |
