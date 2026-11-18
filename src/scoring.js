/*
 * Scoring rules shared by the server and the browser. They mirror the
 * baseline workbook: a question is met at score >= metScore (D or E),
 * a level is met when at least `threshold` of its questions are met,
 * and levels are cumulative (Level 1 is the floor).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LETTERS = ["A", "B", "C", "D", "E"];
  const TIERS = [[6, "Champion"], [5, "Power User"], [3, "Active"], [1, "Emerging"]];

  function questionsFor(bank, qset) {
    const q = bank.questionnaires[qset];
    if (!q) return [];
    return q.questions.concat(bank.cross);
  }

  function scaleFor(bank, level) {
    return bank.scales[String(level)];
  }

  function needsEvidence(question, answer) {
    return question.level >= 5 && (answer === "D" || answer === "E");
  }

  function score(bank, qset, answers, opts) {
    const threshold = (opts && opts.threshold) || 0.6;
    const metScore = (opts && opts.metScore) || 3;
    const qs = questionsFor(bank, qset);
    const value = q => (answers[q.id] ? LETTERS.indexOf(answers[q.id]) : 0);
    const total = qs.reduce((a, q) => a + Math.max(0, value(q)), 0);
    const perLevel = [1, 2, 3, 4, 5, 6, 7].map(k => {
      const lq = qs.filter(q => q.level === k);
      const met = lq.filter(q => value(q) >= metScore).length;
      return { level: k, questions: lq.length, met, pct: lq.length ? met / lq.length : 0 };
    });
    let cumulative = 0;
    for (const p of perLevel) { if (p.pct >= threshold) cumulative = p.level; else break; }
    const level = Math.max(1, cumulative);
    const levelScore = cumulative === 0 ? 1 : cumulative === 7 ? 7 : cumulative + perLevel[cumulative].pct;
    const tier = TIERS.find(t => level >= t[0])[1];
    const answered = qs.filter(q => answers[q.id]).length;
    const next = cumulative < 7 ? cumulative + 1 : null;
    const gaps = next ? qs.filter(q => q.level === next && value(q) < metScore).map(q => q.useCase) : [];
    return {
      total, max: qs.length * 4, pct: qs.length ? total / (qs.length * 4) : 0,
      perLevel, cumulative, level, levelName: bank.levels[level - 1].name,
      levelScore: Math.round(levelScore * 10) / 10, tier, answered, questionCount: qs.length,
      nextLevel: next, gaps
    };
  }

  return { LETTERS, questionsFor, scaleFor, needsEvidence, score };
});
