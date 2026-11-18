"use strict";
// Microsoft Entra ID sign-in for admins and reviewers (OpenID Connect
// authorization code flow with PKCE). Access comes from app roles assigned
// in Entra ID: ADMIN_APP_ROLE and REVIEWER_APP_ROLE.

const crypto = require("crypto");
const config = require("./config");

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const authority = () => `https://login.microsoftonline.com/${config.tenantId}`;
const redirectUri = () => `${config.baseUrl}/auth/redirect`;

function decodeJwtPayload(jwt) {
  const part = String(jwt).split(".")[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

function rolesToAccess(roles) {
  const isAdmin = roles.includes(config.adminRole);
  const isReviewer = isAdmin || roles.includes(config.reviewerRole);
  return { isAdmin, isReviewer };
}

function signIn(req, res) {
  if (config.mock) {
    const as = req.query.as === "reviewer" ? "reviewer" : "admin";
    return req.session.regenerate(() => {
      req.session.user = { id: "dev-" + as, name: as === "admin" ? "Dev Admin" : "Dev Reviewer", email: "", isAdmin: as === "admin", isReviewer: true };
      res.redirect("/admin");
    });
  }
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  req.session.oidc = { state, nonce, verifier };
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId, response_type: "code", redirect_uri: redirectUri(), response_mode: "query",
    scope: "openid profile email", state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account"
  }).toString();
  req.session.save(() => res.redirect(url.toString()));
}

async function redirect(req, res) {
  const o = req.session.oidc;
  if (!o || !req.query.state || req.query.state !== o.state) return res.status(400).send(page("Sign-in expired", "Please start the sign-in again from the admin page."));
  if (req.query.error) return res.status(401).send(page("Sign-in failed", String(req.query.error_description || req.query.error)));
  try {
    const body = new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret, grant_type: "authorization_code",
      code: String(req.query.code || ""), redirect_uri: redirectUri(), code_verifier: o.verifier, scope: "openid profile email"
    });
    const r = await fetch(`${authority()}/oauth2/v2.0/token`, { method: "POST", body });
    if (!r.ok) throw new Error(`token endpoint ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const tokens = await r.json();
    // The ID token came straight from the Entra token endpoint over TLS
    // with our client secret, so its claims are checked here rather than
    // its signature (OpenID Connect Core 3.1.3.7).
    const c = decodeJwtPayload(tokens.id_token);
    const now = Math.floor(Date.now() / 1000);
    if (c.aud !== config.clientId || c.tid !== config.tenantId || c.iss !== `${authority()}/v2.0` || c.nonce !== o.nonce || c.exp < now) {
      throw new Error("ID token claims did not match this app or tenant");
    }
    const access = rolesToAccess(Array.isArray(c.roles) ? c.roles : []);
    if (!access.isReviewer) return res.status(403).send(page("No access", "Your account is not assigned to the admin or reviewer role for this survey. Ask the survey owner to add you."));
    req.session.regenerate(err => {
      if (err) return res.status(500).send(page("Sign-in failed", "Could not start a session."));
      req.session.user = { id: c.oid, name: c.name || "", email: c.preferred_username || c.email || "", ...access };
      res.redirect("/admin");
    });
  } catch (e) {
    console.error("Sign-in failed:", e.message);
    res.status(401).send(page("Sign-in failed", "The sign-in could not be completed. Try again, and contact the survey owner if it keeps failing."));
  }
}

function signOut(req, res) {
  req.session.destroy(() => {
    if (config.mock) return res.redirect("/admin");
    const url = new URL(`${authority()}/oauth2/v2.0/logout`);
    url.searchParams.set("post_logout_redirect_uri", `${config.baseUrl}/admin`);
    res.redirect(url.toString());
  });
}

function requireReviewer(req, res, next) {
  if (req.session.user && req.session.user.isReviewer) return next();
  res.status(401).json({ error: "sign_in_required" });
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.status(403).json({ error: "admin_only" });
}

function page(title, text) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"><main class="narrow"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/admin">Back to the admin page</a></p></main>`;
}

module.exports = { signIn, redirect, signOut, requireReviewer, requireAdmin };
