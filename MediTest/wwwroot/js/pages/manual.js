async function loadDocs() {
  const [docs, license] = await Promise.all([api("/api/documents"), api("/api/license/status")]);
  if (license.restrictedMode) {
    document.getElementById("manualForm").classList.add("hidden");
    status(
      document.getElementById("msg"),
      "Neue manuelle Fragen sind nach der Testphase im Monatsabo verfügbar. Vorhandene Tests kannst du weiterhin ausführen.",
      "status",
    );
    return;
  }
  const sel = document.getElementById("documentId");
  docs.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = `${d.fileName} (${d.questionCount} Fragen)`;
    sel.appendChild(o);
  });
}

document.getElementById("imageFile").addEventListener("change", async (e) => {
  const preview = document.getElementById("imagePreview");
  preview.classList.add("hidden");
  preview.innerHTML = "";
  try {
    const image = await readImageFileAsDataUrl(e.target);
    if (!image) return;
    preview.innerHTML = `<img src="${esc(image.imageDataUrl)}" alt="${esc(document.getElementById("imageAltText").value || "Fragebild")}"><figcaption>${esc(image.imageFileName)}</figcaption>`;
    preview.classList.remove("hidden");
  } catch (err) {
    status(document.getElementById("msg"), err.message, "status error");
    e.target.value = "";
  }
});

document.getElementById("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  status(msg, "Speichere Frage...");
  try {
    const image = await readImageFileAsDataUrl(document.getElementById("imageFile"));
    const payload = {
      documentId: document.getElementById("documentId").value
        ? Number(document.getElementById("documentId").value)
        : null,
      documentName: document.getElementById("documentName").value.trim() || null,
      questionText: document.getElementById("questionText").value.trim(),
      options: [0, 1, 2, 3, 4].map((i) => document.getElementById(`option${i}`).value.trim()),
      correctOptionIndex: Number(document.getElementById("correctOptionIndex").value),
      explanation: document.getElementById("explanation").value.trim(),
      topic: document.getElementById("topic").value.trim(),
      difficulty: document.getElementById("difficulty").value,
      imageDataUrl: image?.imageDataUrl || null,
      imageFileName: image?.imageFileName || null,
      imageAltText: document.getElementById("imageAltText").value.trim(),
    };
    const r = await api("/api/questions/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    status(
      msg,
      `Frage gespeichert in „${r.documentName}“. Insgesamt ${r.totalQuestions} Fragen.`,
      "status success",
    );
    e.target.reset();
    document.getElementById("imagePreview").classList.add("hidden");
    document.getElementById("imagePreview").innerHTML = "";
  } catch (err) {
    status(msg, err.message, "status error");
  }
});
loadDocs().catch(() => {});
