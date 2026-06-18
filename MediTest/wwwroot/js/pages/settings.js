      const profileFields = ["displayName", "matriculationNumber", "studyProgram", "university", "semester", "email"];
      let currentSettings = null;
      let savedSettingsSnapshot = "";
      let settingsSaving = false;
      let accountEmail = "";

      function setValue(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = value ?? "";
      }
      function editableSettings() {
        return Object.fromEntries(
          [...profileFields, "theme"].map((id) => [id, document.getElementById(id)?.value?.trim() ?? ""]),
        );
      }
      function updateSettingsState(message) {
        const dirty = JSON.stringify(editableSettings()) !== savedSettingsSnapshot;
        const state = document.getElementById("settingsState");
        const saveButton = document.getElementById("saveSettingsBtn");
        const reloadButton = document.getElementById("reloadBtn");
        state.textContent =
          message || (dirty ? "Ungespeicherte Änderungen vorhanden." : "Alle Änderungen sind gespeichert.");
        state.classList.toggle("settings-dirty", dirty);
        saveButton.disabled = settingsSaving || !dirty;
        reloadButton.disabled = settingsSaving || !dirty;
        saveButton.setAttribute("aria-busy", settingsSaving ? "true" : "false");
      }
      function readSettings() {
        return {
          displayName: document.getElementById("displayName").value.trim(),
          matriculationNumber: document.getElementById("matriculationNumber").value.trim(),
          studyProgram: document.getElementById("studyProgram").value.trim(),
          university: document.getElementById("university").value.trim(),
          semester: document.getElementById("semester").value.trim(),
          email: document.getElementById("email").value.trim(),
          theme: document.getElementById("theme").value,
          defaultGenerateQuestionCount: Number(currentSettings?.defaultGenerateQuestionCount) || 25,
          defaultTestQuestionCount: Number(currentSettings?.defaultTestQuestionCount) || 25,
          aiProvider: "firebase",
          aiModel: "gemini-2.5-flash",
          aiApiBaseUrl: "https://europe-west3-meditest-12354.cloudfunctions.net/meditestAi",
          openAiModel: "gemini-2.5-flash",
          openAiApiKey: null,
          clearOpenAiApiKey: true,
          allowLocalFallback: false,
        };
      }
      function render(settings) {
        currentSettings = settings;
        profileFields.forEach((id) => setValue(id, settings[id]));
        setValue("theme", settings.theme);
        applyTheme(settings.theme);
        savedSettingsSnapshot = JSON.stringify(editableSettings());
        updateSettingsState();
        enhanceTooltips();
      }
      async function loadAccountIdentity() {
        const user = await currentAuthUser(false);
        accountEmail = user?.email || "";
        if (accountEmail) setValue("email", accountEmail);
        const providerId = user?.providerId || "password";
        const socialProvider = providerId === "google.com" || providerId === "apple.com";
        document.getElementById("passwordForm").classList.toggle("hidden", socialProvider);
        document.getElementById("socialAuthNotice").classList.toggle("hidden", !socialProvider);
        document.getElementById("socialAuthText").textContent =
          providerId === "apple.com"
            ? "Dieses Konto verwendet die Anmeldung mit Apple."
            : "Dieses Konto verwendet die Anmeldung mit Google.";
        savedSettingsSnapshot = JSON.stringify(editableSettings());
        updateSettingsState();
      }
      function closeDeleteAccountModal() {
        document.getElementById("deleteAccountModal")?.remove();
      }
      function updateDeleteAccountButton() {
        const email = document.getElementById("deleteAccountEmail")?.value?.trim().toLowerCase() || "";
        const phrase = document.getElementById("deleteAccountPhrase")?.value?.trim() || "";
        const button = document.getElementById("confirmDeleteAccountBtn");
        if (button) button.disabled = email !== accountEmail.toLowerCase() || phrase !== "LÖSCHEN";
      }
      function openDeleteAccountModal() {
        if (document.getElementById("deleteAccountModal")) return;
        const modal = document.createElement("div");
        modal.id = "deleteAccountModal";
        modal.className = "modal-backdrop";
        modal.addEventListener("click", (event) => {
          if (event.target === modal) closeDeleteAccountModal();
        });
        modal.innerHTML = `
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="deleteAccountTitle">
      <p class="eyebrow">Endgültige Löschung</p>
      <h2 id="deleteAccountTitle">Konto und alle Daten löschen</h2>
      <p>Gib zur Bestätigung deine Konto-E-Mail und das Wort <strong>LÖSCHEN</strong> ein.</p>
      <label for="deleteAccountEmail">Konto-E-Mail</label>
      <input id="deleteAccountEmail" type="email" autocomplete="off" oninput="updateDeleteAccountButton()">
      <label for="deleteAccountPhrase">Bestätigung</label>
      <input type="text" id="deleteAccountPhrase" autocomplete="off" placeholder="LÖSCHEN" oninput="updateDeleteAccountButton()">
      <div id="deleteAccountStatus" class="hidden"></div>
      <div class="actions">
        <button type="button" onclick="closeDeleteAccountModal()">Abbrechen</button>
        <button class="danger" id="confirmDeleteAccountBtn" type="button" onclick="deleteAccount()" disabled>Konto endgültig löschen</button>
      </div>
    </section>`;
        document.body.appendChild(modal);
        enhanceTooltips(modal);
      }
      async function deleteAccount() {
        const msg = document.getElementById("deleteAccountStatus");
        const button = document.getElementById("confirmDeleteAccountBtn");
        button.disabled = true;
        status(msg, "Konto und Daten werden endgültig gelöscht...");
        try {
          await prepareFirebaseProviderAccountDeletion();
          const result = await api("/api/account", { method: "DELETE" });
          clearAuthSession();
          location.href = `/pages/login.html?accountDeleted=1&message=${encodeURIComponent(result.message || "Konto wurde gelöscht.")}`;
        } catch (error) {
          status(msg, error.message, "status error");
          updateDeleteAccountButton();
        }
      }
      function fileSizeLabel(bytes) {
        const value = Number(bytes) || 0;
        if (!value) return "";
        if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
        if (value >= 1024) return `${Math.round(value / 1024)} KB`;
        return `${value} B`;
      }
      function renderUpdateInfo(info) {
        const statusEl = document.getElementById("updateStatus");
        const metaEl = document.getElementById("updateMeta");
        const actionsEl = document.getElementById("updateActions");
        const checkButton = '<button type="button" id="checkUpdateBtn">Nach Updates suchen</button>';
        if (!info?.configured) {
          statusEl.textContent = "Update-Prüfung ist noch nicht mit GitHub verbunden.";
          metaEl.className = "subtle hidden";
          metaEl.textContent = "";
          actionsEl.innerHTML = checkButton;
          wireUpdateButton();
          return;
        }
        statusEl.textContent = info.message || "Update-Status konnte nicht gelesen werden.";
        metaEl.className = "subtle";
        metaEl.textContent = `Installiert: ${info.currentVersion || "-"} · Plattform: ${info.currentPlatform || "-"}`;
        const download = info.recommendedDownload;
        let actions = checkButton;
        if (info.updateAvailable && download?.url) {
          const size = fileSizeLabel(download.sizeBytes);
          actions += `<a class="button primary" href="${esc(download.url)}" target="_blank" rel="noopener">Update herunterladen${size ? ` · ${esc(size)}` : ""}</a>`;
        }
        if (info.releaseUrl) {
          actions += `<a class="button" href="${esc(info.releaseUrl)}" target="_blank" rel="noopener">GitHub Release</a>`;
        }
        actionsEl.innerHTML = actions;
        wireUpdateButton();
      }
      async function checkForUpdates() {
        const statusEl = document.getElementById("updateStatus");
        try {
          statusEl.textContent = "Prüfe GitHub auf Updates...";
          renderUpdateInfo(await api("/api/system/update"));
        } catch (err) {
          statusEl.textContent = err.message;
        }
      }
      function wireUpdateButton() {
        const btn = document.getElementById("checkUpdateBtn");
        if (btn) btn.onclick = checkForUpdates;
      }
      async function loadSettings() {
        const msg = document.getElementById("msg");
        try {
          const settings = await getAppSettings(true);
          render(settings);
          await loadAccountIdentity();
        } catch (e) {
          status(msg, e.message, "status error");
        }
      }
      document.getElementById("settingsForm").addEventListener("input", () => updateSettingsState());
      document.getElementById("settingsForm").addEventListener("change", () => updateSettingsState());
      document.getElementById("settingsForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = document.getElementById("msg");
        const saveButton = document.getElementById("saveSettingsBtn");
        let saveFailed = false;
        try {
          settingsSaving = true;
          saveButton.textContent = "Wird gespeichert...";
          updateSettingsState("Änderungen werden gespeichert...");
          status(msg, "Speichere Einstellungen...");
          const payload = readSettings();
          const saved = await api("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          sessionStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(saved));
          window.mediTestSettings = saved;
          render(saved);
          status(msg, "Einstellungen gespeichert.", "status success");
        } catch (err) {
          saveFailed = true;
          status(msg, err.message, "status error");
        } finally {
          settingsSaving = false;
          saveButton.textContent = "Änderungen speichern";
          updateSettingsState(saveFailed ? "Speichern fehlgeschlagen. Änderungen sind noch nicht gespeichert." : null);
        }
      });
      document.getElementById("passwordForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = document.getElementById("msg");
        try {
          status(msg, "Ändere Passwort...");
          const r = await changeFirebasePassword({
            currentPassword: document.getElementById("currentPassword").value,
            newPassword: document.getElementById("newPassword").value,
            confirmPassword: document.getElementById("confirmPassword").value,
          });
          document.getElementById("passwordForm").reset();
          status(msg, r.message, "status success");
        } catch (err) {
          status(msg, err.message, "status error");
        }
      });
      document.getElementById("reloadBtn").onclick = loadSettings;
      loadSettings();
      wireUpdateButton();
      checkForUpdates();
