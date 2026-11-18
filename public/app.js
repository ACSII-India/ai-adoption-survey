"use strict";
(function () {
  const KEY = "aiadopt-survey-v1";
  const L = Scoring.LETTERS;
  let cfg = null, bank = null, st = null, busy = false, keyPick = null;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const blank = () => ({ profile: { name: "", empId: "", email: "", dept: "", teamRole: "" }, qset: "", answers: {}, evidence: {}, verifyToken: "", submitted: null });
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
    if (!p.name || !p.empId || !p.email || !p.dept) return { t: "profile" };
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
    if (p.name && p.empId && p.email && p.dept) {
      parts.push(bubble("bot", "First, your details."));
      parts.push(bubble("me", `${esc(p.name)}\nEmployee ID: ${esc(p.empId)}\n${esc(p.email)}\n${esc(p.dept)}`));
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
    const lit = s && done ? s.cumulative : 0;
    $("ladder").innerHTML = [1, 2, 3, 4, 5, 6, 7].map(k => `<span class="${k <= lit ? "on" : ""}" style="height:${8 + k * 3.7}px"></span>`).join("");
    $("ladderLbl").textContent = s && done ? `Level ${s.level} so far` : "Level not yet set";
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
      const domains = cfg.allowedEmailDomains.length ? ` (${cfg.allowedEmailDomains.map(d => "@" + d).join(" or ")})` : "";
      el.innerHTML = `<div class="panel"><div class="grid2f">
        <div><label class="f" for="nm">Name</label><input id="nm" autocomplete="name" maxlength="100"></div>
        <div><label class="f" for="eid">Employee ID</label><input id="eid" maxlength="40"></div>
        <div><label class="f" for="em">Work email${esc(domains)}</label><input id="em" type="email" autocomplete="email" maxlength="200"></div>
        <div><label class="f" for="dp">Department</label><input id="dp" maxlength="80"></div></div>
        <p class="err" id="perr" role="alert"></p><div class="row"><button class="btn" id="go" type="button">Continue</button></div></div>`;
      const p = st.profile; $("nm").value = p.name; $("eid").value = p.empId; $("em").value = p.email; $("dp").value = p.dept;
      $("go").onclick = () => {
        const v = { name: $("nm").value.trim(), empId: $("eid").value.trim(), email: $("em").value.trim().toLowerCase(), dept: $("dp").value.trim() };
        const dom = v.email.split("@")[1] || "";
        const bad = !v.name ? ["nm", "Enter your name."]
          : !/^[A-Za-z0-9._-]{2,40}$/.test(v.empId) ? ["eid", "Enter your employee ID (letters, digits, dot, dash, or underscore)."]
          : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? ["em", "Enter a valid email address."]
          : (cfg.allowedEmailDomains.length && !cfg.allowedEmailDomains.includes(dom)) ? ["em", "Use your work email address."]
          : !v.dept ? ["dp", "Enter your department."] : null;
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

    if (step.t === "review") { el.innerHTML = resultsHTML(false); bindResults(); scrollEnd(); return; }
    if (step.t === "done") { el.innerHTML = resultsHTML(true); bindResults(); scrollEnd(); return; }
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

  function resultsHTML(done) {
    const sub = st.submitted;
    const s = done ? sub.result : Scoring.score(bank, st.qset, st.answers, cfg);
    let h = `<div class="panel"><h2>${done ? "Your check-in is submitted" : "Review and submit"}</h2>`;
    h += `<div class="kpis"><div class="kpi"><div class="big">${Math.round(s.pct * 1000) / 10}%</div>Overall score (${s.total} of ${s.max})</div><div class="kpi"><div class="big">Level ${s.level}</div>${esc(s.levelName)}, level score ${Number(s.levelScore).toFixed(1)}</div><div class="kpi"><div class="big">${esc(s.tier)}</div>Provisional tier</div></div>`;
    if (s.level >= 5) h += '<p class="hint">Level 5 and above stays provisional until a reviewer validates your examples.</p>';
    h += '<h3>Levels</h3><div class="tw"><table><thead><tr><th>Level</th><th class="n">Questions met</th><th class="n">Met %</th><th>Status</th></tr></thead><tbody>' +
      s.perLevel.map(p => `<tr><td>${p.level} ${esc(bank.levels[p.level - 1].name)}</td><td class="n">${p.met} of ${p.questions}</td><td class="n">${Math.round(p.pct * 100)}%</td><td>${p.level <= s.cumulative ? '<span class="yes">Met</span>' : p.pct >= cfg.threshold ? "Met, but a lower level is not" : "Not yet"}</td></tr>`).join("") + "</tbody></table></div>";
    if (s.gaps.length) h += `<h3>To reach Level ${s.nextLevel}, use these weekly or more</h3><ul class="gap">${s.gaps.map(g => `<li>${esc(g)}</li>`).join("")}</ul>`;
    if (done) {
      h += `<p class="hint">Submission ${esc(sub.submissionId)}. Thank you.</p><div class="row">${cfg.resultsEmailEnabled ? `<button class="btn" id="mail" type="button">Email my results to ${esc(st.profile.email)}</button>` : ""}<button class="btn ghost" id="copy" type="button">Copy my results</button>${cfg.allowResubmit ? '<button class="btn ghost" id="again" type="button">Start a new check-in</button>' : ""}</div><p class="hint" id="mmsg" role="status"></p>`;
    } else {
      h += `<p class="err" id="serr" role="alert"></p><div class="row"><button class="btn" id="submit" type="button">Submit my check-in</button><button class="btn ghost" id="undo" type="button">Change my last answer</button></div>`;
    }
    return h + "</div>";
  }

  function resultsText() {
    const s = st.submitted.result, p = st.profile;
    return ["AI adoption check-in results (" + cfg.cycle + ")", "", "Name: " + p.name, "Employee ID: " + p.empId, "Department: " + p.dept, "Team role: " + p.teamRole,
      "Overall score: " + Math.round(s.pct * 1000) / 10 + "% (" + s.total + " of " + s.max + ")", "Current level: Level " + s.level + " " + s.levelName + " (level score " + Number(s.levelScore).toFixed(1) + ")",
      "Provisional tier: " + s.tier, "Submission: " + st.submitted.submissionId].concat(s.gaps.length ? ["", "To reach Level " + s.nextLevel + ":"].concat(s.gaps.map(g => "- " + g)) : []).join("\n");
  }

  function bindResults() {
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
    if ($("mail")) $("mail").onclick = async () => {
      $("mail").disabled = true;
      try { const r = await api("/api/email-results", { submissionId: st.submitted.submissionId, receipt: st.submitted.receipt }); $("mmsg").textContent = "Sent to " + r.sentTo + "."; }
      catch (e) { $("mmsg").textContent = e.message; $("mail").disabled = false; }
    };
    if ($("copy")) $("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(resultsText()); $("copy").textContent = "Copied"; } catch (e) { $("copy").textContent = "Copy failed"; }
    };
    if ($("again")) $("again").onclick = () => { if (confirm("Start a new check-in? Your submitted one stays on record.")) { const p = st.profile; st = blank(); st.profile = Object.assign(p, { teamRole: "" }); save(); render(); } };
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
    try { st = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { st = blank(); }
    if (st.qset && !bank.questionnaires[st.qset]) { st.qset = ""; st.answers = {}; st.evidence = {}; }
    render();
  })();
})();
