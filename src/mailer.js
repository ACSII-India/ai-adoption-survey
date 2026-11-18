"use strict";
// Outgoing mail. Transport is picked in this order:
//   1. SMTP_* env vars set -> nodemailer SMTP transport
//   2. MAIL_METHOD=outlook -> local Outlook desktop via COM (Windows only,
//      sends through the signed-in Outlook profile; no credentials needed)
//   3. DEV_MOCK=true -> log to the console only
//   4. otherwise -> Microsoft Graph (./graph), the production path

const { execFile } = require("child_process");
const config = require("./config");

let smtp = null;
if (config.smtpHost) {
  const nodemailer = require("nodemailer");
  smtp = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure, // true for port 465, false for STARTTLS (587/25)
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    connectionTimeout: 15000
  });
}

const useOutlook = config.mailMethod === "outlook" ||
  (!smtp && config.mock && process.platform === "win32" && config.mailMethod !== "console");

// Sends through the local Outlook profile. Outlook may show a one-time
// "a program is trying to send email" prompt depending on Trust Center
// settings and antivirus status.
function sendViaOutlook(to, subject, html) {
  return new Promise((resolve, reject) => {
    const script = [
      "$o = New-Object -ComObject Outlook.Application",
      "$m = $o.CreateItem(0)",
      "$m.To = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAIL_TO))",
      "$m.Subject = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAIL_SUBJECT))",
      "$m.HTMLBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAIL_HTML))",
      "$m.Send()"
    ].join("\n");
    const env = {
      ...process.env,
      MAIL_TO: Buffer.from(to, "utf8").toString("base64"),
      MAIL_SUBJECT: Buffer.from(subject, "utf8").toString("base64"),
      MAIL_HTML: Buffer.from(html, "utf8").toString("base64")
    };
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
      { env, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Outlook send failed: ${stderr || err.message}`.slice(0, 400)));
        resolve();
      });
  });
}

// True when mail will actually be sent somewhere (not just logged).
function isConfigured() {
  return Boolean(smtp) || useOutlook || !config.mock;
}

async function sendMail(to, subject, html) {
  if (smtp) return smtp.sendMail({ from: config.mailSender, to, subject, html });
  if (useOutlook) return sendViaOutlook(to, subject, html);
  if (config.mock) return console.log(`[DEV_MOCK] mail to ${to}: ${subject}`);
  return require("./graph").sendMail(to, subject, html);
}

module.exports = { sendMail, isConfigured };
