"use strict";
// Usage: npm run setup-workbook
// Creates the "Responses" and "Evidence" sheets and Excel tables, with the
// column headers the app writes to. Safe to run again: existing tables are kept.
const graph = require("../src/graph");
const config = require("../src/config");
const { RESPONSE_HEADERS, EVIDENCE_HEADERS, TABLES } = require("../src/store");

const wb = `/drives/${encodeURIComponent(config.driveId)}/items/${encodeURIComponent(config.itemId)}/workbook`;

function colLetter(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

async function ensure(name, tableName, headers) {
  const sheets = await graph.getAll(`${wb}/worksheets?$select=name`);
  if (!sheets.some(s => s.name === name)) {
    await graph.post(`${wb}/worksheets/add`, { name });
    console.log(`Added sheet ${name}`);
  }
  const tables = await graph.getAll(`${wb}/tables?$select=name`);
  if (tables.some(t => t.name === tableName)) { console.log(`Table ${tableName} already exists; left as is.`); return; }
  const address = `A1:${colLetter(headers.length)}1`;
  await graph.patch(`${wb}/worksheets/${encodeURIComponent(name)}/range(address='${address}')`, { values: [headers] });
  const t = await graph.post(`${wb}/worksheets/${encodeURIComponent(name)}/tables/add`, { address, hasHeaders: true });
  await graph.patch(`${wb}/tables/${encodeURIComponent(t.id)}`, { name: tableName });
  console.log(`Created table ${tableName} on sheet ${name} with ${headers.length} columns (${address})`);
}

(async () => {
  if (config.mock) { console.error("Turn off DEV_MOCK to set up the real workbook."); process.exit(1); }
  try {
    await ensure("Responses", TABLES.responses, RESPONSE_HEADERS);
    await ensure("Evidence", TABLES.evidence, EVIDENCE_HEADERS);
    console.log("Workbook is ready.");
  } catch (e) {
    console.error("Setup failed:", e.message);
    console.error("Check EXCEL_DRIVE_ID and EXCEL_ITEM_ID, that the file is an .xlsx workbook, and that it is closed for editing by others during setup.");
    process.exit(1);
  }
})();
