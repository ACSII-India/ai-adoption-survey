"use strict";
(function () {
  const KEY = "aiadopt-survey-v1";
  const L = Scoring.LETTERS;
  let cfg = null, bank = null, st = null, busy = false, keyPick = null;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const blank = () => ({ profile: { name: "", empId: "", email: "", teamRole: "" }, qset: "", answers: {}, evidence: {}, verifyToken: "", submitted: null });
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };
  const qs = () => Scoring.questionsFor(bank, st.qset);
  const scale = lv => Scoring.scaleFor(bank, lv);

  async function api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || "The request failed."); e.code = j.error; throw e; }
    return j;
  }

  function nextStep() {
    const p = st.profile;
    if (st.submitted) return { t: "done" };
    if (!p.name || !p.empId || !p.email) return { t: "profile" };
    if (cfg.requireEmailCode && !st.verifyToken) return { t: "verify" };
    if (!st.qset) return { t: "role" };
    for (const q of qs()) {
      const a = st.answers[q.id];
      if (!a) return { t: "q", q };
      if (Scoring.needsEvidence(q, a)) {
        const ev = st.evidence[q.id] || {};
        if (!ev.example) return { t: "ev-example", q };
        if (ev.followupQ && ev.followupA == null) return { t: "ev-followup", q };
        if (ev.link == null) return { t: "ev-link", q };
      }
    }
    return { t: "review" };
  }

  const bubble = (cls, html) => `<div class="msg ${cls}">${html}</div>`;
  const evAsk = q => `That is Level ${q.level} use. Tell me about one real example from the last three months: what you did, which AI tool you used, how you checked the output, and what it saved or improved.`;
  function qBubble(q, i, n) {
    return bubble("bot", `<span class="meta">Question ${i + 1} of ${n}, Level ${q.level} (${bank.levels[q.level - 1].name}), ${i < 20 ? "role-specific" : "cross-role"}</span><span class="qtext">${esc(q.text)}</span>`);
  }

  function render() {
    const p = st.profile, parts = [];
    parts.push(bubble("bot", `Hi! This check-in places you on the 7-level AI adoption scale for your role (${esc(cfg.cycle)}). It takes about 12 minutes: 30 multiple-choice questions, plus a short example whenever you claim advanced use (Level 5 and above).\n\nAnswer for what you do today, not what you plan to do. Do not paste customer data, credentials, or confidential content; describe it and add a link instead.`));
    if (p.name && p.empId && p.email) {
      parts.push(bubble("bot", "First, your details."));
      parts.push(bubble("me", `${esc(p.name)}\nEmployee ID: ${esc(p.empId)}\n${esc(p.email)}`));
    }
    if (st.qset) {
      parts.push(bubble("bot", "Which team role fits you best?"));
      parts.push(bubble("me", esc(p.teamRole)));
      parts.push(bubble("bot", `Thanks. You will answer the ${esc(bank.questionnaires[st.qset].name)} questions: 20 for the role and 10 shared across all roles.`));
      const list = qs();
      list.forEach((q, i) => {
        const a = st.answers[q.id]; if (!a) return;
        parts.push(qBubble(q, i, list.length));
        parts.push(bubble("me", `<span class="meta">${a}</span>${esc(scale(q.level)[L.indexOf(a)])}`));
        const ev = st.evidence[q.id];
        if (Scoring.needsEvidence(q, a) && ev) {
          parts.push(bubble("bot", evAsk(q)));
          if (ev.example) parts.push(bubble("me", esc(ev.example)));
          if (ev.followupQ) parts.push(bubble("bot", esc(ev.followupQ)));
          if (ev.followupA != null) parts.push(bubble("me", esc(ev.followupA || "(skipped)")));
          if (ev.rating) parts.push(bubble("bot", `<span class="meta">Evidence noted for your reviewer</span>${esc(ev.summary || "")}\n<span class="rating${ev.rating === "Strong" ? "" : " weak"}">${esc(ev.rating)}</span>`));
          if (ev.example && (!ev.followupQ || ev.followupA != null)) parts.push(bubble("bot", "Is there a link that shows it, such as a pull request, Jira ticket, Confluence page, or shared prompt? Optional."));
          if (ev.link != null) parts.push(bubble("me", ev.link ? esc(ev.link) : "No link"));
        }
      });
    }
    $("chat").innerHTML = parts.join("");
    renderInput();
    renderHeader();
  }

  function renderHeader() {
    const s = st.qset ? Scoring.score(bank, st.qset, st.answers, cfg) : null;
    const done = s ? s.answered : 0;
    $("prog").style.width = s ? (done / s.questionCount * 100) + "%" : "0%";
    // No running level here: the level is set by the assessment rules after submission.
    $("ladder").innerHTML = [1, 2, 3, 4, 5, 6, 7].map(k => `<span style="height:${8 + k * 3.7}px"></span>`).join("");
    $("ladderLbl").textContent = s ? (st.submitted ? "Submitted" : `${done} of ${s.questionCount} answered`) : "Not started";
  }

  const scrollEnd = () => requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));

  function undoLast() {
    const done = qs().filter(q => st.answers[q.id]); const last = done[done.length - 1];
    if (!last) return; delete st.answers[last.id]; delete st.evidence[last.id]; save(); render();
  }

  function renderInput() {
    const step = nextStep(), el = $("input");
    keyPick = null;
    if (busy) { el.innerHTML = '<div class="panel"><p class="thinking" style="margin:0">Working on it…</p></div>'; return; }
    const undoBtn = Object.keys(st.answers).length ? '<button class="btn ghost" id="undo" type="button">Change my last answer</button>' : "";

    if (step.t === "profile") {
      // No department field: group views take department, project team and BU
      // from the HR/org file by employee ID, so nothing is typed by hand.
      const domains = cfg.allowedEmailDomains.length ? ` (${cfg.allowedEmailDomains.map(d => "@" + d).join(" or ")})` : "";
      el.innerHTML = `<div class="panel"><div class="grid2f">
        <div><label class="f" for="nm">Name</label><input id="nm" autocomplete="name" maxlength="100"></div>
        <div><label class="f" for="eid">Employee ID</label><input id="eid" maxlength="40"></div>
        <div><label class="f" for="em">Work email${esc(domains)}</label><input id="em" type="email" autocomplete="email" maxlength="200"></div></div>
        <p class="err" id="perr" role="alert"></p><div class="row"><button class="btn" id="go" type="button">Continue</button></div></div>`;
      const p = st.profile; $("nm").value = p.name; $("eid").value = p.empId; $("em").value = p.email;
      $("go").onclick = () => {
        const v = { name: $("nm").value.trim(), empId: $("eid").value.trim(), email: $("em").value.trim().toLowerCase() };
        const dom = v.email.split("@")[1] || "";
        const bad = !v.name ? ["nm", "Enter your name."]
          : !/^[A-Za-z0-9._-]{2,40}$/.test(v.empId) ? ["eid", "Enter your employee ID (letters, digits, dot, dash, or underscore)."]
          : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? ["em", "Enter a valid email address."]
          : (cfg.allowedEmailDomains.length && !cfg.allowedEmailDomains.includes(dom)) ? ["em", "Use your work email address."] : null;
        if (bad) { $("perr").textContent = bad[1]; $(bad[0]).focus(); return; }
        if (v.email !== st.profile.email) st.verifyToken = "";
        Object.assign(st.profile, v); save(); render();
      };
      $("nm").focus(); return;
    }

    if (step.t === "verify") {
      el.innerHTML = `<div class="panel"><p style="margin:0 0 10px">To confirm it is you, we will email a 6-digit code to <strong>${esc(st.profile.email)}</strong>.</p>
        <div class="row" style="margin-top:0"><button class="btn" id="send" type="button">Email me a code</button><button class="btn ghost" id="edit" type="button">Change my details</button></div>
        <div id="codebox" hidden><label class="f" for="code" style="margin-top:12px">Code</label><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"><div class="row"><button class="btn" id="check" type="button">Confirm</button></div></div>
        <p class="err" id="verr" role="alert"></p></div>`;
      $("edit").onclick = () => { st.profile.empId = ""; save(); render(); };
      $("send").onclick = async () => {
        $("send").disabled = true; $("verr").textContent = "";
        try { await api("/api/verify/start", { email: st.profile.email }); $("codebox").hidden = false; $("send").textContent = "Send again"; $("code").focus(); }
        catch (e) { $("verr").textContent = e.message; }
        $("send").disabled = false;
      };
      $("check").onclick = async () => {
        try { const r = await api("/api/verify/check", { email: st.profile.email, code: $("code").value.trim() }); st.verifyToken = r.token; save(); render(); }
        catch (e) { $("verr").textContent = e.message; }
      };
      return;
    }

    if (step.t === "role") {
      el.innerHTML = `<div class="panel"><p style="margin:0 0 10px">Choose your team role.</p><div class="chips">${bank.roleMap.map((r, i) => `<button class="chip" type="button" data-i="${i}">${esc(r.teamRole)}</button>`).join("")}</div></div>`;
      el.querySelectorAll(".chip").forEach(b => b.onclick = () => { const r = bank.roleMap[+b.dataset.i]; st.profile.teamRole = r.teamRole; st.qset = r.questionnaire; save(); render(); });
      return;
    }

    if (step.t === "q") {
      const list = qs(), i = list.indexOf(step.q);
      $("chat").insertAdjacentHTML("beforeend", qBubble(step.q, i, list.length));
      el.innerHTML = `<div class="panel"><div class="opts">${scale(step.q.level).map((o, k) => `<button class="opt" type="button" data-k="${k}"><b>${L[k]}</b><span>${esc(o)}</span></button>`).join("")}</div><div class="row">${undoBtn}<span class="hint">Tip: press A to E on your keyboard.</span></div></div>`;
      const pick = k => {
        const a = L[k]; st.answers[step.q.id] = a;
        if (Scoring.needsEvidence(step.q, a)) st.evidence[step.q.id] = st.evidence[step.q.id] || {}; else delete st.evidence[step.q.id];
        save(); render(); scrollEnd();
      };
      el.querySelectorAll(".opt").forEach(b => b.onclick = () => pick(+b.dataset.k));
      keyPick = pick;
      if ($("undo")) $("undo").onclick = undoLast;
      scrollEnd(); return;
    }

    if (step.t === "ev-example" || step.t === "ev-followup") {
      const isF = step.t === "ev-followup";
      el.innerHTML = `<div class="panel"><label class="f" for="ex">${isF ? "Your answer" : "Your example"}</label><textarea id="ex" maxlength="${isF ? 1000 : 2000}"${isF ? "" : ' placeholder="For example: I gave Devin the ticket to add input validation across 6 endpoints, reviewed the PR, fixed one test, and it took 1 hour instead of a day."'}></textarea><p class="hint">Describe it; do not paste confidential content.</p><p class="err" id="xerr" role="alert"></p><div class="row"><button class="btn" id="sendx" type="button">Send</button>${isF ? '<button class="btn ghost" id="skip" type="button">Skip this</button>' : '<button class="btn ghost" id="lower" type="button">I do not have an example; change my answer</button>'}</div></div>`;
      $("ex").focus();
      $("sendx").onclick = () => { const t = $("ex").value.trim(); if (t.length < 15) { $("xerr").textContent = "Add a little more detail."; $("ex").focus(); return; } reviewStep(step.q, t, isF); };
      if (isF) $("skip").onclick = () => reviewStep(step.q, "", true);
      else $("lower").onclick = () => { delete st.answers[step.q.id]; delete st.evidence[step.q.id]; save(); render(); };
      scrollEnd(); return;
    }

    if (step.t === "ev-link") {
      el.innerHTML = '<div class="panel"><label class="f" for="ln">Link (optional)</label><input type="url" id="ln" placeholder="https://" maxlength="500"><p class="err" id="lerr" role="alert"></p><div class="row"><button class="btn" id="add" type="button">Add link</button><button class="btn ghost" id="nol" type="button">No link</button></div></div>';
      $("add").onclick = () => { const v = $("ln").value.trim(); if (!/^https?:\/\/\S+$/i.test(v)) { $("lerr").textContent = "Enter a link that starts with https://"; $("ln").focus(); return; } st.evidence[step.q.id].link = v; save(); render(); };
      $("nol").onclick = () => { st.evidence[step.q.id].link = ""; save(); render(); };
      scrollEnd(); return;
    }

    if (step.t === "review") { el.innerHTML = reviewHTML(); bindReview(); scrollEnd(); return; }
    if (step.t === "done") { renderDone(el); scrollEnd(); return; }
  }

  async function reviewStep(q, text, isFollowup) {
    const ev = st.evidence[q.id];
    if (isFollowup) ev.followupA = text; else { ev.example = text; delete ev.followupQ; delete ev.followupA; }
    busy = true; save(); render();
    let r = null;
    try { r = await api("/api/review", { qset: st.qset, questionId: q.id, answer: st.answers[q.id], example: ev.example, followupQ: ev.followupQ || "", followupA: ev.followupA || "", final: isFollowup }); }
    catch (e) { r = null; }
    busy = false;
    if (r && r.available && !r.complete && r.followup && !isFollowup) { ev.followupQ = r.followup; }
    else if (r && r.available && r.complete) { Object.assign(ev, { rating: r.rating, summary: r.summary, reason: r.reason, signature: r.signature }); }
    else if (!isFollowup) { ev.followupQ = "Thanks. What did you check in the AI output before using it, and what did it save you in time, effort, or quality?"; }
    else { Object.assign(ev, { rating: "Not assessed", summary: "Automatic review was not available; a reviewer will read this example." }); delete ev.signature; }
    save(); render();
  }

  // Before submitting: no level is shown here; the result comes from the
  // assessment rules on the server after submission.
  function reviewHTML() {
    const n = qs().length, ex = Object.keys(st.evidence).length;
    return `<div class="panel"><h2>Review and submit</h2><p style="margin:0 0 10px">You have answered all ${n} questions${ex ? ` and given ${ex} example${ex > 1 ? "s" : ""}` : ""}. Submit to see your result.</p>
      <p class="err" id="serr" role="alert"></p><div class="row"><button class="btn" id="submit" type="button">Submit my check-in</button><button class="btn ghost" id="undo" type="button">Change my last answer</button></div></div>`;
  }

  /* ---------- result report (built on the server with the assessment rules) ---------- */
  let pollTimer = null;
  const resultLink = (id, r) => `${location.origin}/?result=${encodeURIComponent(id)}.${encodeURIComponent(r)}`;

  async function fetchResult(id, r) {
    const res = await fetch(`/api/result?id=${encodeURIComponent(id)}&r=${encodeURIComponent(r)}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || "Your result could not be loaded. Try again later.");
    return j;
  }

  function linkRow(id, r) {
    return `<p style="margin:14px 0 4px"><b>Save this link now</b> (bookmark it, or copy it into a note or email to yourself). It opens your result from any browser, even after you close this page or clear your browser data.</p>
      <p class="hint" style="margin:0"><code id="rlink" style="word-break:break-all">${esc(resultLink(id, r))}</code></p>
      <div class="row"><button class="btn ghost" id="copylink" type="button">Copy link</button></div><p class="hint" id="cmsg" role="status"></p>`;
  }
  function bindLink(id, r) {
    if ($("copylink")) $("copylink").onclick = async () => {
      try { await navigator.clipboard.writeText(resultLink(id, r)); $("cmsg").textContent = "Link copied."; }
      catch (e) { const s = window.getSelection(), g = document.createRange(); g.selectNodeContents($("rlink")); s.removeAllRanges(); s.addRange(g); $("cmsg").textContent = "Press Ctrl+C to copy the selected link."; }
    };
  }

  // Short summary shown above the full report.
  function summaryHTML(s) {
    if (!s) return "";
    const list = a => a.map(esc).join(", ").replace(/, ([^,]*)$/, " or $1");
    return `<div style="background:var(--soft,#eef3fb);border-radius:8px;padding:12px 14px;margin:8px 0 4px"><div style="font-size:20px;font-weight:700">Level ${s.level} – ${esc(s.levelName)} <span style="font-size:14px;font-weight:400">· score ${Number(s.score).toFixed(1)} of 7</span></div>` +
      (s.next ? `<div style="margin-top:6px"><b>Next: Level ${s.next.level} – ${esc(s.next.name)}.</b> ${s.next.have.length ? `You have ${s.next.have.map(esc).join(", ")}. ` : ""}Complete at least ${s.next.stillNeeded} of: ${list(s.next.from)}.</div>` : `<div style="margin-top:6px">You have reached the top level.</div>`) + "</div>";
  }

  function showReport(el, html, { ready, id, r, summary }) {
    clearInterval(pollTimer);
    el.innerHTML = `<div class="panel">${ready ? '<p class="yes" style="font-weight:600;margin:0 0 8px" role="status">Your report is ready.</p>' : ""}
      <h2>Your AI adoption result</h2>
      ${summaryHTML(summary)}
      <div class="row" style="margin-top:0"><button class="btn" id="pdf" type="button">Download PDF</button>${cfg.allowResubmit && st.submitted ? '<button class="btn ghost" id="again" type="button">Start a new check-in</button>' : ""}</div>
      <iframe id="rep" title="Your AI adoption result" style="width:100%;min-height:900px;border:1px solid var(--rule,#d9dee5);border-radius:8px;margin-top:12px;background:#fff"></iframe>
      ${linkRow(id, r)}</div>`;
    const f = $("rep");
    f.onload = () => { try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 24) + "px"; } catch (e) {} };
    f.srcdoc = html;
    // "Download PDF" opens the browser print dialog for the report; choose "Save as PDF".
    $("pdf").onclick = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) {} };
    bindLink(id, r);
    if ($("again")) $("again").onclick = () => { if (confirm("Start a new check-in? Your submitted one stays on record.")) { const p = st.profile; st = blank(); st.profile = Object.assign(p, { teamRole: "" }); save(); render(); } };
  }

  function showPending(el, { id, r }) {
    el.innerHTML = `<div class="panel"><h2>Your check-in is submitted</h2>
      <p style="margin:0 0 10px">Thank you. Your Level 5–7 examples are being assessed and reviewed.</p>
      <p style="margin:0 0 10px"><b>Come back to this page later to see your detailed report.</b> When it is ready, this page shows <b>“Your report is ready”</b> with your report and a PDF to download.</p>
      <div class="row"><button class="btn" id="check" type="button">Check now</button></div><p class="hint" id="pmsg" role="status"></p>
      ${linkRow(id, r)}</div>`;
    $("check").onclick = () => checkResult(el, id, r, true);
    bindLink(id, r);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => checkResult(el, id, r, false), 120000);
  }

  function showWithdrawn(el) {
    clearInterval(pollTimer);
    el.innerHTML = `<div class="panel"><h2>This check-in was withdrawn</h2>
      <p style="margin:0">The survey owner withdrew this check-in (for example a test entry, or replaced by a newer check-in), so it has no report. If you sent a new check-in, open the link you saved with that one. <a href="/">Start a new check-in</a>.</p></div>`;
  }

  async function checkResult(el, id, r, manual) {
    try {
      const j = await fetchResult(id, r);
      if (j.status === "ready" && j.html) showReport(el, j.html, { ready: true, id, r, summary: j.summary });
      else if (j.status === "withdrawn") showWithdrawn(el);
      else if (manual && $("pmsg")) $("pmsg").textContent = "Not ready yet. Please check again later.";
    } catch (e) { if (manual && $("pmsg")) $("pmsg").textContent = e.message; }
  }

  function renderDone(el) {
    const sub = st.submitted, id = sub.submissionId, r = sub.receipt;
    if (sub.report && !sub.report.pending && sub.report.html) return showReport(el, sub.report.html, { ready: false, id, r });
    showPending(el, { id, r });
    checkResult(el, id, r, false);
  }

  function bindReview() {
    if ($("undo")) $("undo").onclick = undoLast;
    if ($("submit")) $("submit").onclick = async () => {
      $("submit").disabled = true; $("serr").textContent = "";
      const evidence = {};
      Object.entries(st.evidence).forEach(([k, v]) => { evidence[k] = { example: v.example, followupQ: v.followupQ || "", followupA: v.followupA || "", link: v.link || "", rating: v.rating || "", summary: v.summary || "", reason: v.reason || "", signature: v.signature || "" }; });
      try {
        const r = await api("/api/submit", { profile: st.profile, answers: st.answers, evidence, verifyToken: st.verifyToken });
        st.submitted = r; save(); render();
      } catch (e) { $("serr").textContent = e.message; $("submit").disabled = false; if (e.code === "verify_required") { st.verifyToken = ""; save(); render(); } }
    };
  }

  document.addEventListener("keydown", e => {
    if (!keyPick || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = "abcde".indexOf(e.key.toLowerCase()); if (k >= 0) { e.preventDefault(); keyPick(k); }
  });

  (async function init() {
    try {
      const r = await fetch("/api/config"); cfg = await r.json(); bank = cfg.bank;
      $("sub").textContent = cfg.cycle + " self-assessment";
    } catch (e) { $("input").innerHTML = '<p class="err">The check-in could not load. Reload the page to try again.</p>'; return; }
    // Personal result link: /?result=<submission ID>.<receipt>
    const link = new URLSearchParams(location.search).get("result") || "";
    if (link.includes(".")) {
      const id = link.slice(0, link.indexOf(".")), r = link.slice(link.indexOf(".") + 1);
      st = blank(); $("chat").innerHTML = ""; renderHeader(); $("ladderLbl").textContent = "Your result";
      const el = $("input");
      el.innerHTML = '<div class="panel"><p class="thinking" style="margin:0">Loading your result…</p></div>';
      try {
        const j = await fetchResult(id, r);
        if (j.status === "ready" && j.html) showReport(el, j.html, { ready: true, id, r, summary: j.summary });
        else if (j.status === "withdrawn") showWithdrawn(el);
        else showPending(el, { id, r });
      } catch (e) { el.innerHTML = `<div class="panel"><p class="err" style="margin:0">${esc(e.message)}</p></div>`; }
      return;
    }
    try { st = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { st = blank(); }
    if (st.qset && !bank.questionnaires[st.qset]) { st.qset = ""; st.answers = {}; st.evidence = {}; }
    render();
  })();
})();
