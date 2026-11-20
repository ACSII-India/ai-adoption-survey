"use strict";
// Finished result reports, by submission ID. Reports without Level 5-7
// examples are stored at submission; the others arrive later from the
// assessment job (POST /api/results/upload). The store is a JSON file in the
// temp folder: on Render's Free plan it is lost on restart, and the
// assessment job uploads all reports again when it sees them missing.

const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = process.env.RESULTS_STORE_PATH || path.join(os.tmpdir(), "ai-survey-results.json");
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { data = {}; }

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch (e) { console.error("results store write failed:", e.message); }
}

module.exports = {
  get: id => data[id] || null,
  setPending(id) { if (!data[id] || data[id].status !== "ready") { data[id] = { status: "pending", at: new Date().toISOString() }; save(); } },
  setReady(id, html, source) { data[id] = { status: "ready", html, source, at: new Date().toISOString() }; save(); },
  readyIds: () => Object.keys(data).filter(id => data[id].status === "ready")
};
