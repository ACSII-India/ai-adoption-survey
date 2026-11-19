"use strict";
// Storage in the shared Excel workbook through Microsoft Graph.
// Sheet "Responses" holds table tblResponses (one row per submission);
// sheet "Evidence" holds table tblEvidence (one row per example).
// With DEV_MOCK=true an in-memory store with the same interface is used,
// unless EXCEL_LOCAL_PATH points at a local .xlsx file, in which case that
// file is read and written directly (sheets "Responses" and "Evidence",
// header row 1).

const fs = require("fs");
const { Readable } = require("stream");
const ExcelJS = require("exceljs");
const config = require("./config");

// Excel table names (sheet names are "Responses" and "Evidence").
const T = { responses: "tblResponses", evidence: "tblEvidence" };

const R_COLS = Array.from({ length: 20 }, (_, i) => "R" + String(i + 1).padStart(2, "0"));
const C_COLS = Array.from({ length: 10 }, (_, i) => "C" + String(i + 1).padStart(2, "0"));

const RESPONSE_HEADERS = ["Respondent ID (Employee ID)", "Name", "Department", "Role", "Date"]
  .concat(R_COLS, C_COLS, ["Email", "Team role", "Status", "Answered", "Total score", "Score %",
    "Current level", "Level name", "Level score", "Provisional tier", "Examples",
    "Examples accepted", "Examples to review", "Cycle", "Submission ID", "Submitted at (UTC)"]);

const EVIDENCE_HEADERS = ["Submission ID", "Cycle", "Employee ID", "Name", "Email", "Department",
  "Team role", "Questionnaire", "Question ID", "Level", "Use case", "Answer", "Example",
  "Follow-up question", "Follow-up answer", "Link", "AI rating", "AI summary", "AI reason",
  "Reviewer decision", "Reviewer notes", "Reviewed by", "Reviewed on (UTC)"];

