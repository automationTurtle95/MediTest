let test = null;
let i = 0;
const answers = {};
let draftTimer = null;

function answerPayload() {
  return {
    answers: test.questions.map((q) => ({
      questionId: q.questionId,
      selectedAnswerOptionId: answers[q.questionId] ?? null,
    })),
  };
}
function syncLocal() {
  test.questions.forEach((q) => (q.selectedAnswerOptionId = answers[q.questionId] ?? null));
  sessionStorage.setItem("currentTest", JSON.stringify(test));
}
async function saveDraft(showStatus = false) {
  if (!test) return;
  syncLocal();
  try {
    const r = await api(`/api/tests/${test.testSessionId}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answerPayload()),
    });
    if (showStatus)
      status(
        document.getElementById("msg"),
        `Zwischenstand gespeichert: ${r.answered}/${r.total} beantwortet.`,
        "status success",
      );
  } catch (e) {
    if (showStatus) status(document.getElementById("msg"), e.message, "status error");
  }
}
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft(false), 350);
}

function render() {
  const q = test.questions[i];
  document.getElementById("counter").textContent = `Frage ${i + 1} von ${test.questions.length}`;
  document.getElementById("bar").style.width = `${((i + 1) / test.questions.length) * 100}%`;
  document.getElementById("question").textContent = q.questionText;
  const image = document.getElementById("questionImage");
  if (q.imageDataUrl) {
    image.innerHTML = `<img src="${esc(q.imageDataUrl)}" alt="${esc(q.imageAltText || "Fragebild")}">${q.imageFileName ? `<figcaption>${esc(q.imageFileName)}</figcaption>` : ""}`;
    image.classList.remove("hidden");
  } else {
    image.innerHTML = "";
    image.classList.add("hidden");
  }
  document.getElementById("topic").textContent = q.topic;
  document.getElementById("difficulty").textContent = q.difficulty;
  document.getElementById("aiBadge").classList.toggle("hidden", !q.isAiGenerated);
  document.getElementById("options").innerHTML = q.options
    .map(
      (o) =>
        `<label class="option"><input type="radio" name="answer" value="${o.answerOptionId}" ${answers[q.questionId] === o.answerOptionId ? "checked" : ""}>${esc(o.text)}</label>`,
    )
    .join("");
  document.querySelectorAll('input[name="answer"]').forEach((input) =>
    input.addEventListener("change", () => {
      save();
      scheduleDraft();
    }),
  );
  document.getElementById("prev").disabled = i === 0;
  document.getElementById("next").classList.toggle("hidden", i === test.questions.length - 1);
  document.getElementById("submit").classList.toggle("hidden", i !== test.questions.length - 1);
  enhanceTooltips();
}
function save() {
  const q = test.questions[i];
  const checked = document.querySelector('input[name="answer"]:checked');
  if (checked) answers[q.questionId] = Number(checked.value);
  syncLocal();
}
document.getElementById("prev").onclick = () => {
  save();
  saveDraft(false);
  if (i > 0) i--;
  render();
};
document.getElementById("next").onclick = () => {
  save();
  saveDraft(false);
  if (i < test.questions.length - 1) i++;
  render();
};
document.getElementById("submit").onclick = async () => {
  save();
  const msg = document.getElementById("msg");
  status(msg, "Speichere und werte aus...");
  try {
    await saveDraft(false);
    await api(`/api/tests/${test.testSessionId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answerPayload()),
    });
    sessionStorage.removeItem("currentTest");
    location.href = `/pages/review.html?id=${test.testSessionId}`;
  } catch (e) {
    status(msg, e.message, "status error");
  }
};
async function init() {
  const id = qs("id");
  const license = await api("/api/license/status").catch(() => null);
  if (license?.restrictedMode) document.getElementById("pdf").classList.add("hidden");
  const stored = JSON.parse(sessionStorage.getItem("currentTest") || "null");
  if (stored && (!id || String(stored.testSessionId) === String(id))) test = stored;
  else if (id) test = await api(`/api/tests/${id}/resume`);
  else location.href = "/pages/documents.html";
  test.questions.forEach((q) => {
    if (q.selectedAnswerOptionId) answers[q.questionId] = q.selectedAnswerOptionId;
  });
  document.getElementById("pdf").onclick = async (e) => {
    e.preventDefault();
    try {
      await downloadApiFile(
        `/api/tests/${test.testSessionId}/pdf`,
        `${APP_BRAND.productName}-${test.testSessionId}.pdf`,
      );
    } catch (err) {
      status(document.getElementById("msg"), err.message, "status error");
    }
  };
  syncLocal();
  render();
}
document.addEventListener("keydown", (e) => {
  if (!test) return;
  // Nicht auslösen wenn User in einem Eingabefeld tippt
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const key = e.key.toUpperCase();
  // A/B/C/D → Antwort wählen
  if (["A", "B", "C", "D"].includes(key)) {
    const idx = key.charCodeAt(0) - 65; // A=0, B=1, C=2, D=3
    const inputs = document.querySelectorAll('input[name="answer"]');
    if (inputs[idx]) {
      inputs[idx].checked = true;
      inputs[idx].dispatchEvent(new Event("change"));
    }
    return;
  }
  // Enter oder → → nächste Frage / abgeben
  if (e.key === "Enter" || e.key === "ArrowRight") {
    e.preventDefault();
    const next = document.getElementById("next");
    const submit = document.getElementById("submit");
    if (next && !next.classList.contains("hidden")) next.click();
    else if (submit && !submit.classList.contains("hidden")) submit.click();
    return;
  }
  // ← → vorherige Frage
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    const prev = document.getElementById("prev");
    if (prev && !prev.disabled) prev.click();
  }
});
init().catch((e) => status(document.getElementById("msg"), e.message, "status error"));
