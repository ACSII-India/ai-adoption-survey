"use strict";
// Renders one person's assessment report as a one-page, email-ready HTML
// (inline styles, tables only, so it survives Outlook). Used by report.js.
// Quotes behind each example check stay in the Excel report for reviewers;
// the email gives the result, what is missing, and how to fix it.

const { rules, CRITERIA_LABELS } = require("./lib.js");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const C = { ink: "#1b1f24", muted: "#5b6470", rule: "#d9dee5", brand: "#1f3864", ok: "#1a7f37", warn: "#9a6700", no: "#b42318", soft: "#f4f6f9", hi: "#e8eff9" };
const LEVEL_LINE = {
  0: "You do not have access to the approved AI tools yet.",
  1: "You have access to the approved AI tools and know the usage policy.",
  2: "You use AI at least a few times a month for simple tasks.",
  3: "You use AI every week in the core tasks of your role.",
  4: "You use AI every week in the complex, end-to-end work of your role.",
  5: "You delegate work to AI agents and connect AI to tools and data, and your examples show it.",
  6: "Colleagues use what you have built with AI, or you coach them, and your examples show it.",
  7: "You have redesigned a process around AI with measured results, and your examples show it."
};
const LEVEL_MEANS = {
  1: "Has access, knows the policy", 2: "Uses AI a few times a month for simple tasks", 3: "Weekly in core tasks",
  4: "Weekly in complex work", 5: "Agents, tools and data (proven)", 6: "Others use what you built (proven)", 7: "Process redesigned, measured (proven)"
};
const cell = (s, extra = "") => `<td style="padding:5px 7px;border-bottom:1px solid ${C.rule};vertical-align:top;${extra}">${s}</td>`;
const head = (s, extra = "") => `<th style="padding:5px 7px;text-align:left;background:${C.soft};border-bottom:1px solid ${C.rule};font-weight:600;${extra}">${s}</th>`;
const tbl = inner => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:12.5px;margin:4px 0 2px">${inner}</table>`;
const h2 = s => `<h2 style="font-size:15px;color:${C.brand};margin:12px 0 3px">${s}</h2>`;
// Bold list joined with commas and a final "and" / "or" (names may contain commas).
const names = (items, conj = "or") => {
  const b = items.map(s => `<b>${esc(s)}</b>`);
  return b.length <= 1 ? b.join("") : `${b.slice(0, -1).join(", ")} ${conj} ${b[b.length - 1]}`;
};
const missingNames = (p) => (p.decision ? p.decision.missing : []).map(c => CRITERIA_LABELS[c].toLowerCase().replace(/\bai\b/g, "AI"));

function statusShort(p) {
  if (p.confirmed) return `<span style="color:${C.ok}">In place</span> · ${esc(p.needsProof ? "example shows it" : p.answerText)}`;
  if (p.claimed && p.needsProof) {
    const d = p.decision ? p.decision.decision : "Not assessed";
    if (d === "Not assessed") return `Answered ${p.answer}; example not assessed yet`;
    if (p.judgement && p.judgement.qualityRejected) return `Answered ${p.answer}; example too short or unclear`;
    return `Answered ${p.answer}; example missing: ${esc(missingNames(p).join(", "))}`;
  }
  return `Now: ${esc(p.answerText)}`;
}

function fixShort(p) {
  if (p.confirmed) return `<span style="color:${C.muted}">—</span>`;
  if (p.claimed && p.needsProof) {
    if (p.judgement && p.judgement.improve) return esc(p.judgement.improve);
    return `Describe ${esc(missingNames(p).join(", ") || "a real example")}.`;
  }
  return `Reach “${esc(p.barText)}”${p.needsProof ? ", with an example" : ""}`;
}

