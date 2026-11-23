"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let me = null, data = { responses: [], evidence: [] }, tab = "people", sel = null, showAll = false;

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "The request failed.");
    return j;
  }

  async function load() {
    const r = await fetch("/admin/api/data");
    if (r.status === 401) return signInPage();
    const j = await r.json();
    if (!r.ok) { $("main").innerHTML = `<p class="err">${esc(j.message)}</p>`; return; }
    data = j; render();
  }

  function signInPage() {
    $("main").className = "narrow";
    $("main").innerHTML = '<h1>Sign in to view responses</h1><p>Admins and reviewers sign in with their Microsoft work account. Participants do not need to sign in; they use the <a href="/">check-in page</a>.</p><p><a class="btn" href="/auth/signin">Sign in with Microsoft</a></p>';
  }

  const visible = () => data.responses.filter(r => showAll || r.Status === "Submitted");
  const evFor = id => data.evidence.filter(e => e["Submission ID"] === id);

  function render() {
    const rows = visible().sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
    const submitted = data.responses.filter(r => r.Status === "Submitted");
    const pending = data.evidence.filter(e => !e["Reviewer decision"] && submitted.some(r => r["Submission ID"] === e["Submission ID"])).length;
    let h = `<div class="panel"><h2>Responses, ${esc(me.cycle)}</h2><p class="hint" style="margin-top:0">Signed in as ${esc(me.name)} (${me.role}). ${submitted.length} submitted, ${pending} examples waiting for review.</p>
      <div class="row" style="margin-top:0">${me.mock ? "" : '<a class="btn" href="/admin/api/download">Download Excel file</a><button class="btn ghost" id="open" type="button">Open in Excel online</button>'}<button class="btn ghost" id="reload" type="button">Refresh</button></div>
      <div class="row"><button class="chip" type="button" data-tab="people" aria-pressed="${tab === "people"}">People</button><button class="chip" type="button" data-tab="sheet" aria-pressed="${tab === "sheet"}">Spreadsheet view</button><button class="chip" type="button" data-tab="queue" aria-pressed="${tab === "queue"}">Review queue (${pending})</button>
      <label style="display:inline-flex;gap:6px;align-items:center;margin-left:8px"><input type="checkbox" id="all" style="width:auto" ${showAll ? "checked" : ""}> Include superseded and deleted</label></div>`;
    const asks = data.responses.filter(r => r.Status === "Submitted" && r["New check-in requested (UTC)"]);
    if (asks.length && me.role === "admin") h += `<div class="panel" style="margin:12px 0 0;border-left:4px solid #b45309"><h3 style="margin-top:0">New check-in requests waiting for approval (${asks.length})</h3>
      <p class="hint" style="margin-top:0">These people tried to submit again. Open each one and choose Approve a new check-in, or Mark as test entry if the earlier one was a trial.</p>
      <div class="tw"><table><tbody>${asks.map(r => `<tr class="click" tabindex="0" data-id="${esc(r["Submission ID"])}"><td>${esc(r.Name)}</td><td>${esc(r["Respondent ID (Employee ID)"])}</td><td>first check-in ${esc(String(r["Submitted at (UTC)"]).slice(0, 10))}</td><td>asked ${esc(r["New check-in requested (UTC)"])} UTC</td></tr>`).join("")}</tbody></table></div></div>`;
    if (!rows.length) h += '<p>No responses yet.</p>';
    else if (tab === "sheet") {
      const cols = Object.keys(rows[0]);
      h += `<div class="tw" style="margin-top:12px;max-height:70vh"><table class="sheet"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="hint">The same rows and columns as the Responses table in the Excel file.</p>`;
    } else if (tab === "queue") {
      const q = data.evidence.filter(e => !e["Reviewer decision"] && rows.some(r => r["Submission ID"] === e["Submission ID"]));
      h += q.length ? '<div style="margin-top:12px">' + q.map(evCard).join("") + "</div>" : "<p>Nothing waiting for review.</p>";
    } else {
      h += `<div class="tw" style="margin-top:12px"><table><thead><tr><th>Name</th><th>Employee ID</th><th>Team role</th><th>Status</th><th class="n">Score %</th><th class="n">Level</th><th>Tier</th><th class="n">To review</th></tr></thead><tbody>${rows.map(r => `<tr class="click" tabindex="0" data-id="${esc(r["Submission ID"])}"><td>${esc(r.Name)}<br><span class="hint">${esc(r.Department)}</span></td><td>${esc(r["Respondent ID (Employee ID)"])}</td><td>${esc(r["Team role"])}</td><td>${esc(r.Status)}</td><td class="n">${esc(r["Score %"])}</td><td class="n">${esc(r["Level score"])}</td><td>${esc(r["Provisional tier"])}</td><td class="n">${r.Examples ? esc(r["Examples to review"]) + " of " + esc(r.Examples) : ""}</td></tr>`).join("")}</tbody></table></div>`;
    }
    h += '</div><div id="detail"></div>';
    $("main").innerHTML = h;
    document.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
    $("all").onchange = e => { showAll = e.target.checked; render(); };
    $("reload").onclick = load;
    if ($("open")) $("open").onclick = async () => { const r = await fetch("/admin/api/file-link"); const j = await r.json(); if (j.webUrl) window.open(j.webUrl, "_blank", "noopener"); else alert(j.message || "No link available."); };
    document.querySelectorAll("tr.click").forEach(tr => { const go = () => { sel = tr.dataset.id; detail(); $("detail").scrollIntoView({ block: "start" }); }; tr.onclick = go; tr.onkeydown = e => { if (e.key === "Enter") go(); }; });
    bindReviews($("main"));
    if (tab === "people") detail();
  }

  function evCard(e) {
    const d = e["Reviewer decision"];
    return `<div class="ev"><strong>${esc(e.Name)}: ${esc(e["Question ID"])} ${esc(e["Use case"])}</strong> (Level ${esc(e.Level)}, answered ${esc(e.Answer)})<br>
      <em>Example:</em> ${esc(e.Example)}${e["Follow-up question"] ? `<br><em>Follow-up:</em> ${esc(e["Follow-up question"])}<br><em>Answer:</em> ${esc(e["Follow-up answer"] || "(skipped)")}` : ""}${e.Link ? `<br><em>Link:</em> <a href="${esc(e.Link)}" target="_blank" rel="noopener noreferrer">${esc(e.Link)}</a>` : ""}
      <br><em>AI review:</em> ${esc(e["AI rating"] || "none")}${e["AI reason"] ? ". " + esc(e["AI reason"]) : ""}
      <div class="revrow"><select data-sub="${esc(e["Submission ID"])}" data-q="${esc(e["Question ID"])}" aria-label="Reviewer decision"><option value="">Not reviewed</option>${["Accepted", "Needs more evidence", "Rejected"].map(o => `<option${d === o ? " selected" : ""}>${o}</option>`).join("")}</select>
      <input type="text" maxlength="500" placeholder="Reviewer notes" value="${esc(e["Reviewer notes"])}" aria-label="Reviewer notes">
      <button class="btn ghost" type="button" data-save>Save review</button><span class="hint">${d ? "Saved by " + esc(e["Reviewed by"]) + ", " + esc(e["Reviewed on (UTC)"]) : ""}</span></div></div>`;
  }

  function bindReviews(root) {
    root.querySelectorAll("[data-save]").forEach(b => b.onclick = async () => {
      const row = b.closest(".revrow"), s = row.querySelector("select"), n = row.querySelector("input");
      b.disabled = true; b.textContent = "Saving…";
      try { await post("/admin/api/review", { submissionId: s.dataset.sub, questionId: s.dataset.q, decision: s.value, notes: n.value }); await load(); }
      catch (e) { alert(e.message); b.disabled = false; b.textContent = "Save review"; }
    });
  }

  function detail() {
    const box = $("detail"); if (!box) return;
    const r = data.responses.find(x => x["Submission ID"] === sel);
    if (!r) { box.innerHTML = ""; return; }
    const answers = Object.keys(r).filter(k => /^[RC]\d\d$/.test(k)).map(k => `<td>${k}: <strong>${esc(r[k])}</strong></td>`);
    let h = `<div class="panel"><h2>${esc(r.Name)}</h2><p class="hint" style="margin-top:0">Employee ID ${esc(r["Respondent ID (Employee ID)"])}, ${esc(r.Email)}${r.Department ? ", " + esc(r.Department) : ""}<br>${esc(r["Team role"])}, ${esc(r.Role)} questionnaire. Score ${esc(r["Score %"])}%, Level ${esc(r["Current level"])} ${esc(r["Level name"])} (${esc(r["Level score"])}), ${esc(r["Provisional tier"])}. Submitted ${esc(String(r["Submitted at (UTC)"]).slice(0, 16).replace("T", " "))} UTC. Status: ${esc(r.Status)}.</p>`;
    h += `<h3>Result report</h3><div id="rlinkbox"><p class="hint">Loading…</p></div>`;
    const evs = evFor(sel);
    if (evs.length) h += "<h3>Evidence</h3>" + evs.map(evCard).join("");
    h += `<h3>Answers</h3><div class="tw"><table><tbody>${[0, 10, 20].map(i => `<tr>${answers.slice(i, i + 10).join("")}</tr>`).join("")}</tbody></table></div>`;
    if (me.role === "admin") {
      h += `<h3>Check-in status</h3><p class="hint" style="margin-top:0">${{
        Submitted: r["New check-in requested (UTC)"] ? `<strong>This person asked to send a new check-in (${esc(r["New check-in requested (UTC)"])} UTC).</strong> Approve it, or mark this one as a test entry if it was a trial.` : "Counts in the assessment. While it does, this person cannot send another check-in in this cycle.",
        Reopened: "You approved a new check-in. This one no longer counts; the person can submit again.",
        Test: "Marked as a test entry. It does not count, and the person can send their real check-in.",
        Deleted: "Deleted. It does not count, and the person can submit again."
      }[r.Status] || ""}${r["Status changed by"] ? ` <br>Changed to ${esc(r.Status)} by ${esc(r["Status changed by"])} on ${esc(r["Status changed on (UTC)"])} UTC.` : ""}</p><div class="row">`;
      if (r.Status === "Submitted") h += '<button class="btn" id="reopen" type="button">Approve a new check-in</button><button class="btn ghost" id="test" type="button">Mark as test entry</button><button class="btn ghost" id="del" type="button">Mark as deleted</button>';
      else h += '<button class="btn ghost" id="restore" type="button">Count this check-in again</button>';
      h += '<span class="hint">Admin only. The row always stays in the Excel file.</span></div>';
    }
    box.innerHTML = h + "</div>";
    bindReviews(box);
    // Report status and the personal link, for someone who lost theirs.
    (async () => {
      const lb = $("rlinkbox"); if (!lb) return;
      try {
        const res = await fetch(`/admin/api/result-link?id=${encodeURIComponent(sel)}`); const j = await res.json();
        if (!res.ok) throw new Error(j.message || "Could not load the result link.");
        lb.innerHTML = `<p style="margin:0 0 6px">${j.status === "ready" ? '<span class="yes">Ready</span>: the person sees their report at this link.' : "Waiting for the example review: the link shows a “being assessed” message until the report is ready."}</p>
          <p class="hint" style="margin:0 0 6px"><code id="rlinktext" style="word-break:break-all">${esc(j.link)}</code></p>
          <div class="row" style="margin-top:0"><button class="btn ghost" id="copyrlink" type="button">Copy result link</button><span class="hint" id="rlinkmsg" role="status"></span></div>`;
        $("copyrlink").onclick = async () => {
          try { await navigator.clipboard.writeText(j.link); $("rlinkmsg").textContent = "Copied. Send it to the person by Teams or email."; }
          catch (e) { const s = getSelection(), g = document.createRange(); g.selectNodeContents($("rlinktext")); s.removeAllRanges(); s.addRange(g); $("rlinkmsg").textContent = "Press Ctrl+C to copy."; }
        };
      } catch (e) { lb.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    })();
    const setStatus = async status => { try { await post("/admin/api/status", { submissionId: sel, status }); await load(); } catch (e) { alert(e.message); } };
    if ($("del")) $("del").onclick = () => { if (confirm(`Mark the response from ${r.Name} as deleted?`)) setStatus("Deleted"); };
    if ($("reopen")) $("reopen").onclick = () => { if (confirm(`Approve a new check-in for ${r.Name}? This check-in will stop counting and they can submit again.`)) setStatus("Reopened"); };
    if ($("test")) $("test").onclick = () => { if (confirm(`Mark the check-in from ${r.Name} as a test entry? It will stop counting and they can send their real check-in.`)) setStatus("Test"); };
    if ($("restore")) $("restore").onclick = () => setStatus("Submitted");
  }

  (async function init() {
    const r = await fetch("/admin/api/me");
    if (r.status === 401) return signInPage();
    me = await r.json();
    $("who").textContent = `${me.name} (${me.role})`;
    $("signout").hidden = false;
    load();
  })();
})();
