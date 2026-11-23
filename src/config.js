"use strict";
// All settings come from environment variables (App Service application
// settings in Azure, or a local .env file used with `npm run dev`).

const env = process.env;
const bool = (name, dflt) => String(env[name] ?? dflt).trim().toLowerCase() === "true";
const mock = bool("DEV_MOCK", false);

if (mock && env.NODE_ENV === "production") {
  throw new Error("DEV_MOCK=true is for local testing only and cannot run with NODE_ENV=production.");
}

function required(name) {
  const v = env[name];
  if (mock) return v || "";
  if (!v) throw new Error(`Missing required setting: ${name}. See SETUP.md, section "Configure settings".`);
  return v;
}

const port = Number(env.PORT || 3000);

module.exports = {
  mock,
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ""),
  sessionSecret: mock ? (env.SESSION_SECRET || "dev-only-secret-change-me") : required("SESSION_SECRET"),

  // Microsoft Entra ID (one app registration for sign-in and Graph)
  tenantId: required("ENTRA_TENANT_ID"),
  clientId: required("ENTRA_CLIENT_ID"),
  clientSecret: required("ENTRA_CLIENT_SECRET"),
  adminRole: env.ADMIN_APP_ROLE || "Survey.Admin",
  reviewerRole: env.REVIEWER_APP_ROLE || "Survey.Reviewer",

  // The shared Excel workbook in OneDrive or SharePoint
  driveId: required("EXCEL_DRIVE_ID"),
  itemId: required("EXCEL_ITEM_ID"),
  // Optional: read and write a local .xlsx file directly instead of Graph.
  // Useful for local trials without Microsoft 365 (still works with DEV_MOCK).
  localExcelPath: env.EXCEL_LOCAL_PATH || "",

  // Email (sent through Microsoft Graph from this mailbox)
  mailSender: required("MAIL_SENDER"),
  resultsEmailEnabled: bool("ENABLE_RESULTS_EMAIL", true),
  // Optional alternative transports (see src/mailer.js). MAIL_METHOD:
  // "outlook" (local Outlook profile), "console" (log only), or unset.
  mailMethod: (env.MAIL_METHOD || "").trim().toLowerCase(),
  smtpHost: env.SMTP_HOST || "",
  smtpPort: Number(env.SMTP_PORT || 587),
  smtpSecure: bool("SMTP_SECURE", false),
  smtpUser: env.SMTP_USER || "",
  smtpPass: env.SMTP_PASS || "",

  // Claude API for evidence follow-ups
  anthropicApiKey: env.ANTHROPIC_API_KEY || "",
  anthropicModel: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",

  // Shared secret for the assessment job to upload confirmed reports (POST /api/results/upload)
  resultsToken: env.RESULTS_TOKEN || "",

  // Survey rules
  cycleName: env.CYCLE_NAME || "Baseline",
  // Named in the "already submitted" message: the person who approves a new check-in.
  surveyOwner: env.SURVEY_OWNER || "the survey owner",
  allowResubmit: bool("ALLOW_RESUBMIT", false),
  allowedEmailDomains: (env.ALLOWED_EMAIL_DOMAINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  requireEmailCode: bool("REQUIRE_EMAIL_CODE", false),
  levelThreshold: Number(env.LEVEL_THRESHOLD || 0.6),
  metScore: Number(env.MET_SCORE || 3)
};
