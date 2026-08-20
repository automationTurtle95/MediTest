let allCards = []; // alle geladenen Karten (zum Neustart)
let queue = []; // aktuelle Lernrunde
let current = 0; // Index in queue
let correct = 0; // Gewusst-Zähler
let revealed = false; // Antwort bereits aufgedeckt?
let wrongIds = new Set(); // IDs der falsch beantworteten Karten

// ---- Karten laden ----
async function loadCards() {
  const params = new URLSearchParams(location.search);
  const docId = params.get("id");
  const weakMode = params.get("weak") === "1";

  if (docId) {
    // Dokument-Modus: alle Fragen eines Fragenpool-Dokuments
    const data = await api(`/api/documents/${docId}/questions`);
    allCards = buildCards(data.questions || []);
  } else if (weakMode) {
    // Schwache-Fragen-Modus: Stats laden → nach Dokument gruppieren → Fragen holen
    const stats = await api("/api/stats/overview");
    const weak = stats.weakQuestions || [];
    if (!weak.length) {
      showLoadError(
        'Keine schwachen Fragen gefunden. Mach mehr Tests, dann erscheinen sie hier automatisch.',
        '/pages/stats.html',
        'Zur Statistik',
      );
      return;
    }
    // Gruppiere weak-Question-IDs nach Dokument
    const byDoc = {};
    weak.forEach((wq) => {
      (byDoc[wq.documentId] = byDoc[wq.documentId] || []).push(wq.questionId);
    });
    const weakSet = new Set(weak.map((wq) => wq.questionId));
    // Lade Fragen parallel, filtere auf schwache IDs
    const results = await Promise.all(
      Object.keys(byDoc).map((did) =>
        api(`/api/documents/${did}/questions`)
          .then((d) => (d.questions || []).filter((q) => weakSet.has(q.questionId)))
          .catch(() => []),
      ),
    );
    allCards = buildCards(results.flat());
  } else {
    await showPicker();
    return;
  }

  if (!allCards.length) {
    showLoadError(
      'Dieser Fragenpool enthält noch keine Fragen.',
      '/pages/documents.html',
      'Zu den Dokumenten',
    );
    return;
  }

  startQueue(shuffle([...allCards]));
}

function showLoadError(message, href, linkLabel) {
  const card = document.getElementById('loadingCard');
  card.classList.remove('hidden');
  card.innerHTML = `<p class="muted">${esc(message)}</p><div class="actions"><a class="button" href="${esc(href)}">${esc(linkLabel)}</a></div>`;
}

async function showPicker() {
  document.getElementById('loadingCard').classList.add('hidden');
  document.getElementById('pickerCard').classList.remove('hidden');

  const [docs, stats] = await Promise.all([
    api('/api/documents').catch(() => []),
    api('/api/stats/overview').catch(() => null),
  ]);

  const weakCount = (stats?.weakQuestions || []).length;
  if (weakCount > 0) {
    document.getElementById('pickerWeakInfo').textContent = `${weakCount} Frage${weakCount === 1 ? '' : 'n'} unter 60 % Trefferquote`;
    document.getElementById('pickerWeakSection').classList.remove('hidden');
    document.getElementById('pickerWeakBtn').onclick = () => startWithMode('weak');
  }

  const learnDocs = (docs || []).filter((d) => Number(d.questionCount) > 0);
  const subtitle = document.getElementById('pickerSubtitle');
  if (learnDocs.length === 0) {
    subtitle.textContent = weakCount > 0 ? '' : 'Noch keine Fragen vorhanden.';
    document.getElementById('pickerEmpty').classList.remove('hidden');
  } else {
    subtitle.textContent = `${learnDocs.length} Fragenpool${learnDocs.length === 1 ? '' : 's'} verfügbar`;
    document.getElementById('pickerDocList').innerHTML = learnDocs
      .map(
        (d) => `<div class="pick-doc-row">
  <div>
    <div class="pick-doc-name">${esc(d.fileName)}</div>
    <div class="pick-doc-meta">${d.questionCount} Fragen</div>
  </div>
  <button type="button" onclick="startWithDoc('${esc(String(d.id))}')">Lernen</button>
</div>`,
      )
      .join('');
  }
}

async function startWithDoc(docId) {
  document.getElementById('pickerCard').classList.add('hidden');
  document.getElementById('loadingCard').classList.remove('hidden');
  document.getElementById('loadingCard').innerHTML = '<p class="muted">Karten werden geladen…</p>';
  try {
    const data = await api(`/api/documents/${docId}/questions`);
    allCards = buildCards(data.questions || []);
    if (!allCards.length) {
      showLoadError('Dieser Fragenpool enthält noch keine Fragen.', '/pages/documents.html', 'Zu den Dokumenten');
      return;
    }
    startQueue(shuffle([...allCards]));
  } catch (err) {
    showLoadError(err?.message || 'Fehler beim Laden.', '/pages/documents.html', 'Zu den Dokumenten');
  }
}