// Excel reads text that starts with = + - @ as a formula, and turns digit
// strings (employee IDs, dates) into numbers. A leading apostrophe keeps
// them as text; Excel hides the apostrophe. Real numbers stay numbers.
const cell = v => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = String(v);
  return /^[=+\-@\t\r0-9]/.test(s) || /^(true|false)$/i.test(s) ? "'" + s : s;
};
const toValues = (headers, obj) => headers.map(h => cell(obj[h]));
const toObject = (headers, values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/* ---------------- Excel (Microsoft Graph) store ---------------- */
class ExcelStore {
  constructor(graph) {
    this.graph = graph;
    this.item = `/drives/${encodeURIComponent(config.driveId)}/items/${encodeURIComponent(config.itemId)}`;
    this.wb = `${this.item}/workbook`;
    this.queue = Promise.resolve();
  }

  // One write at a time: the app runs as a single instance (see SETUP.md).
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async rows(table) {
    const value = await this.graph.getAll(`${this.wb}/tables/${table}/rows`);
    return value.map(r => ({ index: r.index, values: r.values[0] }));
  }

  async patchRow(table, index, values) {
    const range = await this.graph.get(`${this.wb}/tables/${table}/rows/itemAt(index=${index})/range`);
    const [sheet, address] = range.address.split("!");
    const name = sheet.replace(/^'|'$/g, "").replace(/''/g, "'");
    await this.graph.patch(`${this.wb}/worksheets/${encodeURIComponent(name)}/range(address='${address}')`, { values: [values] });
  }

  async addRows(table, valuesList) {
    if (!valuesList.length) return;
    const existing = await this.rows(table);
    let start = 0;
    // A new Excel table can carry one empty data row; fill it first.
    if (existing.length === 1 && existing[0].values.every(v => v === "" || v === null)) {
      await this.patchRow(table, existing[0].index, valuesList[0]);
      start = 1;
    }
    if (valuesList.length > start) {
      await this.graph.post(`${this.wb}/tables/${table}/rows/add`, { index: null, values: valuesList.slice(start) });
    }
  }

  async listResponses() {
    return (await this.rows(T.responses))
      .filter(r => r.values.some(v => v !== ""))
      .map(r => Object.assign(toObject(RESPONSE_HEADERS, r.values), { _index: r.index }));
  }

  async listEvidence() {
    return (await this.rows(T.evidence))
      .filter(r => r.values.some(v => v !== ""))
      .map(r => Object.assign(toObject(EVIDENCE_HEADERS, r.values), { _index: r.index }));
  }

  async getSubmission(submissionId) {
    return (await this.listResponses()).find(r => r["Submission ID"] === submissionId) || null;
  }

  // Adds the submission unless one already exists for this employee and
  // cycle. With ALLOW_RESUBMIT=true the earlier one is marked Superseded.
  addSubmission(response, evidence) {
    return this.serial(async () => {
      const all = await this.listResponses();
      const prior = all.filter(r => same(r["Respondent ID (Employee ID)"], response["Respondent ID (Employee ID)"])
        && r.Cycle === response.Cycle && r.Status === "Submitted");
      if (prior.length && !config.allowResubmit) {
        const e = new Error("already_submitted");
        e.submittedAt = prior[0]["Submitted at (UTC)"];
        throw e;
      }
      for (const p of prior) {
        await this.patchRow(T.responses, p._index, toValues(RESPONSE_HEADERS, Object.assign({}, p, { Status: "Superseded" })));
      }
      await this.addRows(T.responses, [toValues(RESPONSE_HEADERS, response)]);
      await this.addRows(T.evidence, evidence.map(e => toValues(EVIDENCE_HEADERS, e)));
    });
  }

  saveReview(submissionId, questionId, review) {
    return this.serial(async () => {
      const evidence = await this.listEvidence();
      const row = evidence.find(e => e["Submission ID"] === submissionId && e["Question ID"] === questionId);
      if (!row) throw new Error("evidence_not_found");
      Object.assign(row, review);
      await this.patchRow(T.evidence, row._index, toValues(EVIDENCE_HEADERS, row));
      const mine = evidence.filter(e => e["Submission ID"] === submissionId);
      const resp = (await this.listResponses()).find(r => r["Submission ID"] === submissionId);
      if (resp) {
        resp["Examples accepted"] = mine.filter(e => e["Reviewer decision"] === "Accepted").length;
        resp["Examples to review"] = mine.filter(e => !e["Reviewer decision"]).length;
        await this.patchRow(T.responses, resp._index, toValues(RESPONSE_HEADERS, resp));
      }
    });
  }

  setStatus(submissionId, status) {
    return this.serial(async () => {
      const resp = (await this.listResponses()).find(r => r["Submission ID"] === submissionId);
      if (!resp) throw new Error("submission_not_found");
      resp.Status = status;
      await this.patchRow(T.responses, resp._index, toValues(RESPONSE_HEADERS, resp));
    });
  }

  async download() { return this.graph.raw(`${this.item}/content`); }
  async webUrl() { return (await this.graph.get(`${this.item}?$select=webUrl`)).webUrl; }
}

/* ---------------- Local .xlsx file store (EXCEL_LOCAL_PATH) ---------------- */
// Same layout as the Graph workbook: a "Responses" sheet and an "Evidence"
// sheet, headers in row 1. Other sheets in the file are left alone.
// Writes go through ExcelJS, so a value stored as text stays text
// (employee IDs keep leading zeros) and the apostrophe escape is not needed.
class LocalFileStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  ensureSheet(wb, name, headers) {
    let ws = wb.getWorksheet(name);
    if (!ws) ws = wb.addWorksheet(name);
    if (!ws.getRow(1).getCell(1).value) {
      headers.forEach((h, i) => { ws.getRow(1).getCell(i + 1).value = h; });
      ws.getRow(1).font = { bold: true };
    }
    return ws;
  }

  async load() {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.readFile(this.file); }
    catch (e) {
      if (e.code === "EBUSY" || e.code === "EPERM")
        throw new Error(`The Excel file is open in Excel. Close "${this.file}" and try again.`);
      if (e.code !== "ENOENT") throw e;
    }
    this.ensureSheet(wb, "Responses", RESPONSE_HEADERS);
    this.ensureSheet(wb, "Evidence", EVIDENCE_HEADERS);
    return wb;
  }

  // Retries on EBUSY/EPERM (brief locks from Excel or OneDrive sync), then
  // keeps a snapshot copy in sync so the file can be viewed without locking
  // the live workbook. Open " - snapshot.xlsx" instead of the live file.
  async save(wb) {
    const locked = () => new Error(`The Excel file is open in Excel. Close "${this.file}" and try again.`);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await wb.xlsx.writeFile(this.file);
        try { fs.copyFileSync(this.file, this.file.replace(/\.xlsx?$/i, " - snapshot.xlsx")); }
        catch (e) { console.warn("snapshot copy skipped:", e.message); }
        return;
      } catch (e) {
        if (e.code !== "EBUSY" && e.code !== "EPERM") throw e;
        if (attempt === 3) throw locked();
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  // Normalize ExcelJS cell values (string, number, Date, {richText},
  // {text,hyperlink}, {formula,result}) to plain strings or numbers.
  clean(v) {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") {
      if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
      if (v.result !== undefined) return this.clean(v.result);
      if (v.text !== undefined) return String(v.text);
      if (v.hyperlink !== undefined) return String(v.hyperlink);
      return "";
    }
    return v;
  }

  rows(ws, headers) {
    const out = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const values = headers.map((h, i) => this.clean(row.getCell(i + 1).value));
      if (values.some(v => v !== "")) out.push(Object.assign(toObject(headers, values), { _index: n }));
    });
    return out;
  }

  writeRow(ws, n, headers, obj) {
    const row = ws.getRow(n);
    headers.forEach((h, i) => {
      const v = obj[h];
      row.getCell(i + 1).value = v === undefined || v === null || v === "" ? null : v;
    });
  }

  appendRow(ws, headers, obj) {
    const row = ws.addRow([]);
    this.writeRow(ws, row.number, headers, obj);
  }

  async listResponses() {
    const wb = await this.load();
    return this.rows(wb.getWorksheet("Responses"), RESPONSE_HEADERS);
  }

  async listEvidence() {
    const wb = await this.load();
    return this.rows(wb.getWorksheet("Evidence"), EVIDENCE_HEADERS);
  }

  async getSubmission(submissionId) {
    return (await this.listResponses()).find(r => r["Submission ID"] === submissionId) || null;
  }

  addSubmission(response, evidence) {
    return this.serial(async () => {
      const wb = await this.load();
      const rs = wb.getWorksheet("Responses"), es = wb.getWorksheet("Evidence");
      const all = this.rows(rs, RESPONSE_HEADERS);
      const prior = all.filter(r => same(r["Respondent ID (Employee ID)"], response["Respondent ID (Employee ID)"])
        && r.Cycle === response.Cycle && r.Status === "Submitted");
      if (prior.length && !config.allowResubmit) {
        const e = new Error("already_submitted");
        e.submittedAt = prior[0]["Submitted at (UTC)"];
        throw e;
      }
      for (const p of prior) {
        p.Status = "Superseded";
        this.writeRow(rs, p._index, RESPONSE_HEADERS, p);
      }
      this.appendRow(rs, RESPONSE_HEADERS, response);
      evidence.forEach(e => this.appendRow(es, EVIDENCE_HEADERS, e));
      await this.save(wb);
    });
  }

  saveReview(submissionId, questionId, review) {
    return this.serial(async () => {
      const wb = await this.load();
      const es = wb.getWorksheet("Evidence"), rs = wb.getWorksheet("Responses");
      const evidence = this.rows(es, EVIDENCE_HEADERS);
      const row = evidence.find(e => e["Submission ID"] === submissionId && e["Question ID"] === questionId);
      if (!row) throw new Error("evidence_not_found");
      Object.assign(row, review);
      this.writeRow(es, row._index, EVIDENCE_HEADERS, row);
      const mine = evidence.filter(e => e["Submission ID"] === submissionId);
      const resp = this.rows(rs, RESPONSE_HEADERS).find(r => r["Submission ID"] === submissionId);
      if (resp) {
        resp["Examples accepted"] = mine.filter(e => e["Reviewer decision"] === "Accepted").length;
        resp["Examples to review"] = mine.filter(e => !e["Reviewer decision"]).length;
        this.writeRow(rs, resp._index, RESPONSE_HEADERS, resp);
      }
      await this.save(wb);
    });
  }

  setStatus(submissionId, status) {
    return this.serial(async () => {
      const wb = await this.load();
      const rs = wb.getWorksheet("Responses");
      const resp = this.rows(rs, RESPONSE_HEADERS).find(r => r["Submission ID"] === submissionId);
      if (!resp) throw new Error("submission_not_found");
      resp.Status = status;
      this.writeRow(rs, resp._index, RESPONSE_HEADERS, resp);
      await this.save(wb);
    });
  }

  async download() {
    // Before the first submission the file does not exist yet: create the
    // empty workbook (header rows only) so the download still works.
    if (!fs.existsSync(this.file)) await this.serial(async () => {
      if (!fs.existsSync(this.file)) await this.save(await this.load());
    });
    return { body: Readable.toWeb(fs.createReadStream(this.file)) };
  }
  async webUrl() { return ""; }
}