function renderIndividual(person, result, { cycle, contact, trend }) {
  const { conf, self, nextLevel, aboveNext, practices } = result;
  const lv = conf.level, name = rules.levelNames[lv];

  // 1. Result
  const differ = self.level !== conf.level;
  const top = `
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:${C.hi}"><tr>
<td style="padding:12px 14px">
  <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em">Your level</div>
  <div style="font-size:22px;font-weight:700;color:${C.brand};margin:1px 0">Level ${lv} – ${esc(name)}</div>
  <div style="font-size:13px">${esc(LEVEL_LINE[lv])}</div>
  ${trend ? `<div style="font-size:12.5px;margin-top:4px"><b>Since ${esc(trend.cycle)}:</b> Level ${trend.prevLevel} → Level ${lv} ${trend.change > 0 ? `<span style="color:${C.ok}">▲ up ${trend.change}</span>` : trend.change < 0 ? `<span style="color:${C.no}">▼ down ${-trend.change}</span>` : `<span style="color:${C.muted}">no change</span>`} · score ${Number(trend.prevScore).toFixed(1)} → ${result.conf.score.toFixed(1)}</div>` : ""}
  ${differ ? `<div style="font-size:12px;color:${C.muted};margin-top:4px">From your answers alone you would be Level ${self.level}. Levels 5–7 count only when an example shows the practice.</div>` : ""}
</td>
<td style="padding:12px 14px;text-align:right;white-space:nowrap;vertical-align:top">
  <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em">Score</div>
  <div style="font-size:22px;font-weight:700;color:${C.brand}">${conf.score.toFixed(1)}<span style="font-size:13px;color:${C.muted};font-weight:400"> / 7</span></div>
</td></tr></table>`;

  // 2. Ladder, one row per measure, one column per level
  const per = conf.per;
  const colStyle = p => (nextLevel && p.level === nextLevel.level ? `background:${C.hi};` : "") + "text-align:center;";
  const statusOf = p => p.level <= lv ? `<span style="color:${C.ok}">✅</span>` : nextLevel && p.level === nextLevel.level ? `<span style="color:${C.warn}">Next</span>` : `<span style="color:${C.muted}">–</span>`;
  const ladder = h2("Where you stand") + tbl(
    `<tr>${head("Level")}${per.map(p => head(`${p.level} ${esc(rules.levelNames[p.level])}<div style="font-weight:400;color:${C.muted};font-size:10.5px">${esc(LEVEL_MEANS[p.level])}</div>`, colStyle(p) + "vertical-align:top")).join("")}</tr>
     <tr>${cell("<b>Needed</b>")}${per.map(p => cell(`${p.needed} of ${p.total}`, colStyle(p))).join("")}</tr>
     <tr>${cell("<b>You have</b>")}${per.map(p => cell(`${p.count}`, colStyle(p))).join("")}</tr>
     <tr>${cell("<b>Reached</b>")}${per.map(p => cell(statusOf(p), colStyle(p))).join("")}</tr>`) +
    `<div style="font-size:11.5px;color:${C.muted}">A level is reached when at least half of its practices are in place and every level below it is reached.</div>`;

  // 3. Next level
  let next;
  if (!nextLevel) {
    next = h2("You have reached the top level") + `<div style="font-size:13px">Keep sharing what works so others can follow.</div>`;
  } else {
    const L = nextLevel;
    let lastFix = "";
    const rows = [...L.have, ...L.missing].map(p => {
      let fix = fixShort(p);
      if (!p.confirmed) { if (fix === lastFix) fix = "Same as above."; else lastFix = fix; }
      return `<tr>${cell(p.confirmed ? `<span style="color:${C.ok}">✅</span>` : "⬜", "width:18px")}${cell(`<b>${esc(p.useCase)}</b>`, "width:30%")}${cell(statusShort(p), "width:28%")}${cell(fix)}</tr>`;
    });
    const closest = L.missing[0];
    next = h2(`To reach Level ${L.level} – ${esc(L.name)}: at least ${L.needed} of these ${L.total}`) +
      tbl(`<tr>${head("")}${head("Practice")}${head("Your status")}${head("What would make it count")}</tr>${rows.join("")}`) +
      `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:6px;border-left:4px solid ${C.brand};background:${C.soft}"><tr><td style="padding:8px 12px;font-size:13px;line-height:1.45">
        <div><b>You have:</b> ${L.have.length ? names(L.have.map(p => p.useCase), "and") : "none of these yet"}.</div>
        <div><b>To qualify, also complete at least ${L.stillNeeded} of:</b> ${names(L.missing.map(p => p.useCase))}.</div>
        ${closest ? `<div style="color:${C.muted}"><b>Closest:</b> ${esc(closest.useCase)}${closest.claimed ? " – you already do this; your example needs to show it." : ` – you are at “${esc(closest.answerText)}”.`}</div>` : ""}
        ${aboveNext.length ? `<div style="color:${C.muted}"><b>Already in place higher up:</b> ${esc(aboveNext.map(p => `${p.useCase} (L${p.level})`).join(", "))}. These count once Level ${L.level} is reached.</div>` : ""}
      </td></tr></table>`;
  }

  // 4. Examples, one line each
  // Examples for next-level practices that did not pass are already explained
  // in the next-level table above, so they are not repeated here.
  const shownAbove = new Set(nextLevel ? nextLevel.missing.filter(p => p.claimed).map(p => p.id) : []);
  const evs = practices.filter(p => p.needsProof && p.claimed && !shownAbove.has(p.id)).sort((a, b) => a.level - b.level);
  const allEv = practices.filter(p => p.needsProof && p.claimed).length;
  let examples = "";
  if (evs.length) {
    let lastImprove = "";
    const rows = evs.map(p => {
      const d = p.decision ? p.decision.decision : "Not assessed";
      const j = p.judgement || {};
      const icon = d === "Meets" ? `<span style="color:${C.ok}">✅ Meets</span>` : d === "Needs more evidence" ? `<span style="color:${C.warn}">⚠️ Needs more</span>` : d === "Not assessed" ? "Not assessed" : `<span style="color:${C.no}">❌ Does not meet</span>`;
      // Repeated advice (e.g. one vague example pasted for many questions) is shown once.
      const improve = j.improve && j.improve === lastImprove ? "Same advice as above." : (j.improve || "");
      if (j.improve) lastImprove = j.improve;
      const text = d === "Meets" ? esc(j.reason || "")
        : j.qualityRejected ? "Too short or unclear to assess. Describe a real piece of work in a few sentences."
        : `${missingNames(p).length ? `<b>Missing:</b> ${esc(missingNames(p).join(", "))}. ` : ""}${esc(improve)}`;
      return `<tr>${cell(`<b>${esc(p.useCase)}</b> <span style="color:${C.muted}">L${p.level}</span>`, "width:30%")}${cell(icon, "width:15%;white-space:nowrap")}${cell(text)}</tr>`;
    });
    examples = h2("Your examples (Levels 5–7)") + tbl(rows.join("")) +
      `<div style="font-size:11.5px;color:${C.muted}">Each example needs all 4 points for its level. Level 5: a real task, AI doing the steps, how you checked the output, done regularly. Level 6: what you shared, who uses it, where it lives, what changed. Level 7: before and after, who adopted it, a measured result, owner or guardrails.</div>`;
  }

  const how = `<div style="font-size:11.5px;color:${C.muted};margin-top:14px;border-top:1px solid ${C.rule};padding-top:8px">
    Same rules for everyone: a practice counts at C or higher for Levels 1–2 and D or higher for Levels 3–7; Levels 5–7 also need an example that shows it. Score = your level plus the share of the next level already in place.${contact ? " If something is missing, tell the survey team and we will review it." : ""}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI adoption check-in result – ${esc(person.name)}</title>
<style>@page{size:A4;margin:10mm 11mm}@media print{body{zoom:${allEv > 10 ? ".66" : allEv > 7 ? ".74" : ".82"}}}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head>
<body style="margin:0;background:#ffffff;color:${C.ink};font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:760px;margin:0 auto;border-collapse:collapse"><tr><td style="padding:16px 14px">
<div style="font-size:12px;color:${C.muted}">AI adoption check-in · ${esc(cycle || person.cycle)}</div>
<div style="font-size:18px;font-weight:700;margin:2px 0 1px">${esc(person.name)}</div>
<div style="font-size:12.5px;color:${C.muted};margin-bottom:10px">${[person.teamRole, person.department].filter(Boolean).map(esc).join(" · ")}</div>
${top}${ladder}${next}${examples}${how}
</td></tr></table></body></html>`;
}

