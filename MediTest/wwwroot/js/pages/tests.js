let testsCache = [];
let testsRestrictedMode = false;
function testActions(t) {
  if (testsRestrictedMode) {
    return t.submittedAt
      ? `<a class="button" href="/pages/review.html?id=${t.testSessionId}">Auswertung öffnen</a>`
      : `<a class="button primary" href="/pages/test.html?id=${t.testSessionId}">Test fortsetzen</a>`;
  }
  const rename = `<button type="button" onclick="renameTest(${t.testSessionId})">Umbenennen</button>`;
  const pdf = `<button type="button" onclick="downloadTestPdf(${t.testSessionId})">PDF herunterladen</button>`;
  if (t.submittedAt)
    return `<a class="button" href="/pages/review.html?id=${t.testSessionId}">Auswertung öffnen</a>${rename}${pdf}`;
  return `<a class="button primary" href="/pages/test.html?id=${t.testSessionId}">Test fortsetzen</a>${rename}<button class="danger" type="button" onclick="deleteOpenTest(${t.testSessionId})">Löschen</button>`;
}
async function downloadTestPdf(id) {
  try {
    await downloadApiFile(`/api/tests/${id}/pdf`, `${APP_BRAND.productName}-${id}.pdf`);
  } catch (e) {
    status(document.getElementById("msg"), e.message, "status error");
  }
}
async function renameTest(id) {
  const msg = document.getElementById("msg");
  const currentName = testsCache.find((t) => t.testSessionId === id)?.testName || "";
  const name = prompt("Neuer Testname", currentName || "");
  if (name === null) return;
  const testName = name.trim();
  if (!testName) {
    status(msg, "Bitte gib einen Testnamen ein.", "status error");
    return;
  }
  try {
    await api(`/api/tests/${id}/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testName }),
    });
    status(msg, "Test umbenannt.", "status success");
    await load();
  } catch (e) {
    status(msg, e.message, "status error");
  }
}
async function deleteOpenTest(id) {
  const msg = document.getElementById("msg");
  const current = testsCache.find((t) => t.testSessionId === id);
  if (!current || current.submittedAt) return;
  if (
    !confirm(
      `Angefangenen Test "${current.testName}" wirklich löschen?\n\nAbgeschlossene Tests und Fragenpools bleiben erhalten.`,
    )
  )
    return;
  try {
    await api(`/api/tests/${id}`, { method: "DELETE" });
    status(msg, "Angefangener Test gelöscht.", "status success");
    await load();
  } catch (e) {
    status(msg, e.message, "status error");
  }
}
function testStatus(t) {
  if (t.submittedAt)
    return `Ergebnis: <b>${t.score}/${t.questionCount}</b> (${t.percent}%) · <b class="${t.passed ? "success" : "error"}">${t.passed ? "Bestanden" : "Nicht bestanden"}</b>`;
  return `<span class="badge">Offen</span> Noch nicht abgegeben`;
}
async function loadRestrictedTestSources() {
  const panel = document.getElementById("restrictedTestStarter");
  const select = document.getElementById("restrictedTestSource");
  panel.classList.remove("hidden");
  const sources = await api("/api/tests/sources");
  select.innerHTML = sources.length
    ? sources
        .map(
          (source) =>
            `<option value="${source.documentId}" data-count="${source.questionCount}">${esc(source.documentName)} (${source.questionCount} Fragen)</option>`,
        )
        .join("")
    : '<option value="">Keine vorhandenen Fragenpools</option>';
  select.disabled = !sources.length;
  document.querySelector('#restrictedTestForm button[type="submit"]').disabled = !sources.length;
  const syncMax = () => {
    const available = Number(select.selectedOptions[0]?.dataset.count) || 100;
    const input = document.getElementById("restrictedTestCount");
    input.max = String(Math.min(100, available));
    input.value = String(Math.min(Number(input.value) || 25, available));
  };
  select.addEventListener("change", syncMax);
  if (sources.length) syncMax();
}
document.getElementById("restrictedTestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = document.getElementById("restrictedTestMsg");
  const documentId = Number(document.getElementById("restrictedTestSource").value);
  const questionCount = Number(document.getElementById("restrictedTestCount").value);
  const testName = document.getElementById("restrictedTestName").value.trim() || null;
  status(msg, "Test wird zusammengestellt...");
  try {
    const test = await api("/api/tests/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, questionCount, testName }),
    });
    sessionStorage.setItem("currentTest", JSON.stringify(test));
    location.href = `/pages/test.html?id=${test.testSessionId}`;
  } catch (e) {
    status(msg, e.message, "status error");
  }
});
async function load() {
  const box = document.getElementById("list");
  const [items, license] = await Promise.all([api("/api/tests"), api("/api/license/status")]);
  testsRestrictedMode = license.restrictedMode === true;
  if (testsRestrictedMode) await loadRestrictedTestSources();
  testsCache = items;
  if (!items.length) {
    box.innerHTML = '<p class="muted">Noch keine Tests.</p>';
    return;
  }
  box.innerHTML = items
    .map(
      (t) =>
        `<article class="card"><p class="muted title-wrap">${new Date(t.startedAt).toLocaleString()} · Dokument: ${esc(t.documentName)}</p><h2 class="title-wrap">${esc(t.testName)} <span class="muted">(#${t.testSessionId})</span></h2><p>${testStatus(t)}</p><div class="actions">${testActions(t)}</div></article>`,
    )
    .join("");
  enhanceTooltips();
}
load().catch((e) => status(document.getElementById("msg"), e.message, "status error"));
