  function pct(v) {
    return `${Number(v || 0)
      .toFixed(1)
      .replace(".0", "")}%`;
  }

  function formatDate(v) {
    if (!v) return "";
    return new Date(v).toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function passColor(passed) {
    return passed ? "color:var(--ok)" : "color:var(--danger)";
  }

  let currentDailyGoal = 20;

  function toggleGoalEdit() {
    const row = document.getElementById("goalEditRow");
    row.classList.toggle("hidden");
    if (!row.classList.contains("hidden")) {
      document.getElementById("goalInput").value = currentDailyGoal;
      document.getElementById("goalInput").focus();
    }
  }

  async function saveGoal() {
    const val = parseInt(document.getElementById("goalInput").value, 10);
    if (isNaN(val) || val < 1 || val > 500) return;
    try {
      // Settings laden, DailyGoalQuestions updaten
      const settings = await api("/api/settings");
      await api("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settings,
          dailyGoalQuestions: val,
          openAiApiKey: null,
          clearOpenAiApiKey: false,
        }),
      });
      currentDailyGoal = val;
      document.getElementById("goalCount").textContent = val;
      document.getElementById("goalInput").value = val;
      updateGoalBar(parseInt(document.getElementById("todayCount").textContent, 10) || 0, val);
      document.getElementById("goalEditRow").classList.add("hidden");
    } catch (e) {
      alert("Fehler beim Speichern: " + e.message);
    }
  }

  function updateGoalBar(today, goal) {
    const pct = Math.min(100, Math.round((today / Math.max(1, goal)) * 100));
    document.getElementById("goalFill").style.width = pct + "%";
  }

  async function loadDashboard() {
    const [tests, stats, dashStats] = await Promise.all([
      api("/api/tests"),
      api("/api/stats/overview").catch(() => null),
      api("/api/dashboard/stats").catch(() => null),
    ]);

    // ── Streak & Lernziel ─────────────────────────────────────────
    if (dashStats) {
      currentDailyGoal = dashStats.dailyGoal || 20;
      const streak = dashStats.streak || 0;
      const today = dashStats.todayAnswered || 0;
      document.getElementById("streakCount").textContent = streak;
      document.getElementById("streakFlame").textContent = streak > 0 ? "🔥" : "❄️";
      document.getElementById("todayCount").textContent = today;
      document.getElementById("goalCount").textContent = currentDailyGoal;
      document.getElementById("goalInput").value = currentDailyGoal;
      updateGoalBar(today, currentDailyGoal);
      document.getElementById("streakCard").style.display = "";
    }

    // ── Offener Test ──────────────────────────────────────────────
    const openTest = tests.find((t) => !t.submittedAt);
    if (openTest) {
      document.getElementById("resumeBanner").classList.remove("hidden");
      document.getElementById("resumeTestName").textContent = openTest.testName || "Test fortsetzen";
      document.getElementById("resumeTestMeta").textContent =
        `${openTest.documentName} · gestartet ${formatDate(openTest.startedAt)}`;
      document.getElementById("resumeTestLink").href = `/pages/test.html?id=${openTest.testSessionId}`;
    }

    // ── Statistik-Kacheln ─────────────────────────────────────────
    if (stats) {
      document.getElementById("statTotal").textContent = stats.completedTests ?? "0";
      document.getElementById("statOpen").textContent = stats.openTests
        ? `${stats.openTests} offen`
        : "Alle abgeschlossen";
      document.getElementById("statAvg").textContent = pct(stats.averagePercent);
      document.getElementById("statPass").textContent = pct(stats.passRate);
      document.getElementById("statPassDetail").textContent =
        `${stats.passedTests ?? 0} bestanden · ${stats.failedTests ?? 0} nicht bestanden`;
      document.getElementById("statReadiness").textContent = pct(stats.readinessPercent);
      document.getElementById("statReadinessLabel").textContent = stats.readinessLabel ?? "";
    }

    // ── Letzte 5 Tests ────────────────────────────────────────────
    const done = tests.filter((t) => t.submittedAt).slice(0, 5);
    const recentBox = document.getElementById("recentTests");
    if (done.length) {
      recentBox.innerHTML = done
        .map(
          (t) => `
  <div class="recent-test">
    <div class="recent-test-info">
      <strong>${esc(t.testName)}</strong>
      <span class="muted">${esc(t.documentName)} · ${formatDate(t.submittedAt)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
      <span style="font-weight:900;${passColor(t.passed)}">${t.score}/${t.questionCount} (${t.percent}%)</span>
      <a class="button" href="/pages/review.html?id=${t.testSessionId}">Auswertung</a>
    </div>
  </div>
`,
        )
        .join("");
    }

    // ── Mini-Verlaufsdiagramm ─────────────────────────────────────
    const progressPoints = (stats?.progress ?? []).slice(-8);
    const progressBox = document.getElementById("progressChart");
    if (progressPoints.length) {
      const bars = progressPoints
        .map((p) => {
          const h = Math.max(6, Math.min(100, Number(p.percent) || 0));
          return `<a class="mini-bar" href="/pages/review.html?id=${p.testSessionId}"
    title="${esc(p.testName)} · ${pct(p.percent)}"
    style="height:${h}%"
  ></a>`;
        })
        .join("");
      progressBox.innerHTML = `
  <div class="mini-progress">${bars}</div>
  <p class="muted" style="margin-top:8px;font-size:13px">Letzte ${progressPoints.length} Tests · Klick öffnet Auswertung</p>
`;
    }
  }

  loadDashboard().catch((e) => {
    status(document.getElementById("msg"), e.message, "status error");
  });