// Email body that goes with the PDF: the result, the main next step, one
// example to strengthen, and a pointer to the attachment. Returns { subject, html, text }.
function renderEmail(person, result, { cycle, trend, email }) {
  const { conf, nextLevel, practices } = result;
  const lv = conf.level, name = rules.levelNames[lv];
  const P = s => `<p style="margin:0 0 12px">${s}</p>`;
  const html = [], text = [];
  const add = (h, t) => { html.push(h); text.push(t); };
  const first = String(person.name).split(/\s+/)[0] && !/\d$/.test(person.name) ? String(person.name).split(/\s+/)[0] : person.name;
  const plainNames = (items, conj) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;

  add(P(`Hello ${esc(first)},`), `Hello ${first},`);
  add(P("Thank you for completing the AI adoption check-in. Your result is attached as a one-page PDF."),
    "Thank you for completing the AI adoption check-in. Your result is attached as a one-page PDF.");
  const trendLine = trend ? `Since ${trend.cycle}: Level ${trend.prevLevel} → Level ${lv} (${trend.change > 0 ? `up ${trend.change}` : trend.change < 0 ? `down ${-trend.change}` : "no change"}).` : "";
  add(P(`<b>Your level: Level ${lv} – ${esc(name)} (score ${conf.score.toFixed(1)} of 7)</b><br>${esc(LEVEL_LINE[lv])}${trendLine ? `<br>${esc(trendLine)}` : ""}`),
    `Your level: Level ${lv} – ${name} (score ${conf.score.toFixed(1)} of 7)\n${LEVEL_LINE[lv]}${trendLine ? "\n" + trendLine : ""}`);

  if (!nextLevel) {
    add(P("You have reached the top level. Keep sharing what works so others can follow."), "You have reached the top level. Keep sharing what works so others can follow.");
  } else {
    const L = nextLevel, closest = L.missing[0];
    const have = L.have.length ? plainNames(L.have.map(p => p.useCase), "and") : "none of these yet";
    const from = plainNames(L.missing.map(p => p.useCase), "or");
    const close = closest ? (closest.claimed ? `${closest.useCase}. You already do this; your example needs to show it.` : `${closest.useCase}. You are at "${closest.answerText}"; reach "${closest.barText}".`) : "";
    add(P(`<b>Your next step: Level ${L.level} – ${esc(L.name)}</b><br>You have: ${esc(have)}.<br>To qualify, also complete at least ${L.stillNeeded} of: ${esc(from)}.${close ? `<br>Closest: ${esc(close)}` : ""}`),
      `Your next step: Level ${L.level} – ${L.name}\nYou have: ${have}.\nTo qualify, also complete at least ${L.stillNeeded} of: ${from}.${close ? "\nClosest: " + close : ""}`);
  }

  // One example to strengthen: the one closest to passing.
  const weak = practices.filter(p => p.needsProof && p.claimed && p.decision && p.decision.decision !== "Meets" && p.judgement && p.judgement.improve && !p.judgement.qualityRejected)
    .sort((a, b) => (a.decision.missing.length - b.decision.missing.length) || (a.level - b.level))[0];
  if (weak) add(P(`<b>One example to strengthen:</b> ${esc(weak.useCase)}. ${esc(weak.judgement.improve)}`), `One example to strengthen: ${weak.useCase}. ${weak.judgement.improve}`);

  add(P("The attached report shows where you stand on every level and how your examples were assessed."), "The attached report shows where you stand on every level and how your examples were assessed.");
  add(P("If you think something is missing or wrong, reply to this email with more detail and we will review it."), "If you think something is missing or wrong, reply to this email with more detail and we will review it.");
  const sig = [email.closing || "Regards,", email.senderName, ...(email.signatureLines || [])].filter(Boolean);
  add(P(sig.map(esc).join("<br>")), sig.join("\n"));

  return {
    subject: (email.subject || "Your AI adoption check-in result – {cycle}").replace("{cycle}", cycle),
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1b1f24">${html.join("\n")}</div>`,
    text: text.join("\n\n")
  };
}