/* ---------------- In-memory store for DEV_MOCK ---------------- */
// Keeps values as Excel would show them (no text apostrophe).
const plain = (headers, obj) => Object.fromEntries(headers.map(h => [h, obj[h] ?? ""]));
class MemoryStore {
  constructor() { this.responses = []; this.evidence = []; }
  async listResponses() { return this.responses.map((r, i) => Object.assign({}, r, { _index: i })); }
  async listEvidence() { return this.evidence.map((r, i) => Object.assign({}, r, { _index: i })); }
  async getSubmission(id) { return (await this.listResponses()).find(r => r["Submission ID"] === id) || null; }
  async addSubmission(response, evidence) {
    const prior = this.responses.filter(r => same(r["Respondent ID (Employee ID)"], response["Respondent ID (Employee ID)"])
      && r.Cycle === response.Cycle && r.Status === "Submitted");
    if (prior.length && !config.allowResubmit) { const e = new Error("already_submitted"); e.submittedAt = prior[0]["Submitted at (UTC)"]; throw e; }
    prior.forEach(p => { p.Status = "Superseded"; });
    this.responses.push(plain(RESPONSE_HEADERS, response));
    evidence.forEach(e => this.evidence.push(plain(EVIDENCE_HEADERS, e)));
  }
  async saveReview(submissionId, questionId, review) {
    const row = this.evidence.find(e => e["Submission ID"] === submissionId && e["Question ID"] === questionId);
    if (!row) throw new Error("evidence_not_found");
    Object.assign(row, review);
    const mine = this.evidence.filter(e => e["Submission ID"] === submissionId);
    const resp = this.responses.find(r => r["Submission ID"] === submissionId);
    if (resp) { resp["Examples accepted"] = mine.filter(e => e["Reviewer decision"] === "Accepted").length; resp["Examples to review"] = mine.filter(e => !e["Reviewer decision"]).length; }
  }
  async setStatus(submissionId, status) {
    const resp = this.responses.find(r => r["Submission ID"] === submissionId);
    if (!resp) throw new Error("submission_not_found");
    resp.Status = status;
  }
  async download() { return null; }
  async webUrl() { return ""; }
}

function createStore() {
  if (config.localExcelPath) return new LocalFileStore(config.localExcelPath);
  if (config.mock) return new MemoryStore();
  return new ExcelStore(require("./graph"));
}

module.exports = { createStore, RESPONSE_HEADERS, EVIDENCE_HEADERS, TABLES: T };