async function startWithMode(mode) {
  document.getElementById('pickerCard').classList.add('hidden');
  document.getElementById('loadingCard').classList.remove('hidden');
  document.getElementById('loadingCard').innerHTML = '<p class="muted">Schwache Fragen werden geladen…</p>';
  if (mode !== 'weak') return;
  try {
    const stats = await api('/api/stats/overview');
    const weak = stats.weakQuestions || [];
    if (!weak.length) {
      showLoadError(
        'Keine schwachen Fragen gefunden. Mach mehr Tests, dann erscheinen sie hier automatisch.',
        '/pages/stats.html',
        'Zur Statistik',
      );
      return;
    }
    const byDoc = {};
    weak.forEach((wq) => (byDoc[wq.documentId] = byDoc[wq.documentId] || []).push(wq.questionId));
    const weakSet = new Set(weak.map((wq) => wq.questionId));
    const results = await Promise.all(
      Object.keys(byDoc).map((did) =>
        api(`/api/documents/${did}/questions`)
          .then((d) => (d.questions || []).filter((q) => weakSet.has(q.questionId)))
          .catch(() => []),
      ),
    );
    allCards = buildCards(results.flat());
    if (!allCards.length) {
      showLoadError('Keine schwachen Fragen gefunden.', '/pages/stats.html', 'Zur Statistik');
      return;
    }
    startQueue(shuffle([...allCards]));
  } catch (err) {
    showLoadError(err?.message || 'Fehler beim Laden.', '/pages/stats.html', 'Zur Statistik');
  }
}