// Short "your result is ready" notice with the personal link (the report
// itself stays on the survey page). Returns { subject, html, text }.
function renderNotice(person, { cycle, link, email, level }) {
  const first = !/\d$/.test(person.name) ? String(person.name).split(/\s+/)[0] : person.name;
  const sig = [email.closing || "Regards,", email.senderName, ...(email.signatureLines || [])].filter(Boolean);
  const lines = [
    `Hello ${first},`,
    `Your AI adoption check-in result for ${cycle} is ready.`,
    `Open your result: ${link}`,
    "The page shows your level, where you stand on each level, what would take you to the next one, and a PDF you can download. Keep this email: the link works from any browser.",
    "If you think something is missing, tell the survey team and we will review it."
  ];
  const P = s => `<p style="margin:0 0 12px">${s}</p>`;
  const html = [P(esc(lines[0])), P(esc(lines[1])),
    P(`<a href="${esc(link)}" style="display:inline-block;background:#1f3864;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600">Open my result</a>`),
    P(`<span style="font-size:12px;color:#5b6470">Or copy this link: ${esc(link)}</span>`), P(esc(lines[3])), P(esc(lines[4])), P(sig.map(esc).join("<br>"))].join("\n");
  return {
    subject: `Your AI adoption check-in result is ready – ${cycle}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1b1f24">${html}</div>`,
    text: [...lines, sig.join("\n")].join("\n\n"), level
  };
}

module.exports = { renderIndividual, renderEmail, renderNotice };
