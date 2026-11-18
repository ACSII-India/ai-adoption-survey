"use strict";
// Minimal Microsoft Graph client using the app's own identity
// (OAuth 2.0 client credentials). Retries throttled calls.

const config = require("./config");

const GRAPH = "https://graph.microsoft.com/v1.0";
let cached = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class GraphError extends Error {
  constructor(status, body, path) {
    super(`Microsoft Graph ${status} on ${path}: ${String(body).slice(0, 500)}`);
    this.status = status;
  }
}

async function token() {
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default"
  });
  const r = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, { method: "POST", body });
  if (!r.ok) throw new Error(`Could not get a Microsoft Graph token (${r.status}): ${await r.text()}`);
  const j = await r.json();
  cached = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cached.value;
}

async function call(method, path, body, opts = {}) {
  const url = path.startsWith("http") ? path : GRAPH + path;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if ([429, 502, 503, 504].includes(r.status) && attempt < 3) {
      const wait = Number(r.headers.get("retry-after")) || 2 ** attempt;
      await sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    if (!r.ok) throw new GraphError(r.status, await r.text(), path);
    if (opts.raw) return r;
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  throw new GraphError(429, "Still throttled after retries", path);
}

async function getAll(path) {
  let out = [], next = path;
  while (next) {
    const page = await call("GET", next);
    out = out.concat(page.value || []);
    next = page["@odata.nextLink"];
  }
  return out;
}

async function sendMail(to, subject, html) {
  await call("POST", `/users/${encodeURIComponent(config.mailSender)}/sendMail`, {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }]
    },
    saveToSentItems: false
  });
}

module.exports = {
  get: p => call("GET", p),
  post: (p, b) => call("POST", p, b),
  patch: (p, b) => call("PATCH", p, b),
  raw: p => call("GET", p, null, { raw: true }),
  getAll,
  sendMail,
  GraphError
};