// ---- Karten aufbauen (normalisiert aus verschiedenen API-Antworten) ----
function buildCards(questions) {
  return (questions || [])
    .filter((q) => q.options && q.options.length >= 2)
    .map((q) => ({
      id: q.questionId,
      text: q.questionText,
      topic: q.topic || 'Allgemein',
      difficulty: q.difficulty || 'mittel',
      isAiGenerated: !!q.isAiGenerated,
      explanation: q.explanation || 'Keine Erklärung hinterlegt.',
      ...(() => {
        const sorted = (q.options || [])
          .slice()
          .sort((a, b) => (a.optionIndex ?? 0) - (b.optionIndex ?? 0))
          .map((o) => o.text);
        const correctText = sorted[q.correctOptionIndex ?? 0];
        const shuffled = shuffle([...sorted]);
        return {
          correctIndex: shuffled.indexOf(correctText) >= 0 ? shuffled.indexOf(correctText) : 0,
          options: shuffled,
        };
      })(),
      imageDataUrl: q.imageDataUrl || null,
      imageAltText: q.imageAltText || null,
      imageFileName: q.imageFileName || null,
    }));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Lernrunde starten ----
function startQueue(cards) {
  queue = cards;
  current = 0;
  correct = 0;
  wrongIds.clear();
  document.getElementById('loadingCard').classList.add('hidden');
  document.getElementById('doneCard').classList.add('hidden');
  document.getElementById('learnCard').classList.remove('hidden');
  renderCard();
}

// ---- Karte rendern ----
function renderCard() {
  revealed = false;
  const card = queue[current];
  const labels = ['A', 'B', 'C', 'D', 'E'];

  // Fortschritt
  const progress = ((current + 1) / queue.length) * 100;
  document.getElementById('bar').style.width = `${progress}%`;
  document.getElementById('counter').textContent = `${current + 1} / ${queue.length}`;

  // Metadaten
  document.getElementById('topic').textContent = card.topic;
  document.getElementById('difficulty').textContent = card.difficulty;
  document.getElementById('aiBadge').classList.toggle('hidden', !card.isAiGenerated);

  // Fragetext
  document.getElementById('questionText').textContent = card.text;

  // Bild
  const img = document.getElementById('questionImage');
  if (card.imageDataUrl) {
    img.innerHTML = `<img src="${esc(card.imageDataUrl)}" alt="${esc(card.imageAltText || 'Fragebild')}">${card.imageFileName ? `<figcaption>${esc(card.imageFileName)}</figcaption>` : ''}`;
    img.classList.remove('hidden');
  } else {
    img.innerHTML = '';
    img.classList.add('hidden');
  }

  // Antwortoptionen – neutral (noch nicht aufgedeckt)
  document.getElementById('optionsArea').innerHTML = card.options
    .map(
      (text, i) =>
        `<div class="learn-option" id="opt-${i}"><span class="learn-option-label">${labels[i] || String.fromCharCode(65 + i)}</span><span>${esc(text)}</span></div>`,
    )
    .join('');

  // Erklärung ausblenden
  document.getElementById('explanationArea').classList.add('hidden');
  document.getElementById('explanationText').textContent = '';

  // Buttons: Aufdecken anzeigen, Bewerten ausblenden
  document.getElementById('revealActions').classList.remove('hidden');
  document.getElementById('ratingActions').classList.add('hidden');
  document.getElementById('kbdReveal').classList.remove('hidden');
  document.getElementById('kbdRate').classList.add('hidden');

  document.getElementById('revealBtn').focus();
  enhanceTooltips();
}

// ---- Antwort aufdecken ----
function reveal() {
  if (revealed) return;
  revealed = true;
  const card = queue[current];

  // Richtige Antwort grün markieren
  const correctEl = document.getElementById(`opt-${card.correctIndex}`);
  if (correctEl) correctEl.classList.add('learn-option--correct');

  // Erklärung zeigen
  document.getElementById('explanationText').textContent = card.explanation;
  document.getElementById('explanationArea').classList.remove('hidden');

  // Buttons tauschen
  document.getElementById('revealActions').classList.add('hidden');
  document.getElementById('ratingActions').classList.remove('hidden');
  document.getElementById('kbdReveal').classList.add('hidden');
  document.getElementById('kbdRate').classList.remove('hidden');

  document.getElementById('rightBtn').focus();
}

// ---- Karte bewerten ----
function rate(knew) {
  if (!revealed) return;
  const card = queue[current];
  if (knew) {
    correct++;
    wrongIds.delete(card.id);
  } else {
    wrongIds.add(card.id);
  }
  current++;
  if (current >= queue.length) {
    showDone();
  } else {
    renderCard();
  }
}

// ---- Ergebnis-Bildschirm ----
function showDone() {
  document.getElementById('learnCard').classList.add('hidden');
  const done = document.getElementById('doneCard');
  done.classList.remove('hidden');

  const total = queue.length;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  document.getElementById('resultScore').textContent = `${correct} / ${total}`;
  document.getElementById('resultLabel').textContent =
    pct >= 90
      ? 'Ausgezeichnet! Alles sitzt.'
      : pct >= 70
        ? 'Gut! Noch ein paar wiederholen.'
        : pct >= 50
          ? 'Solide Grundlage – übe die falsch beantworteten Karten.'
          : 'Übe die Karten noch einmal, du schaffst das.';

  // Balken mit kurzer Verzögerung für Animation
  setTimeout(() => {
    document.getElementById('resultFill').style.width = `${pct}%`;
  }, 50);

  // "Falsche wiederholen"-Button nur zeigen wenn es falsche gibt
  const repeatBtn = document.getElementById('repeatWrongBtn');
  if (wrongIds.size > 0) {
    repeatBtn.textContent = `Falsche Karten wiederholen (${wrongIds.size})`;
    repeatBtn.classList.remove('hidden');
  } else {
    repeatBtn.classList.add('hidden');
  }
}

function restartAll() {
  startQueue(shuffle([...allCards]));
}

// ---- Lernmodus verlassen ----
function exitLearn() {
  const params = new URLSearchParams(location.search);
  const hasParams = params.get('id') || params.get('weak');
  if (!hasParams) {
    // Über Picker gestartet → zurück zum Picker
    document.getElementById('learnCard').classList.add('hidden');
    showPicker();
  } else {
    // Über URL-Parameter gestartet → Picker-Ansicht
    location.href = '/pages/learn.html';
  }
}

// ---- Event-Listener ----
document.getElementById('revealBtn').onclick = reveal;
document.getElementById('rightBtn').onclick = () => rate(true);
document.getElementById('wrongBtn').onclick = () => rate(false);
document.getElementById('repeatWrongBtn').onclick = function () {
  const wrong = allCards.filter((c) => wrongIds.has(c.id));
  if (!wrong.length) return;
  startQueue(shuffle(wrong));
};

// Tastaturkürzel
document.addEventListener('keydown', (e) => {
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (!document.getElementById('learnCard').classList.contains('hidden')) {
    if (!revealed) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        reveal();
      }
    } else {
      if (e.key === 'j' || e.key === 'J' || e.key === 'y' || e.key === 'Y' || e.key === 'ArrowRight') {
        e.preventDefault();
        rate(true);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        rate(false);
      }
    }
  }
});

loadCards().catch((err) => {
  const card = document.getElementById('loadingCard');
  card.classList.remove('hidden');
  card.innerHTML = `<p class="muted">Fehler beim Laden: ${esc(err?.message || 'Unbekannter Fehler')}</p><div class="actions"><a class="button" href="/index.html">Zum Dashboard</a></div>`;
});
