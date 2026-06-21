function imageHtml(q) {
  if (!q.imageDataUrl) return "";
  return `<figure class="question-image"><img src="${esc(q.imageDataUrl)}" alt="${esc(q.imageAltText || "Fragebild")}">${q.imageFileName ? `<figcaption>${esc(q.imageFileName)}</figcaption>` : ""}</figure>`;
}
async function load() {
  const id = qs("id");
  const r = await api(`/api/tests/${id}/review`);
  document.getElementById("summary").innerHTML =
    `<h1>Auswertung</h1><div class="score">${r.score}/${r.questionCount} · ${r.percent}%</div><p class="${r.passed ? "success" : "error"} status">${r.passed ? "Bestanden" : "Nicht bestanden"} · Grenze: 60%</p><h2>Fehlerschwerpunkte</h2>${r.topicErrors.length ? r.topicErrors.map((t) => `<p><b>${esc(t.topic)}</b>: ${t.errors}/${t.total} falsch</p>`).join("") : '<p class="muted">Keine Fehlerschwerpunkte - stark!</p>'}<div class="actions"><a class="button primary" href="/pages/tests.html">Tests anzeigen</a></div>`;
  document.getElementById("review").innerHTML = r.questions
    .map(
      (q, idx) =>
        `<article class="card review-item ${q.isCorrect ? "correct" : "wrong"}"><p class="muted">Frage ${idx + 1} · ${esc(q.topic)} · ${esc(q.difficulty)}${q.isAiGenerated ? ' <span class="badge ai-badge">KI</span>' : ""}</p><h2>${esc(q.questionText)}</h2>${imageHtml(q)}<p><b>Deine Antwort:</b> ${esc(q.selectedAnswer ?? "Keine Antwort")}</p><p><b>Richtig:</b> ${esc(q.correctAnswer)}</p><p><b>Erklärung:</b> ${esc(q.explanation)}</p></article>`,
    )
    .join("");
  enhanceTooltips();
}
load().catch((e) => {
  document.getElementById("msg").className = "status error";
  document.getElementById("msg").textContent = e.message;
});
