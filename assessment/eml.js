"use strict";
// Builds a ready-to-send email as an .eml file (no sending). Opened on
// Windows, Outlook shows it as a new, unsent message with a Send button,
// because of the X-Unsent header. No From is set, so Outlook uses the
// account (or the mailbox chosen in the From field) of the person who opens it.

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });

async function buildEml({ to, cc, subject, html, text, attachment }) {
  const info = await composer.sendMail({
    to, cc: cc || undefined, subject, html, text,
    headers: { "X-Unsent": "1" },
    attachments: attachment ? [{ filename: path.basename(attachment), content: fs.readFileSync(attachment), contentType: "application/pdf" }] : []
  });
  return info.message; // Buffer with the full RFC 822 message
}

module.exports = { buildEml };
