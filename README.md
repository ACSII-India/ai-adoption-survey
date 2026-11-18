# AI adoption check-in

A web survey that places technology team members on the 7-level AI adoption scale for their role. It captures evidence for advanced use, asks Claude for follow-up questions, writes every submission to a shared Excel file in OneDrive or SharePoint, and gives admins and reviewers a signed-in view to review evidence and download the workbook.

- Participants: `/` (no sign-in)
- Admins and reviewers: `/admin` (Microsoft sign-in with app roles)

Quick local trial: `npm install`, copy `.env.example` to `.env`, set `DEV_MOCK=true` and `NODE_ENV=development`, then `npm run dev`.

Full setup and deployment: see [SETUP.md](SETUP.md).
