      let currentData = null;
      let newQuestionIds = new Set();
      let questionsRestrictedMode = false;

      function optionLetter(i) {
        return String.fromCharCode(65 + i);
      }
      function parseNewQuestionIds() {
        return new Set(
          (qs("new") || "")
            .split(",")
            .map((x) => Number(x))
            .filter(Number.isInteger),
        );
      }
      function questionImageHtml(q) {
        if (!q.imageDataUrl) return "";
        return `<figure class="question-image"><img src="${esc(q.imageDataUrl)}" alt="${esc(q.imageAltText || "Fragebild")}">${q.imageFileName ? `<figcaption>${esc(q.imageFileName)}</figcaption>` : ""}</figure>`;
      }

      async function loadQuestions() {
        const id = qs("id");
        const topic = qs("topic");
        const msg = document.getElementById("msg");
        const box = document.getElementById("questions");
        newQuestionIds = parseNewQuestionIds();
        if (!id && !topic) {
          status(msg, "Dokument-ID oder Thema fehlt.", "status error");
          return;
        }
        const license = await api("/api/license/status").catch(() => null);
        questionsRestrictedMode = license?.restrictedMode === true;

        if (topic && !id) {
          currentData = await api(`/api/questions/by-topic?topic=${encodeURIComponent(topic)}`);
          document.getElementById("title").textContent = `Thema: ${currentData.topic}`;
          document.getElementById("subtitle").textContent = `${currentData.questionCount} Fragen aus allen Fragenpools`;
        } else {
          currentData = await api(`/api/documents/${id}/questions`);
          if (topic) {
            currentData.questions = currentData.questions.filter((q) => q.topic === topic);
            currentData.questionCount = currentData.questions.length;
            document.getElementById("title").textContent = `Thema: ${topic}`;
            document.getElementById("subtitle").textContent =
              `${currentData.questionCount} Fragen in ${currentData.documentName}`;
          } else if (newQuestionIds.size) {
            const newCount = currentData.questions.filter((q) => newQuestionIds.has(q.questionId)).length;
            currentData.questions.sort((a, b) => {
              const aNew = newQuestionIds.has(a.questionId);
              const bNew = newQuestionIds.has(b.questionId);
              if (aNew !== bNew) return aNew ? -1 : 1;
              return a.questionId - b.questionId;
            });
            document.getElementById("title").textContent = `Fragen: ${currentData.documentName}`;
            document.getElementById("subtitle").textContent =
              `${currentData.questionCount} Fragen im Pool · ${newCount} neue oben markiert`;
            showNewQuestionsNotice(msg, newCount);
          } else {
            document.getElementById("title").textContent = `Fragen: ${currentData.documentName}`;
            document.getElementById("subtitle").textContent = `${currentData.questionCount} Fragen im Pool`;
          }
        }

        if (!currentData.questions.length) {
          box.innerHTML = '<article class="card"><p class="muted">Noch keine Fragen vorhanden.</p></article>';
          return;
        }
        box.innerHTML = currentData.questions.map((q, i) => viewHtml(q, i)).join("");
        enhanceTooltips();
      }

      function showNewQuestionsNotice(msg, newCount) {
        const text =
          newCount > 0
            ? "Der gesamte Fragenpool wird angezeigt. Die neu generierten Fragen stehen oben."
            : "Der gesamte Fragenpool wird angezeigt. Die gerade generierten Fragen konnten nicht mehr eindeutig markiert werden.";
        status(msg, text, "status success");
      }

      function viewHtml(q, i) {
        const source = q.documentName ? ` · ${esc(q.documentName)}` : "";
        const isNew = newQuestionIds.has(q.questionId);
        const newBadge = isNew ? ' <span class="badge new-badge">Neu</span>' : "";
        const aiBadge = q.isAiGenerated ? ' <span class="badge ai-badge">KI</span>' : "";
        const options = [...(q.options || [])].sort((a, b) => a.optionIndex - b.optionIndex);
        return `<article class="card review-item ${isNew ? "new-question" : ""}" id="q-${q.questionId}">
    <p class="muted">Frage ${i + 1}${source} · ${esc(q.topic)} · ${esc(q.difficulty)}${newBadge}${aiBadge}</p>
    <h2>${esc(q.questionText)}</h2>
    ${questionImageHtml(q)}
    <ol class="answers">${options.map((o) => `<li class="${o.isCorrect ? "correct-answer" : ""}"><b>${optionLetter(o.optionIndex)}.</b> ${esc(o.text)}${o.isCorrect ? " <b>✓ richtig</b>" : ""}</li>`).join("")}</ol>
    <p><b>Erklärung:</b> ${esc(q.explanation)}</p>
    ${questionsRestrictedMode ? "" : `<div class="actions"><button type="button" onclick="editQuestion(${q.questionId})">Bearbeiten</button></div>`}
  </article>`;
      }

      function editQuestion(questionId) {
        const q = currentData.questions.find((x) => x.questionId === questionId);
        if (!q) return;
        const article = document.getElementById(`q-${questionId}`);
        const options = [...(q.options || [])].sort((a, b) => a.optionIndex - b.optionIndex);
        article.innerHTML = `<h2>Frage bearbeiten</h2>
    <label>Fragetext</label><textarea id="qt-${questionId}" rows="4">${esc(q.questionText)}</textarea>
    <label>Thema</label><input type="text" id="topic-${questionId}" value="${esc(q.topic)}">
    <label>Schwierigkeit</label><select id="diff-${questionId}"><option ${q.difficulty === "leicht" ? "selected" : ""}>leicht</option><option ${q.difficulty === "mittel" ? "selected" : ""}>mittel</option><option ${q.difficulty === "schwer" ? "selected" : ""}>schwer</option></select>
    <label>Bild austauschen</label><input id="img-${questionId}" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
    <p class="subtle">Leer lassen, um das vorhandene Bild zu behalten. Maximum: 600 KB.</p>
    ${q.imageDataUrl ? `<figure class="question-image"><img src="${esc(q.imageDataUrl)}" alt="${esc(q.imageAltText || "Fragebild")}"><figcaption>${esc(q.imageFileName || "Aktuelles Bild")}</figcaption></figure><label class="checkline"><input id="clear-img-${questionId}" type="checkbox"> Bild entfernen</label>` : ""}
    <label>Bildbeschreibung</label><input type="text" id="img-alt-${questionId}" value="${esc(q.imageAltText || "")}">
    <label>Antwortmöglichkeiten</label>
    ${options.map((o) => `<div class="option-edit"><label><input type="radio" name="correct-${questionId}" value="${o.optionIndex}" ${o.isCorrect ? "checked" : ""}> ${optionLetter(o.optionIndex)} ist richtig</label><input type="text" id="opt-${questionId}-${o.optionIndex}" value="${esc(o.text)}"></div>`).join("")}
    <label>Erklärung</label><textarea id="exp-${questionId}" rows="3">${esc(q.explanation)}</textarea>
    <div class="actions"><button class="primary" type="button" onclick="saveQuestion(${questionId})">Speichern</button><button type="button" onclick="loadQuestions()">Abbrechen</button></div>`;
        enhanceTooltips(article);
      }

      async function saveQuestion(questionId) {
        const msg = document.getElementById("msg");
        const correct = document.querySelector(`input[name="correct-${questionId}"]:checked`);
        status(msg, "Speichere Frage...");
        try {
          const image = await readImageFileAsDataUrl(document.getElementById(`img-${questionId}`));
          const payload = {
            questionText: document.getElementById(`qt-${questionId}`).value.trim(),
            topic: document.getElementById(`topic-${questionId}`).value.trim(),
            difficulty: document.getElementById(`diff-${questionId}`).value,
            explanation: document.getElementById(`exp-${questionId}`).value.trim(),
            correctOptionIndex: correct ? Number(correct.value) : 0,
            options: [0, 1, 2, 3, 4].map((i) => document.getElementById(`opt-${questionId}-${i}`).value.trim()),
            imageDataUrl: image?.imageDataUrl || null,
            imageFileName: image?.imageFileName || null,
            imageAltText: document.getElementById(`img-alt-${questionId}`).value.trim(),
            clearImage: document.getElementById(`clear-img-${questionId}`)?.checked || false,
          };
          await api(`/api/questions/${questionId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          status(msg, "Frage gespeichert.", "status success");
          await loadQuestions();
        } catch (e) {
          status(msg, e.message, "status error");
        }
      }

      loadQuestions().catch((e) => status(document.getElementById("msg"), e.message, "status error"));
